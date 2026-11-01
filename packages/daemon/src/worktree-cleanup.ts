/**
 * Worktree cleanup utilities.
 *
 * Provides best-effort cleanup of git worktrees after PR merges and a periodic
 * sweep for stale worktrees whose branches have already been merged or deleted.
 *
 * All functions are designed to fail silently — cleanup should never break
 * the merge handler, PR cron, or daemon lifecycle.
 *
 * ## The live-agent shield: `.lf-agent-active`
 *
 * A worktree whose root contains a file named `.lf-agent-active` is NEVER
 * removed by any path in this module, and no alert is raised for it — it is
 * deliberately held, not stale-but-unsafe. Drop the file in a worktree root to
 * pin it; delete the file to release it.
 *
 * The marker is honored regardless of git ignore state: it is checked with
 * `stat`, not `git status`. (It had to be said, because it used to be a
 * convention with nothing behind it — the marker "worked" only as an accident
 * of #30's untracked-file check, so one ignore line anywhere disarmed the
 * whole fleet's shield. See `has_live_agent_marker`.)
 */

import { execFile, execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expand_home } from "@lobster-farm/shared";
import type { AlertRouter } from "./alert-router.js";
import type { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";
import { sq } from "./shell.js";

const exec = promisify(execFile);

/** Timeout for git commands — generous but bounded. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Refs whose first-parent history counts as "trunk" (issue #110).
 *
 * Both forms are checked and unioned: a worktree is typically created from
 * `origin/main`, which can be ahead of the local `main` ref (or behind it, if
 * someone committed locally). Taking the union means a branch sitting on
 * *either* lineage is recognized as having done no work of its own.
 */
const TRUNK_REFS = [
  "refs/remotes/origin/main",
  "refs/heads/main",
  // This repo carries a live `upstream` remote; a worktree branched off
  // `upstream/main` while it is ahead of both refs above must still be
  // recognized as having done no work of its own. Unresolvable refs are
  // skipped individually, so this is a no-op in repos without an upstream.
  "refs/remotes/upstream/main",
] as const;

/**
 * `rev-list` of a long trunk can exceed execFile's 1 MiB default stdout cap
 * (~24k commits at 41 bytes/sha). Raise it so the probe doesn't fail — and
 * therefore fall into the fail-safe "skip everything" path — on a big repo.
 */
const REV_LIST_MAX_BUFFER = 64 * 1024 * 1024;

// ── Live-agent shield (issue #110) ──

/**
 * Marker file that pins a worktree against every removal path in this module.
 *
 * Named rather than inlined so `grep -rn lf-agent-active` finds the
 * implementation, not just the convention. See the module docstring.
 */
export const AGENT_ACTIVE_MARKER = ".lf-agent-active";

/**
 * True when a worktree root holds the `.lf-agent-active` marker (issue #110).
 *
 * This is the live-session half of #110's acceptance criteria. A marked
 * worktree is deliberately held by whoever dropped the file, so it is kept
 * unconditionally and *silently*: no removal, no branch delete, no session
 * relocation, and no alert. An alert would be wrong here — "unsafe to remove"
 * alerts exist to surface work that is stuck, and a marked worktree is not
 * stuck, it is claimed.
 *
 * Deliberately independent of git: `stat`, not `git status`, so it does not
 * matter whether the marker is tracked, untracked, or ignored. Before this
 * check existed the marker was honored only as a side effect of #30's
 * `--exclude-standard` untracked scan, which meant a single ignore rule could
 * disarm the whole fleet's shield.
 *
 * Unlike the rest of #110's guardrails this is unconditional — no grace
 * period, no age component. A marked worktree stays until the marker goes.
 */
export async function has_live_agent_marker(worktree_path: string): Promise<boolean> {
  try {
    await stat(join(worktree_path, AGENT_ACTIVE_MARKER));
    return true;
  } catch {
    return false;
  }
}

// ── Safety guardrail (issue #27) ──

/**
 * Reason a worktree was deemed unsafe to remove. Drives the alert message and
 * the recovery hint shown to Hunter.
 */
export type UnsafeReason = "uncommitted" | "untracked" | "unpushed";

export type SafetyCheck = { safe: true } | { safe: false; reason: UnsafeReason; detail: string };

/**
 * Optional dependencies for cleanup operations. Kept optional so tests and
 * older call sites remain ergonomic; production wiring passes both.
 */
export interface CleanupDeps {
  /** When provided, unsafe-skip events post to the entity #alerts channel. */
  alert_router?: AlertRouter | null;
  /** Required alongside alert_router to route alerts to the right entity. */
  entity_id?: string;
}

/**
 * Decide whether a worktree is safe to nuke.
 *
 * The historical bug (issue #27) was treating "no remote tracking ref" as
 * sufficient grounds for removal. That heuristic is true for both merged
 * branches AND never-pushed branches — and the latter case has destroyed
 * agent work at least three times. This helper is the new precondition.
 *
 * Three checks, any failure → unsafe:
 *   1. No uncommitted changes to tracked files.
 *   2. No untracked files (with `--exclude-standard` so .gitignored noise is ignored).
 *   3. No commits on the branch that aren't reachable from any `refs/remotes/origin/*` ref.
 *
 * If the worktree directory has already been removed out-of-band, `git status`
 * will fail. We treat that as safe — the actual removal call is a no-op and
 * we don't want to fire an alert for a worktree that's already gone.
 */
export async function is_worktree_safe_to_remove(
  repo_path: string,
  worktree_path: string,
  branch: string,
): Promise<SafetyCheck> {
  // If the worktree directory itself is gone, there's nothing to protect.
  // Let the caller proceed; `git worktree remove` will no-op and `git
  // worktree prune` will tidy the metadata.
  try {
    await stat(worktree_path);
  } catch {
    return { safe: true };
  }

  // Check 1 + 2: working tree state. Run inside the worktree itself so the
  // status reflects that worktree, not the main checkout.
  // `--porcelain` gives stable, machine-readable output.
  // `--untracked-files=all` includes untracked files individually (we want them).
  // Default `--exclude-standard` is implicit — gitignored paths don't count.
  let porcelain: string;
  try {
    const { stdout } = await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: worktree_path,
      timeout: GIT_TIMEOUT_MS,
    });
    porcelain = stdout;
  } catch {
    // Worktree is in a broken state (mid-rebase corruption, .git missing, etc).
    // Be conservative: refuse to remove. Hunter can investigate.
    return {
      safe: false,
      reason: "uncommitted",
      detail: "git status failed — worktree may be corrupt",
    };
  }

  const status_lines = porcelain.split("\n").filter((line) => line.length > 0);
  const untracked: string[] = [];
  const modified: string[] = [];
  for (const line of status_lines) {
    // Porcelain v1 lines: XY <space> path. "??" = untracked, anything else
    // is a tracked-file change (modified, added, deleted, renamed, etc).
    if (line.startsWith("??")) {
      untracked.push(line.slice(3));
    } else {
      modified.push(line.slice(3));
    }
  }

  if (modified.length > 0) {
    return {
      safe: false,
      reason: "uncommitted",
      detail: format_path_list(modified),
    };
  }

  if (untracked.length > 0) {
    return {
      safe: false,
      reason: "untracked",
      detail: format_path_list(untracked),
    };
  }

  // Check 3: unpushed commits. Delegate to the branch-only helper so the
  // worktree-present and worktree-absent paths share a single source of truth.
  return is_branch_safe_to_remove(repo_path, branch);
}

/**
 * Branch-only safety check: refuse removal if the branch has commits that
 * aren't reachable from any remote tracking ref.
 *
 * Used directly on the no-worktree path of `cleanup_after_merge` (where the
 * working-tree checks don't apply) and as the third check inside
 * `is_worktree_safe_to_remove`. Keeping a single helper means every removal
 * path — worktree-present or not — runs the same unpushed-commit gate.
 *
 * Note: `git branch -d` (soft) already refuses to delete unmerged branches,
 * so this is defense-in-depth. The point is consistent alert behavior across
 * paths, not a new data-loss patch.
 */
export async function is_branch_safe_to_remove(
  repo_path: string,
  branch: string,
): Promise<SafetyCheck> {
  // `git rev-list <branch> --not --remotes` lists commits reachable from
  // <branch> that aren't reachable from any remote ref. Empty → fully pushed.
  //
  // We don't cap with --max-count: the list is bounded by branch length
  // (a single branch's history past its merge base with origin/*), and we
  // need an accurate count for the alert detail. With --max-count=5, the
  // alert would falsely report "5 unpushed commit(s)" even when there were
  // 50, giving Hunter a misleading number to act on.
  let unpushed: string;
  try {
    const { stdout } = await exec("git", ["rev-list", branch, "--not", "--remotes"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    unpushed = stdout;
  } catch {
    // Branch ref missing or rev-list failed. Be conservative: treat as unsafe.
    return {
      safe: false,
      reason: "unpushed",
      detail: "rev-list failed — could not verify push state",
    };
  }

  const unpushed_shas = unpushed.split("\n").filter((line) => line.length > 0);
  if (unpushed_shas.length > 0) {
    // Truncate the SHA list shown in the detail to keep alerts readable, but
    // always report the *true* count first so Hunter sees the real magnitude.
    const MAX_SHAS = 5;
    const shown = unpushed_shas.slice(0, MAX_SHAS).map((s) => s.slice(0, 8));
    const sha_summary =
      unpushed_shas.length > MAX_SHAS
        ? `${shown.join(", ")} (+${String(unpushed_shas.length - MAX_SHAS)} more)`
        : shown.join(", ");
    return {
      safe: false,
      reason: "unpushed",
      detail: `${String(unpushed_shas.length)} unpushed commit(s): ${sha_summary}`,
    };
  }

  return { safe: true };
}

/** Truncate a list of paths for inclusion in an alert body. */
function format_path_list(paths: string[]): string {
  const MAX = 5;
  if (paths.length <= MAX) return paths.join(", ");
  return `${paths.slice(0, MAX).join(", ")} (+${String(paths.length - MAX)} more)`;
}

/**
 * Build the alert body shown when cleanup is skipped. Includes the recovery
 * hint so Hunter can act without spelunking through logs.
 */
function build_unsafe_alert_body(
  repo_path: string,
  worktree_path: string,
  branch: string,
  reason: UnsafeReason,
  detail: string,
): { title: string; body: string } {
  const reason_label: Record<UnsafeReason, string> = {
    uncommitted: "Uncommitted changes",
    untracked: "Untracked files",
    unpushed: "Unpushed commits",
  };

  const title = `Worktree cleanup skipped — ${reason_label[reason]}`;
  const body = [
    `**Repo:** \`${repo_path}\``,
    `**Worktree:** \`${worktree_path}\``,
    `**Branch:** \`${branch}\``,
    `**Reason:** ${reason_label[reason]} — ${detail}`,
    "",
    "**Recover:**",
    "```",
    `cd ${worktree_path}`,
    "git status",
    `git push -u origin ${branch}`,
    "```",
  ].join("\n");

  return { title, body };
}

/**
 * Post the "skipped because unsafe" alert via the existing alert router.
 * No-ops cleanly when no router is wired (e.g. unit tests, or a daemon
 * running without Discord).
 */
async function post_unsafe_alert(
  deps: CleanupDeps,
  repo_path: string,
  worktree_path: string,
  branch: string,
  check: Extract<SafetyCheck, { safe: false }>,
): Promise<void> {
  const { alert_router, entity_id } = deps;
  if (!alert_router || !entity_id) return;

  const { title, body } = build_unsafe_alert_body(
    repo_path,
    worktree_path,
    branch,
    check.reason,
    check.detail,
  );

  try {
    await alert_router.post_alert({
      entity_id,
      tier: "action_required",
      title,
      body,
    });
  } catch (err) {
    // Alert routing must never break cleanup logic.
    console.error(`[worktree-cleanup] Failed to post unsafe alert: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "worktree-cleanup", action: "post_unsafe_alert" },
      contexts: { worktree: { repo_path, worktree_path, branch, reason: check.reason } },
    });
  }
}

// ── Session relocation ──

/**
 * Check all tmux sessions for panes whose cwd is inside `target_path`.
 * For any matches, send a `cd` command to relocate them to `safe_path`.
 *
 * Best-effort: errors for individual sessions are logged but never thrown.
 * This prevents worktree cleanup from failing if tmux is unavailable or
 * a session is in a transient state.
 *
 * @returns The number of sessions that were relocated.
 */
export function relocate_sessions_from_path(target_path: string, safe_path: string): number {
  // Normalize: ensure target_path ends with / for prefix matching.
  // This prevents false positives like /foo/bar-baz matching /foo/bar.
  const target_prefix = target_path.endsWith("/") ? target_path : `${target_path}/`;

  let pane_lines: string[];
  try {
    const result = execFileSync(
      "tmux",
      ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_current_path}"],
      { encoding: "utf-8", timeout: 5000 },
    );
    pane_lines = result.trim().split("\n").filter(Boolean);
  } catch {
    // tmux not running or no sessions — nothing to relocate
    return 0;
  }

  let relocated = 0;

  for (const line of pane_lines) {
    // Each line: "session_name %N /path/to/cwd"
    const [session, pane_id, ...path_parts] = line.split(" ");
    if (!session || !pane_id) continue;
    const pane_cwd = path_parts.join(" "); // handles paths with spaces

    try {
      // Check if the pane's cwd is inside (or exactly at) the target path
      if (pane_cwd === target_path || pane_cwd.startsWith(target_prefix)) {
        execFileSync("tmux", ["send-keys", "-t", pane_id, `cd ${sq(safe_path)}`, "Enter"], {
          timeout: 2000,
        });
        console.log(
          `[worktree-cleanup] Relocated pane ${pane_id} (${session}): ${pane_cwd} → ${safe_path}`,
        );
        relocated++;
      }
    } catch (err) {
      // Per-pane errors are non-fatal — the pane may have died between
      // listing and querying, or it may be in a state that rejects send-keys.
      console.log(
        `[worktree-cleanup] Could not relocate pane ${pane_id} (${session}): ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  return relocated;
}

// ── Parsed worktree entry from `git worktree list --porcelain` ──

interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** HEAD commit hash. */
  head: string;
  /** Branch ref (e.g. "refs/heads/feature/foo"), or null if detached. */
  branch: string | null;
  /** True if this is the main working tree. */
  bare: boolean;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Porcelain format is blocks separated by blank lines:
 *   worktree /path/to/tree
 *   HEAD abc123
 *   branch refs/heads/main
 *   <blank line>
 */
export function parse_worktree_list(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.trim().split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split("\n");
    let path = "";
    let head = "";
    let branch: string | null = null;
    let bare = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      } else if (line === "bare") {
        bare = true;
      }
    }

    if (path) {
      entries.push({ path, head, branch, bare });
    }
  }

  return entries;
}

/**
 * Extract the short branch name from a refs/heads/ ref.
 * e.g. "refs/heads/feature/134-auto-cleanup" → "feature/134-auto-cleanup"
 */
function short_branch(ref: string): string {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

// ── Core cleanup function ──

/**
 * Remove a single worktree and its branch. Best-effort — logs errors but
 * never throws. Safe to call even if the worktree or branch no longer exists.
 *
 * Issue #110 shield: a worktree holding `.lf-agent-active` is never removed,
 * checked here so every caller inherits it whether or not it remembered to
 * ask. No alert — see `has_live_agent_marker`.
 *
 * Issue #27 guardrail: before any removal, runs `is_worktree_safe_to_remove`.
 * If the worktree has uncommitted changes, untracked files, or unpushed
 * commits, the removal is skipped, an action-required alert is posted, and
 * this function returns `false` without touching disk.
 *
 * `branch` MUST be the branch actually checked out in `worktree_path`. Passing
 * any other branch silently defeats the unpushed-commit precondition, which is
 * evaluated against `branch` while the directory destroyed is
 * `worktree_path` — that mismatch was a live data-loss path through
 * `cleanup_claude_worktrees` (issue #110 review).
 *
 * That requirement is *enforced*, not merely documented (step 0b): if the
 * directory's own branch resolves and disagrees with `branch`, the removal is
 * refused. This function is exported, so the invariant would otherwise survive
 * only by every caller's good manners — and misuse of exactly this parameter
 * is the defect above. A directory whose branch cannot be resolved at all is
 * allowed through, because that is also the shape of a worktree that has
 * already been removed out-of-band, and refusing there would break the
 * "already gone" no-op path.
 *
 * @param repo_path - Root repo path (not the worktree itself)
 * @param worktree_path - Absolute path to the worktree directory
 * @param branch - Branch checked out in `worktree_path` (short form, e.g. "feature/134-auto-cleanup")
 * @param deps - Optional alert routing for unsafe-skip events.
 */
export async function remove_worktree(
  repo_path: string,
  worktree_path: string,
  branch: string,
  deps: CleanupDeps = {},
): Promise<boolean> {
  // Step 0a: live-agent shield. Backstop for callers that did not pre-check.
  if (await has_live_agent_marker(worktree_path)) {
    console.log(
      `[worktree-cleanup] Keeping worktree (live agent marker ${AGENT_ACTIVE_MARKER}): ${worktree_path} [${branch}]`,
    );
    return false;
  }

  // Step 0b: branch-identity invariant. #30's unpushed check below runs against
  // `branch`, so a caller that names a branch other than the one checked out
  // here would be checking the wrong thing. Refuse rather than trust.
  const repo_common_dir = await resolve_repo_common_dir(repo_path);
  if (repo_common_dir !== null) {
    const own_branch = await resolve_worktree_branch(worktree_path, repo_common_dir);
    if (own_branch !== null && own_branch !== branch) {
      console.error(
        `[worktree-cleanup] Refusing to remove ${worktree_path}: caller named branch ${branch}, but ${own_branch} is checked out there (issue #110 review)`,
      );
      sentry.captureMessage("worktree-cleanup: branch-identity invariant violated", "error", {
        tags: { module: "worktree-cleanup", action: "remove_worktree" },
        contexts: { worktree: { path: worktree_path, named_branch: branch, own_branch } },
      });
      return false;
    }
  }

  // Step 0c: safety guardrail. Refuse to remove worktrees with unsaved work.
  const check = await is_worktree_safe_to_remove(repo_path, worktree_path, branch);
  if (!check.safe) {
    console.warn(
      `[worktree-cleanup] Skipping removal of ${worktree_path} [${branch}]: ${check.reason} — ${check.detail}`,
    );
    await post_unsafe_alert(deps, repo_path, worktree_path, branch, check);
    return false;
  }

  let removed_worktree = false;

  // Step 1: Remove the worktree
  try {
    await exec("git", ["worktree", "remove", worktree_path, "--force"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    removed_worktree = true;
    console.log(`[worktree-cleanup] Removed worktree: ${worktree_path}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "not a working tree" or similar means it's already gone — that's fine
    if (msg.includes("not a working tree") || msg.includes("is not a valid")) {
      console.log(`[worktree-cleanup] Worktree already gone: ${worktree_path}`);
      removed_worktree = true;
    } else {
      console.error(`[worktree-cleanup] Failed to remove worktree ${worktree_path}: ${msg}`);
      sentry.captureException(err, {
        tags: { module: "worktree-cleanup", action: "remove_worktree" },
        contexts: { worktree: { path: worktree_path, branch } },
      });
    }
  }

  // Step 2: Prune any stale worktree references
  try {
    await exec("git", ["worktree", "prune"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    // Non-critical — prune is housekeeping
  }

  // Step 3: Delete the branch (soft delete — fails if not fully merged, which is fine)
  try {
    await exec("git", ["branch", "-d", branch], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    console.log(`[worktree-cleanup] Deleted branch: ${branch}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "not found" means branch already deleted (e.g., --delete-branch on merge)
    if (msg.includes("not found") || msg.includes("error: branch")) {
      console.log(`[worktree-cleanup] Branch already gone: ${branch}`);
    } else {
      // Not critical — branch may still be needed or was force-deleted
      console.log(`[worktree-cleanup] Could not delete branch ${branch}: ${msg}`);
    }
  }

  return removed_worktree;
}

/**
 * Relocate any tmux panes out of a worktree, then remove it.
 *
 * The ordering is the reason this helper exists. `relocate_sessions_from_path`
 * sends `cd` to every pane sitting in the directory — if the removal is then
 * refused, a live agent has been yanked out of its cwd for nothing. So the
 * live-agent marker is consulted *before* the relocation, not just inside
 * `remove_worktree`. All three removal paths in this module go through here so
 * none of them can get that order wrong again (issue #110 review).
 *
 * @param branch - Must be the branch checked out in `worktree_path`.
 */
async function relocate_then_remove(
  repo_path: string,
  worktree_path: string,
  branch: string,
  deps: CleanupDeps,
): Promise<boolean> {
  if (await has_live_agent_marker(worktree_path)) {
    console.log(
      `[worktree-cleanup] Keeping worktree (live agent marker ${AGENT_ACTIVE_MARKER}): ${worktree_path} [${branch}]`,
    );
    return false;
  }

  const relocated = relocate_sessions_from_path(worktree_path, repo_path);
  if (relocated > 0) {
    console.log(
      `[worktree-cleanup] Relocated ${String(relocated)} session(s) from ${worktree_path}`,
    );
  }

  return remove_worktree(repo_path, worktree_path, branch, deps);
}

// ── Find worktree for a specific branch ──

/**
 * Find the worktree entry for a given branch name in a repo.
 * Returns the worktree path if found, null otherwise.
 */
export async function find_worktree_for_branch(
  repo_path: string,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });

    const entries = parse_worktree_list(stdout);
    for (const entry of entries) {
      if (entry.branch && short_branch(entry.branch) === branch) {
        return entry.path;
      }
    }
  } catch (err) {
    console.error(`[worktree-cleanup] Failed to list worktrees in ${repo_path}: ${String(err)}`);
  }

  return null;
}

// ── Cleanup on PR merge ──

/**
 * Clean up worktrees associated with a merged PR's branch.
 * Called from the webhook handler after a PR merge event.
 *
 * Checks both git-tracked worktrees and .claude/worktrees/ directories.
 */
export async function cleanup_after_merge(
  repo_path: string,
  branch: string,
  deps: CleanupDeps = {},
): Promise<void> {
  console.log(`[worktree-cleanup] Cleaning up after merge of branch: ${branch}`);

  // 1. Check git worktree list for a worktree on this branch
  const worktree_path = await find_worktree_for_branch(repo_path, branch);
  if (worktree_path) {
    // `find_worktree_for_branch` matched on the worktree's own branch ref, so
    // `branch` is by construction the one checked out here.
    await relocate_then_remove(repo_path, worktree_path, branch, deps);
  } else {
    console.log(`[worktree-cleanup] No git worktree found for branch: ${branch}`);
    // If the branch ref itself doesn't exist locally, there's literally nothing
    // to delete or protect — silent no-op (mirrors the missing-worktree-dir path
    // in is_worktree_safe_to_remove, where we deliberately avoid alert spam for
    // entities that have already been cleaned up).
    const branch_exists = await branch_ref_exists(repo_path, branch);
    if (!branch_exists) {
      // Nothing more to do for the git-tracked branch path.
    } else {
      // Branch exists locally but no worktree references it. Route through the
      // same guardrail so unpushed work is never silently destroyed. The
      // working-tree checks don't apply here (no worktree), but the
      // unpushed-commits check absolutely does.
      const check = await is_branch_safe_to_remove(repo_path, branch);
      if (!check.safe) {
        console.warn(
          `[worktree-cleanup] Skipping branch delete for ${branch}: ${check.reason} — ${check.detail}`,
        );
        // No worktree path to show in the alert — pass the repo path so the
        // recovery hint at least points at the right repo.
        await post_unsafe_alert(deps, repo_path, repo_path, branch, check);
      } else {
        try {
          await exec("git", ["branch", "-d", branch], {
            cwd: repo_path,
            timeout: GIT_TIMEOUT_MS,
          });
          console.log(`[worktree-cleanup] Deleted branch: ${branch}`);
        } catch {
          // Branch may already be gone — fine
        }
      }
    }
  }

  // 2. Check .claude/worktrees/ for agent-created worktrees on this branch
  await cleanup_claude_worktrees(repo_path, new Set([branch]), deps);
}

/**
 * Absolute path of a repo's *common* git dir — the single `.git` shared by the
 * main working tree and every linked worktree. `null` if `repo_path` is not a
 * git repo (or the probe failed).
 *
 * This is the identity of "this repo", used by `resolve_worktree_branch` to
 * tell a linked worktree of ours from an unrelated repository that merely sits
 * in the same directory. `--path-format=absolute` is what makes the comparison
 * sound: git then prints this path in *physical* form (symlinks resolved) from
 * the main repo and from any linked worktree alike, so the two answers are
 * textually comparable even when the configured repo path reaches the repo
 * through a symlink. Comparing `rev-parse --show-toplevel` against the path we
 * were handed does NOT have that property — on macOS, `/var/...` in, physical
 * `/private/var/...` out — and would reject every genuine worktree under a
 * symlinked root, silently turning the whole scan into a no-op.
 *
 * `--path-format` needs git >= 2.31. On anything older this returns `null`,
 * which declines the scan with a log line rather than guessing.
 */
async function resolve_repo_common_dir(repo_path: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repo_path, timeout: GIT_TIMEOUT_MS },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the branch actually checked out in a worktree directory, or `null`.
 *
 * `null` means "do not touch it", and that is the only safe default: a
 * directory whose branch we cannot name is a directory whose contents we
 * cannot reason about.
 *
 * ## Why `symbolic-ref` alone is not the answer
 *
 * **Git walks up.** It does not answer questions about the directory you hand
 * it; it answers questions about whatever repository encloses it. Probed on
 * git 2.50.1, the five shapes a `.claude/worktrees/` entry can take are:
 *
 * | shape                       | `symbolic-ref --short HEAD` |
 * |-----------------------------|-----------------------------|
 * | A plain leftover directory  | the **enclosing repo's** branch |
 * | B genuine linked worktree   | its own branch (correct)    |
 * | C pruned worktree metadata  | fatal → `null`              |
 * | D detached HEAD             | fatal → `null`              |
 * | E unrelated nested repo     | **that repo's** branch      |
 *
 * A and E hand back a branch that is not checked out in the directory being
 * targeted, which is precisely the wrong-branch handoff this whole code path
 * was rewritten to eliminate (issue #110 review, finding 1). Both were
 * non-destructive only by git's own refusals — `git worktree remove` declines
 * a non-worktree, `git branch -d` declines a checked-out branch — except for
 * shape E, where the branch delete lands on the *parent* repo's merged ref and
 * succeeds. Safety that comes from the subprocess refusing is not safety.
 *
 * So two gates, both from one `rev-parse`:
 *
 *  1. `--show-cdup` must be empty: the directory must *be* the root of its
 *     working tree, not somewhere inside one. Rejects A. (Relative output, so
 *     no path comparison and no symlink hazard.)
 *  2. `--git-common-dir` must equal this repo's. Rejects E, and any linked
 *     worktree belonging to some other repository.
 *
 * C makes the `rev-parse` itself fail; D fails the `symbolic-ref`. All three
 * rejections land on `null`.
 */
async function resolve_worktree_branch(
  worktree_path: string,
  repo_common_dir: string,
): Promise<string | null> {
  let cdup: string;
  let common_dir: string;
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--show-cdup", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktree_path, timeout: GIT_TIMEOUT_MS },
    );
    const [raw_cdup = "", raw_common = ""] = stdout.split("\n");
    cdup = raw_cdup.trim();
    common_dir = raw_common.trim();
  } catch {
    // Not a git directory at all (shape C), or rev-parse failed.
    return null;
  }

  // Gate 1: a subdirectory of some working tree, not a worktree root (shape A).
  if (cdup !== "") return null;
  // Gate 2: a worktree root, but not one of *ours* (shape E).
  if (common_dir === "" || common_dir !== repo_common_dir) return null;

  try {
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: worktree_path,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    // Detached HEAD (shape D).
    return null;
  }
}

/**
 * Remove `.claude/worktrees/` directories whose own checked-out branch is in
 * `target_branches`.
 *
 * ## Why this matches on branch identity and not on directory name
 *
 * This function used to match directories by *substring of the target
 * branch's slug* (`entry.name.includes(slug)`) and then hand the **target**
 * branch to `remove_worktree` — a branch with no necessary relationship to the
 * directory being destroyed. Two things went wrong at once:
 *
 *  1. #30's unpushed-commit precondition was evaluated against the target
 *     branch (merged, therefore pushed, therefore "safe") while the directory
 *     deleted belonged to some other branch whose commits may never have been
 *     pushed. Only the uncommitted/untracked `git status` checks looked at the
 *     right directory, and a clean worktree trips neither.
 *  2. #110's unstarted-branch guard was likewise evaluated against the target
 *     branch, so the sweep's main loop could spare a brand-new worktree and
 *     this path would delete the same directory three lines later.
 *
 * The slug heuristic was also just wrong about the world. `.claude/worktrees/`
 * is the Claude Code harness's own worktree feature (`EnterWorktree`), which
 * names directories from its `name` argument or, by default, **randomly** —
 * every live example on this machine is `agent-<hex8>`, e.g. `agent-aa3e284a`
 * holding `feature/7-live-dashboard`. So the name never contains the slug when
 * you want it to, and a short slug substring-matches hex when you don't:
 * `"agent-aa3e284a".includes("2")` is `true`, which is enough to delete a
 * live worktree over a merged `.../2`.
 *
 * So: ask the directory what branch it is on, act only on an exact match, and
 * pass *that* branch to `remove_worktree`. The name is never consulted.
 *
 * "Ask the directory" is load-bearing and is harder than one `symbolic-ref` —
 * git answers for the repository *enclosing* a path, not for the path. See
 * `resolve_worktree_branch`: an entry is only ever acted on if it is the root
 * of a working tree that belongs to this very repo.
 */
async function cleanup_claude_worktrees(
  repo_path: string,
  target_branches: ReadonlySet<string>,
  deps: CleanupDeps = {},
): Promise<void> {
  if (target_branches.size === 0) return;

  const claude_wt_dir = join(repo_path, ".claude", "worktrees");

  try {
    await stat(claude_wt_dir);
  } catch {
    // No .claude/worktrees/ directory — nothing to do
    return;
  }

  // Identity of this repo, for `resolve_worktree_branch`'s second gate. If we
  // cannot establish it we cannot tell our own worktrees from a foreign repo
  // that happens to sit in this directory, so we decline the whole scan — and
  // say so, rather than silently reclassifying every entry as unresolvable.
  const repo_common_dir = await resolve_repo_common_dir(repo_path);
  if (repo_common_dir === null) {
    console.warn(
      `[worktree-cleanup] Could not resolve the git common dir of ${repo_path} — skipping .claude/worktrees/ scan`,
    );
    return;
  }

  try {
    const entries = await readdir(claude_wt_dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const wt_path = join(claude_wt_dir, entry.name);
      const own_branch = await resolve_worktree_branch(wt_path, repo_common_dir);
      if (own_branch === null) {
        console.log(
          `[worktree-cleanup] Leaving .claude/worktrees/ entry with no resolvable branch: ${wt_path}`,
        );
        continue;
      }
      if (!target_branches.has(own_branch)) continue;

      console.log(`[worktree-cleanup] Found .claude/worktrees/ match: ${wt_path} [${own_branch}]`);
      await relocate_then_remove(repo_path, wt_path, own_branch, deps);
    }
  } catch (err) {
    console.error(`[worktree-cleanup] Error scanning .claude/worktrees/: ${String(err)}`);
  }
}

// ── Stale-classification guardrail (issue #110) ──

/**
 * The set of commits on the trunk's first-parent history, or `null` when it
 * could not be determined. `null` is load-bearing: callers treat "unknown
 * trunk" as "cannot prove this branch did any work" and skip removal.
 */
export type TrunkHistory = Set<string> | null;

/**
 * Read the trunk's first-parent history (issue #110).
 *
 * First-parent history is the discriminator that makes `is_unstarted_branch`
 * work. Every commit ever *merged in* from a side branch is reachable from
 * trunk but is NOT on trunk's first-parent chain (it hangs off a merge
 * commit's second parent). Commits that are on the chain are trunk commits —
 * so a branch pointing at one is a branch that has produced nothing.
 *
 * Refs that don't resolve are skipped individually, so a repo with no
 * `origin` remote still gets a usable answer from `refs/heads/main`.
 *
 * @returns Union of the first-parent histories of every resolvable trunk ref,
 *   or `null` if none resolved (i.e. we have no idea what trunk looks like).
 */
async function load_trunk_history(repo_path: string): Promise<TrunkHistory> {
  const shas = new Set<string>();
  let any_resolved = false;

  for (const ref of TRUNK_REFS) {
    try {
      const { stdout } = await exec("git", ["rev-list", "--first-parent", ref], {
        cwd: repo_path,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: REV_LIST_MAX_BUFFER,
      });
      any_resolved = true;
      for (const line of stdout.split("\n")) {
        const sha = line.trim();
        if (sha) shas.add(sha);
      }
    } catch {
      // Ref doesn't exist in this repo (or rev-list failed) — try the next one.
    }
  }

  return any_resolved ? shas : null;
}

/**
 * True when a branch has produced no commits of its own (issue #110).
 *
 * This is the fix for the sweep misclassifying freshly-created worktrees as
 * stale. A brand-new worktree (`git worktree add <dir> -b <branch> origin/main`)
 * has a branch tip that is *literally a trunk commit*: zero commits ahead, a
 * clean working tree, and no `origin/<branch>` ref yet. That made it
 * indistinguishable from finished work to both of `sweep_repo`'s stale tests —
 * `git branch --merged main` lists it, and `is_remote_branch_gone` reports its
 * never-created remote ref as "gone" — while #27/#30's safety preconditions
 * found nothing to protect (nothing uncommitted, untracked, or unpushed,
 * because nothing had been written yet). The worktree was deleted out from
 * under a running agent.
 *
 * A branch whose tip is on trunk's first-parent history cannot be finished
 * work: its commits, if it had any, would hang off trunk rather than sit on
 * it. Checking the tip (rather than "zero commits ahead of main") is what
 * keeps genuinely-merged worktrees sweepable — a branch merged into main via
 * a merge commit is also zero-ahead, but its tip is *off* the first-parent
 * chain, so it stays eligible.
 *
 * Deliberately conservative in both unknown cases — an empty `tip_sha` or an
 * unknown trunk returns `true` (treat as unstarted → do not remove). Leaking
 * a stale worktree costs disk; removing a live one destroys work.
 *
 * ## Known limitation: fast-forward merges are never swept
 *
 * `git merge --ff-only feature/x` (and plain `git merge feature/x` when it can
 * fast-forward, which is git's default) moves trunk *to* the branch tip rather
 * than creating a merge commit. The branch tip is then literally a trunk
 * commit on the first-parent chain, so this function returns `true` for it
 * forever and the worktree can never be reclaimed by the sweep, however long
 * it sits or however thoroughly its branch was merged and deleted on the
 * remote. (`--no-ff` and `--squash` merges are unaffected: a `--no-ff` tip
 * hangs off a merge commit's second parent and stays sweepable, while a
 * `--squash` tip is blocked earlier by #30's unpushed check — see
 * `worktree-cleanup.git-integration.test.ts`.)
 *
 * This is documented rather than fixed, deliberately. Distinguishing
 * "ff-merged and abandoned" from "created ten minutes ago and in use" needs
 * evidence that `origin/<branch>` *once* existed, which is exactly the
 * evidence `git fetch --prune` has already destroyed; the available proxies
 * (reflog archaeology, a worktree-age grace window) either expire or re-open
 * #110 for any long-lived worktree. The live-agent marker above is the
 * intended escape hatch for the age-based variant, and it has zero adoption
 * today — nothing in the fleet writes it yet — so shipping an age-based
 * reclaim path now would mean shipping it unshielded.
 *
 * Net effect: ff-merged and squash-merged worktrees leak. That is bounded,
 * visible in the sweep log, and the right side of the trade for a destructive
 * operation. Reclaiming them needs its own design (marker adoption first),
 * not a widened classifier here — tracked in **issue #129**, along with the
 * other half of the same problem: a marker left behind by a crashed agent pins
 * its worktree forever, with no expiry and no digest of what the sweep
 * declined to touch.
 */
export function is_unstarted_branch(tip_sha: string, trunk: TrunkHistory): boolean {
  if (!tip_sha) return true;
  if (trunk === null) return true;
  return trunk.has(tip_sha);
}

/** Resolve a branch name to its tip sha. Returns null if it doesn't resolve. */
async function resolve_branch_tip(repo_path: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Periodic stale worktree sweep ──

/**
 * Sweep all entity repos for stale worktrees. A worktree is stale if:
 * - Its branch has been merged into main, or
 * - Its branch's remote tracking ref no longer exists
 *
 * ...and, per issue #110, only if its branch has produced at least one commit
 * of its own (see `is_unstarted_branch` — both stale tests above fire on a
 * brand-new worktree, which is why that guardrail exists) and its root does
 * not hold the `.lf-agent-active` marker (see `has_live_agent_marker`).
 *
 * Designed to run periodically (e.g., hourly) as a safety net.
 */
export async function sweep_stale_worktrees(
  registry: EntityRegistry,
  deps: Pick<CleanupDeps, "alert_router"> = {},
): Promise<void> {
  const entities = registry.get_active();
  let total_cleaned = 0;

  for (const entity_config of entities) {
    const entity_id = entity_config.entity.id;
    for (const repo of entity_config.entity.repos) {
      const repo_path = expand_home(repo.path);

      // Verify repo exists before shelling out
      try {
        await stat(repo_path);
      } catch {
        continue;
      }

      const cleaned = await sweep_repo(repo_path, {
        alert_router: deps.alert_router ?? null,
        entity_id,
      });
      total_cleaned += cleaned;
    }
  }

  if (total_cleaned > 0) {
    console.log(
      `[worktree-cleanup] Sweep complete: cleaned ${String(total_cleaned)} stale worktree(s)`,
    );
  }
}

/**
 * Sweep a single repo for stale worktrees.
 * Returns the number of worktrees cleaned up.
 */
async function sweep_repo(repo_path: string, deps: CleanupDeps = {}): Promise<number> {
  // Fetch remote refs first so we have current state
  try {
    await exec("git", ["fetch", "--prune"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    // Non-critical — we'll still check local state
  }

  // Trunk first-parent history, for the issue #110 unstarted-branch guardrail.
  // Loaded once per repo per sweep and shared by both removal paths below.
  //
  // Probed here — straight after the fetch, ahead of the merged-branch and
  // worktree-list probes — because `trunk === null` abandons the whole repo,
  // so those two subprocesses would be wasted work on the failure path. It
  // deliberately stays *after* the fetch: computed against a stale
  // `origin/main` the trunk set is smaller, which would make the guardrail
  // less conservative, not more.
  const trunk = await load_trunk_history(repo_path);
  if (trunk === null) {
    console.warn(
      `[worktree-cleanup] Could not resolve trunk history in ${repo_path} — skipping sweep (issue #110 guardrail)`,
    );
    return 0;
  }

  // Get the list of branches merged into main
  let merged_branches: Set<string>;
  try {
    const { stdout } = await exec("git", ["branch", "--merged", "main"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    merged_branches = new Set(
      stdout
        .split("\n")
        // Git marks the current branch with `* ` and a branch checked out in
        // ANOTHER worktree with `+ ` — i.e. every agent worktree branch. The
        // original pattern stripped only `* `, so these arrived as
        // "+ feature/x", `merged_branches.has("feature/x")` was always false,
        // and Case 1 below could never fire for precisely the branches this
        // sweep exists to evaluate. (Every removal logged "remote gone".)
        .map((line) => line.trim().replace(/^[*+]\s+/, ""))
        .filter((b) => b && b !== "main"),
    );
  } catch {
    // Can't determine merged branches — skip this repo
    return 0;
  }

  // List all worktrees
  let entries: WorktreeEntry[];
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    entries = parse_worktree_list(stdout);
  } catch {
    return 0;
  }

  let cleaned = 0;

  for (const entry of entries) {
    // Skip the main working tree (the first entry, or bare repos)
    if (entry.bare || !entry.branch) continue;

    const branch = short_branch(entry.branch);

    // Never clean up main
    if (branch === "main" || branch === "master") continue;

    // Check if this is the main working tree (same path as repo_path)
    if (entry.path === repo_path) continue;

    // Issue #110: a branch that has produced no commits of its own is not
    // stale, it's unstarted — an agent is very likely working in it right now.
    // This runs BEFORE either stale test because both of them fire on a
    // brand-new worktree (merged-into-main via `branch --merged`, remote-gone
    // via a never-pushed branch) and neither is evidence that work is done.
    if (is_unstarted_branch(entry.head, trunk)) {
      console.log(
        `[worktree-cleanup] Keeping worktree (branch has no commits of its own): ${entry.path} [${branch}]`,
      );
      continue;
    }

    let should_clean = false;

    // Case 1: Branch is merged into main
    if (merged_branches.has(branch)) {
      console.log(`[worktree-cleanup] Stale worktree (branch merged): ${entry.path} [${branch}]`);
      should_clean = true;
    }

    // Case 2: Remote tracking ref is gone (branch deleted on remote)
    if (!should_clean) {
      should_clean = await is_remote_branch_gone(repo_path, branch);
      if (should_clean) {
        console.log(`[worktree-cleanup] Stale worktree (remote gone): ${entry.path} [${branch}]`);
      }
    }

    if (should_clean) {
      const removed = await relocate_then_remove(repo_path, entry.path, branch, deps);
      if (removed) cleaned++;
    }
  }

  // Also sweep .claude/worktrees/ for agent directories on merged branches.
  //
  // Issue #110 applies here too, so the guardrail is applied to each candidate
  // branch before it is offered as a removal target. `cleanup_claude_worktrees`
  // then matches directories on their *own* checked-out branch, so a directory
  // can only be destroyed under a branch that is both in this filtered set and
  // actually checked out in it — never, as before, under an unrelated branch
  // whose slug happened to appear in the directory's name.
  const sweepable_merged = new Set<string>();
  for (const branch of merged_branches) {
    const tip = await resolve_branch_tip(repo_path, branch);
    if (tip === null || is_unstarted_branch(tip, trunk)) continue;
    sweepable_merged.add(branch);
  }
  await cleanup_claude_worktrees(repo_path, sweepable_merged, deps);

  return cleaned;
}

/**
 * Check if a local branch ref exists in this repo.
 * Returns true if `refs/heads/<branch>` resolves, false otherwise.
 *
 * Used by `cleanup_after_merge` to short-circuit the no-worktree branch
 * cleanup path: if the branch was already deleted out-of-band (by a previous
 * cleanup, by the merge --delete-branch flag, or because we're operating
 * against a path that isn't a git repo at all), there's nothing to delete
 * and nothing to protect.
 */
async function branch_ref_exists(repo_path: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a branch's remote tracking ref (origin/<branch>) no longer exists.
 * Returns true if the remote ref is gone, false if it still exists or on error.
 */
async function is_remote_branch_gone(repo_path: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    // Ref exists — not stale
    return false;
  } catch {
    // Ref doesn't exist — remote branch is gone
    return true;
  }
}
