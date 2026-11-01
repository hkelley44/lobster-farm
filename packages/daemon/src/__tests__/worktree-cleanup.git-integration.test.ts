/**
 * Real-git integration tests for the stale-worktree sweep.
 *
 * Every other test in this area mocks `execFile`, which means it tests our
 * *model* of git rather than git. That is exactly how issue #110 shipped: the
 * mocked suite asserted the sweep removed "merged" and "remote-gone"
 * worktrees, and both of those predicates silently also match a worktree that
 * was created thirty seconds ago. This file builds throwaway repositories on
 * disk and runs the real sweep against them, so the classification is checked
 * against git's actual behavior.
 *
 * Scope: one fixture repo covering every case, one sweep run, assertions per
 * case. Nothing here touches any repo outside its own temp directory.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_ACTIVE_MARKER, sweep_stale_worktrees } from "../worktree-cleanup.js";

/** Hermetic git env — ignore the host's global/system config and identity. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
}

function commit(cwd: string, name: string, body: string): void {
  writeFileSync(join(cwd, name), `${body}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `add ${name}`);
}

interface AlertPayload {
  entity_id: string;
  tier: string;
  title: string;
  body: string;
}

let root: string;
let repo: string;
const alerts: AlertPayload[] = [];

/** Absolute path of a fixture worktree. */
function wt(name: string): string {
  return join(root, name);
}

/**
 * Absolute path of a fixture worktree under the repo's `.claude/worktrees/`.
 *
 * Names here are deliberately the real shape produced by the Claude Code
 * harness's `EnterWorktree` tool: `agent-<random hex8>`, with no relationship
 * to the branch checked out in them. Each contains one of the merged issue
 * numbers below, which is what the old slug-substring matcher keyed on.
 */
function claude_wt(name: string): string {
  return join(repo, ".claude", "worktrees", name);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lf-sweep-integration-"));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");

  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  git(repo, "remote", "add", "origin", origin);

  // Trunk: a .gitignore plus three commits.
  //
  // `.lf-agent-active` is gitignored HERE, and only here, on purpose. In the
  // real repo it is deliberately NOT ignored, but as long as it is untracked
  // #30's untracked-file check spares a marked worktree all by itself — which
  // is exactly the accident the marker used to rely on, and it would make the
  // marker test below vacuous. Ignoring it in the fixture removes that crutch
  // so the marked worktree survives on the strength of the marker check or
  // not at all.
  writeFileSync(join(repo, ".gitignore"), `.claude/\n${AGENT_ACTIVE_MARKER}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "add .gitignore");
  commit(repo, "one.txt", "1");
  commit(repo, "two.txt", "2");
  commit(repo, "three.txt", "3");
  git(repo, "push", "-q", "-u", "origin", "main");
  const older_trunk_commit = git(repo, "rev-parse", "HEAD~2").trim();

  // ── Genuinely stale: committed, pushed, merged into main, remote deleted ──
  git(repo, "worktree", "add", "-q", wt("merged"), "-b", "feature/merged", "origin/main");
  commit(wt("merged"), "merged-work.txt", "shipped");
  git(wt("merged"), "push", "-q", "-u", "origin", "feature/merged");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/merged", "feature/merged");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/merged");

  // ── Issue #110: brand-new worktree at origin/main, nothing written yet ──
  git(repo, "worktree", "add", "-q", wt("fresh"), "-b", "feature/fresh", "origin/main");

  // ── Issue #110 variant: created at an older trunk commit, trunk has since
  // advanced (the merge above). Tip equality alone would not save this one. ──
  git(repo, "worktree", "add", "-q", wt("oldbase"), "-b", "feature/oldbase", older_trunk_commit);

  // ── #30 guardrail: own commit, never pushed ──
  git(repo, "worktree", "add", "-q", wt("unpushed"), "-b", "feature/unpushed", "origin/main");
  commit(wt("unpushed"), "wip.txt", "in progress");

  // ── #30 guardrail: pushed-then-deleted branch, plus an untracked file ──
  git(repo, "worktree", "add", "-q", wt("untracked"), "-b", "feature/untracked", "origin/main");
  commit(wt("untracked"), "untracked-branch-work.txt", "shipped");
  git(wt("untracked"), "push", "-q", "-u", "origin", "feature/untracked");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/untracked", "feature/untracked");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/untracked");
  writeFileSync(join(wt("untracked"), "scratch-notes.md"), "not committed\n");

  // ── #30 guardrail: pushed-then-deleted branch, plus a modified tracked file ──
  git(repo, "worktree", "add", "-q", wt("dirty"), "-b", "feature/dirty", "origin/main");
  commit(wt("dirty"), "dirty-branch-work.txt", "shipped");
  git(wt("dirty"), "push", "-q", "-u", "origin", "feature/dirty");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/dirty", "feature/dirty");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/dirty");
  writeFileSync(join(wt("dirty"), "dirty-branch-work.txt"), "edited after merge\n");

  // ── Issue #110 review, finding 1: the `.claude/worktrees/` wrong-branch path.
  //
  // `fix/27` and `fix/30` are real merged branches with real commits — pushed,
  // `--no-ff` merged, remote-deleted, local refs kept so `git branch --merged
  // main` still lists them. Their slugs are "27" and "30", and under this
  // project's `{type}/{issue#}-{slug}` convention a slug that begins with an
  // issue number is the norm; a bare issue number is what a quick local branch
  // looks like. Each one is a substring of exactly one of the harness
  // directory names below — which is all the old matcher needed — and neither
  // directory is on either branch. One merged branch per directory, so the
  // branch-ref deletion that follows one removal cannot accidentally change
  // the verdict on the other.
  for (const [branch, file] of [
    ["fix/27", "twentyseven.txt"],
    ["fix/30", "thirty.txt"],
  ] as const) {
    git(repo, "checkout", "-q", "-b", branch);
    commit(repo, file, "shipped");
    git(repo, "push", "-q", "-u", "origin", branch);
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "push", "-q", "origin", "--delete", branch);
  }

  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });

  // Brand-new harness worktree, nothing written yet — the #110 shape, in the
  // one place the #110 fix did not reach. Spared by the main loop, then
  // deleted by the slug-matched sweep three lines later. Matched by "27".
  git(
    repo,
    "worktree",
    "add",
    "-q",
    claude_wt("agent-9c27a1b5"),
    "-b",
    "feature/live-fresh",
    "origin/main",
  );

  // Harness worktree holding a real, never-pushed commit. #30's unpushed check
  // would catch this — except the old code evaluated it against the matched
  // branch (merged, therefore pushed, therefore "safe") while deleting this
  // directory, so the check reported safe and the work's only checkout went
  // with it. The tracked state is clean, so nothing else protects it. Matched
  // by "30".
  git(
    repo,
    "worktree",
    "add",
    "-q",
    claude_wt("agent-30fe4d82"),
    "-b",
    "feature/live-work",
    "origin/main",
  );
  commit(claude_wt("agent-30fe4d82"), "live-agent-work.txt", "hours of work");

  // ── Issue #110 review, finding 2: the `.lf-agent-active` live-agent shield.
  //
  // Genuinely sweepable in every respect — own commit, pushed, `--no-ff`
  // merged, remote branch deleted, working tree clean — so every other
  // guardrail in the module says "go ahead". The marker is the only thing
  // standing between it and deletion, and it is gitignored (see .gitignore
  // above) so #30's untracked check cannot stand in for it.
  git(repo, "worktree", "add", "-q", wt("marked"), "-b", "feature/marked", "origin/main");
  commit(wt("marked"), "marked-branch-work.txt", "shipped");
  git(wt("marked"), "push", "-q", "-u", "origin", "feature/marked");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/marked", "feature/marked");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/marked");
  writeFileSync(join(wt("marked"), AGENT_ACTIVE_MARKER), "session=live\n");

  // ── Issue #110 review, finding 3: the `+ ` prefix in `git branch --merged`.
  //
  // Merged into main via `--no-ff`, but the remote branch is deliberately NOT
  // deleted, so "remote gone" (Case 2) cannot fire and Case 1 — "branch
  // merged" — is the only route to sweeping it. Since the branch is checked
  // out in a worktree, git lists it as "+ feature/caseone"; stripping only
  // "* " left the marker in the string and Case 1 could never match.
  //
  // Named "caseone" rather than anything containing another fixture's name:
  // several assertions here are substring checks against `git worktree list`,
  // so a fixture whose path contains another's would cross-trip them.
  git(repo, "worktree", "add", "-q", wt("caseone"), "-b", "feature/caseone", "origin/main");
  commit(wt("caseone"), "caseone-work.txt", "shipped");
  git(wt("caseone"), "push", "-q", "-u", "origin", "feature/caseone");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/caseone", "feature/caseone");
  git(repo, "push", "-q", "origin", "main");

  // ── Issue #110 review, finding 5: squash merge, the project's actual mode.
  //
  // Documents a known pre-existing limitation, not a regression — behavior is
  // identical before and after this change set. See the test body.
  git(repo, "worktree", "add", "-q", wt("squashed"), "-b", "feature/squashed", "origin/main");
  commit(wt("squashed"), "squashed-work.txt", "shipped");
  git(wt("squashed"), "push", "-q", "-u", "origin", "feature/squashed");
  git(repo, "merge", "-q", "--squash", "feature/squashed");
  git(repo, "commit", "-q", "-m", "squash merge feature/squashed");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/squashed");

  git(repo, "fetch", "-q", "--prune");

  const registry = {
    get_active: () => [{ entity: { id: "fixture-entity", repos: [{ path: repo, url: origin }] } }],
  };
  const alert_router = {
    post_alert: (payload: AlertPayload) => {
      alerts.push(payload);
      return Promise.resolve();
    },
  };

  await sweep_stale_worktrees(registry as unknown as Parameters<typeof sweep_stale_worktrees>[0], {
    alert_router: alert_router as unknown as never,
  });
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The unsafe-skip alert mentioning an absolute path, if any. */
function alert_for_path(path: string): AlertPayload | undefined {
  return alerts.find((a) => a.body.includes(path));
}

/** The reason recorded in the unsafe-skip alert for a given worktree, if any. */
function alert_for(name: string): AlertPayload | undefined {
  return alert_for_path(wt(name));
}

describe("sweep_stale_worktrees against real git — issue #110", () => {
  it("keeps a brand-new worktree whose branch is still at origin/main", () => {
    // Pre-fix this directory was deleted: `git branch --merged main` lists the
    // branch, `origin/feature/fresh` has never existed so the remote looks
    // "gone", and there is nothing uncommitted/untracked/unpushed for the #30
    // guardrail to catch.
    expect(existsSync(wt("fresh"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(wt("fresh"));
  });

  it("keeps a new worktree created at an older trunk commit after main advanced", () => {
    expect(existsSync(wt("oldbase"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(wt("oldbase"));
  });

  it("does not alert about the worktrees it keeps — they are not stale-but-unsafe", () => {
    expect(alert_for("fresh")).toBeUndefined();
    expect(alert_for("oldbase")).toBeUndefined();
  });
});

describe("sweep_stale_worktrees against real git — .claude/worktrees/ wrong-branch deletion", () => {
  // Review finding 1. `cleanup_claude_worktrees` matched directories by
  // substring of the *target* branch's slug and then handed `remove_worktree`
  // that target branch — a branch with no necessary relationship to the
  // directory being destroyed. The fix matches on each directory's own
  // checked-out branch instead, so the name is never consulted.

  it("keeps a brand-new harness worktree whose name merely contains a merged branch's slug", () => {
    expect(existsSync(claude_wt("agent-9c27a1b5"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(claude_wt("agent-9c27a1b5"));
    expect(alert_for_path(claude_wt("agent-9c27a1b5"))).toBeUndefined();
  });

  it("keeps a harness worktree holding unpushed work that a merged branch's slug matched", () => {
    // The wrong-branch handoff defeated #30 outright here: the unpushed check
    // ran against `fix/99` (pushed) while this directory, on an entirely
    // different branch with a never-pushed commit, was the one deleted.
    expect(existsSync(claude_wt("agent-30fe4d82"))).toBe(true);
    expect(existsSync(join(claude_wt("agent-30fe4d82"), "live-agent-work.txt"))).toBe(true);
    // It IS classified stale by the main loop (its remote never existed), and
    // there #30 sees the right branch and blocks with the right reason.
    expect(alert_for_path(claude_wt("agent-30fe4d82"))?.title).toContain("Unpushed");
  });

  it("had genuinely-merged branches to act on, so the directories were spared on their merits", () => {
    // If `fix/27`/`fix/30` were not merged branches with commits of their own,
    // the two cases above would pass for the wrong reason — the sweep would
    // simply never have considered either directory. Asserted against main's
    // log rather than `git branch --merged`, because the branch refs are
    // themselves collateral: pre-fix, destroying these directories deleted
    // them.
    const trunk_log = git(repo, "log", "--oneline", "main");
    expect(trunk_log).toContain("merge fix/27");
    expect(trunk_log).toContain("merge fix/30");
  });
});

describe("sweep_stale_worktrees against real git — .lf-agent-active shield", () => {
  // Review finding 2, and issue #110's "live-session exemption" acceptance
  // criterion. This worktree is sweepable by every other measure; the marker
  // is the whole reason it survives.

  it("keeps a genuinely sweepable worktree that holds the live-agent marker", () => {
    expect(existsSync(wt("marked"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(wt("marked"));
  });

  it("does not alert about a marked worktree — it is held, not stuck", () => {
    expect(alert_for("marked")).toBeUndefined();
  });

  it("keeps the marker's branch intact", () => {
    // `remove_worktree` deletes the branch after removing the directory, so a
    // surviving branch ref is independent evidence it never got that far.
    expect(git(repo, "branch", "--list", "feature/marked")).toContain("feature/marked");
  });
});

describe("sweep_stale_worktrees against real git — genuinely stale worktrees", () => {
  it("still sweeps a merged, pushed, remote-deleted worktree", () => {
    expect(existsSync(wt("merged"))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wt("merged"));
  });

  it("sweeps a merged worktree whose remote branch still exists (Case 1 only)", () => {
    // Review finding 3. `git branch --merged` prefixes "+ " for a branch
    // checked out in another worktree, so this branch arrived as
    // "+ feature/caseone", `merged_branches.has(...)` was always false, and
    // Case 1 was dead for every worktree-held branch. Nothing else can reach
    // this fixture: its remote ref is intact, so Case 2 does not fire.
    expect(git(repo, "rev-parse", "--verify", "refs/remotes/origin/feature/caseone")).toBeTruthy();
    expect(existsSync(wt("caseone"))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wt("caseone"));
  });
});

describe("sweep_stale_worktrees against real git — known limitation: squash merge", () => {
  it("does NOT sweep a squash-merged worktree, and alerts about it every run", () => {
    // Review finding 5. This project merges with `gh pr merge --squash`, which
    // rewrites the branch's commit into a new one on main. The branch's own
    // commit is then unreachable from every remote ref, so #30 reports it
    // unpushed and blocks the removal — forever, re-alerting on every hourly
    // sweep. Pre-existing and unchanged by this work (already logged in
    // MEMORY.md as the healthydogs alert-spam gap); asserted here so the
    // limitation lives in the suite instead of only in a memory file.
    expect(existsSync(wt("squashed"))).toBe(true);
    expect(alert_for("squashed")?.title).toContain("Unpushed");
  });
});

describe("sweep_stale_worktrees against real git — #30 safety preconditions", () => {
  it("still refuses to remove a worktree with unpushed commits", () => {
    expect(existsSync(wt("unpushed"))).toBe(true);
    expect(alert_for("unpushed")?.title).toContain("Unpushed");
  });

  it("still refuses to remove a stale worktree holding untracked files", () => {
    expect(existsSync(wt("untracked"))).toBe(true);
    expect(alert_for("untracked")?.title).toContain("Untracked");
  });

  it("still refuses to remove a stale worktree holding uncommitted changes", () => {
    expect(existsSync(wt("dirty"))).toBe(true);
    expect(alert_for("dirty")?.title).toContain("Uncommitted");
  });
});
