/**
 * Daemon-owned staging → main promotion (#104).
 *
 * Closes the one documented exception to the "single daemon-owned merge
 * chokepoint" guarantee from #102. Before this module, `pr-review-merge` SOP
 * step 4a.next told Tidus to run the promotion commands by hand — the only
 * merge path left where an *agent* was the actor. All repos are main-only
 * today, so nothing live exercised it, but the exception had to close before
 * any entity adopts a staging branch.
 *
 * ## Why the daemon performs the promotion rather than the agent
 *
 * The alternative considered in #104 was to add a fourth `LeaseHolder` for the
 * staging path and have the agent call `assert_can_merge` before promoting by
 * hand. That does not work, for two independent reasons:
 *
 *  1. **The lease has a 20-minute TTL.** A staging promotion happens after
 *     Hunter has *manually tested* the staging deploy — hours or days after the
 *     review that produced the lease. There is never a live review lease left
 *     to assert against at promotion time, so the gate would either refuse
 *     forever or have to be skipped.
 *  2. **An agent that acquires its own lease is not gated by it.** If the agent
 *     both takes the lease and performs the merge, it is subject and gatekeeper
 *     at once — the lease stops being a mutex against the agent and becomes a
 *     formality it grants itself.
 *
 * So the promotion moves into the daemon, exactly like the cron/webhook merges
 * of #102. The caller (the HTTP route) acquires a `daemon-staging` lease and
 * releases it; this function **asserts** the lease via `assert_can_merge`
 * before touching a single git ref. A caller that forgets to acquire is
 * refused with `lease_not_held` — the refusal lives here, not in the caller, so
 * it cannot be forgotten at a call site.
 *
 * Acquiring a real lease is what serializes the promotion against concurrent
 * work: if the cron or webhook is mid-review on that PR, the acquire collides
 * (409) and the promotion defers rather than racing a review. That is the same
 * property #102 bought for autonomous merges, now extended to staging. The
 * reason it matters is on the record: on PR #86 two racing reviewers produced a
 * false APPROVE over a live bot-token exfil hole, which is why merges are
 * funnelled through one gate at all.
 *
 * ## Human sign-off is still the trigger
 *
 * Moving the *actor* into the daemon must not turn the promotion into an
 * *automatic* one — that would satisfy "goes through the chokepoint" while
 * destroying the thing step 4a actually protects. There is deliberately no
 * timer, no cron pass, and no event that reaches this function: the only way in
 * is an explicit `signoff` naming the human who approved. Absent or
 * unrecognised sign-off is refused before any git command runs.
 *
 * The sign-off is an **intent relay, not an authentication mechanism**. The
 * daemon trusts its localhost callers (as every other route here does); what
 * this gate proves is that a human decision was explicitly relayed, not that
 * the relay was cryptographically Hunter. See the README note.
 *
 * ## Promotion mechanics
 *
 * SOP 4a.next describes `checkout main` + `merge --ff-only` + `push`. This
 * implements the same guarantee without mutating a working tree: resolve both
 * remote refs, verify `origin/main` is an ancestor of `origin/staging`, then
 * push `origin/staging` straight at `refs/heads/main`. A plain (non-`--force`)
 * push is rejected by the remote on a non-fast-forward, so fast-forward-only is
 * enforced twice — locally by the ancestry check (which yields a precise
 * `diverged` outcome to escalate on) and remotely by the push itself.
 *
 * Every git invocation uses `git -C <path>` — never `cd <path> && git ...`,
 * which trips the Claude Code bare-repo backstop and crash-loops pool bots
 * (see the `pr-review-merge` SOP's "Critical" callout).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type ReviewLease, type ReviewLeaseStore, assert_can_merge } from "./review-lease.js";

const exec_async = promisify(execFile);

// ── Types ──

/**
 * Evidence that a human approved this promotion. Built by the route from the
 * request body; never synthesized by the daemon itself.
 */
export interface StagingSignoff {
  /** Display name of the human who approved (matched against config.user.name). */
  approved_by: string;
  /** When the sign-off was given, ISO 8601. Recorded for the audit trail. */
  approved_at: string;
  /** Where the sign-off was observed — e.g. a Discord message link. */
  source: string;
}

export interface StagingPromotionInput {
  /** GitHub slug, e.g. "hkelley44/lobster-farm". The lease key. */
  owner_repo: string;
  /** The PR whose feature is being promoted. Identifies the lease. */
  pr_number: number;
  /** Local clone the git commands run against. */
  repo_path: string;
  /** GitHub installation token, exported as GH_TOKEN for git's credential helper. */
  gh_token: string;
  /** Human sign-off. Promotion is refused outright without a valid one. */
  signoff: StagingSignoff;
  /**
   * Names permitted to sign off — normally `[config.user.name]`. Empty means
   * nobody can promote; it is never treated as "allow all".
   */
  authorized_approvers: readonly string[];
  /** Lease store for the chokepoint assertion. */
  review_leases: ReviewLeaseStore | null;
  /**
   * Session id of the acquired `daemon-staging` lease. Proves this promotion
   * belongs to the specific acquisition that authorized it.
   */
  lease_session_id?: string;
}

/**
 * Outcome of a promotion attempt. Tagged so the route can map precisely onto
 * HTTP status codes and alert tiers.
 *
 * - `promoted` — `main` fast-forwarded to the staging SHA.
 * - `signoff_missing` — no human sign-off supplied. The anti-automation gate.
 * - `signoff_unauthorized` — sign-off named someone not on the approver list.
 * - `lease_not_held` — the `daemon-staging` lease is not held by this caller.
 *   The chokepoint refusal: another review/merge is in flight, or the caller
 *   never acquired. Never promote on this outcome.
 * - `no_staging_branch` — `origin/staging` does not exist, so 4a does not
 *   apply to this repo at all (it is a main-only repo, SOP 4b).
 * - `already_current` — `main` already points at the staging SHA. Nothing to
 *   do; a duplicate sign-off relay is a no-op rather than an error.
 * - `diverged` — `main` has commits `staging` does not contain, so no
 *   fast-forward is possible. SOP 4a.next says escalate, never merge-commit,
 *   rebase, or force-push.
 * - `git_failed` — a git command failed unexpectedly (fetch, rev-parse).
 * - `push_failed` — the fast-forward push itself was rejected. Includes the
 *   remote's non-fast-forward rejection if `main` moved between the ancestry
 *   check and the push.
 */
export type StagingPromotionOutcome =
  | { kind: "promoted"; main_sha: string; previous_main_sha: string }
  | { kind: "signoff_missing"; reason: string }
  | { kind: "signoff_unauthorized"; approved_by: string }
  | { kind: "lease_not_held"; current_lease: ReviewLease | null }
  | { kind: "no_staging_branch" }
  | { kind: "already_current"; main_sha: string }
  | { kind: "diverged"; main_sha: string; staging_sha: string }
  | { kind: "git_failed"; error: string }
  | { kind: "push_failed"; error: string };

// ── Public entrypoint ──

/**
 * Promote `origin/staging` to `origin/main` for a repo that uses the staging
 * gate. Refuses unless (a) a recognised human signed off and (b) the caller
 * holds the live `daemon-staging` lease for this PR.
 *
 * The order of checks is deliberate: sign-off first, then the lease, then any
 * git side effect. A refused promotion must never have touched a ref, and must
 * never have spent a `git fetch` on an unauthorized request.
 *
 * `deps` exists for tests; production callers pass nothing.
 */
export async function run_staging_promotion(
  input: StagingPromotionInput,
  deps: StagingPromotionDeps = default_deps,
): Promise<StagingPromotionOutcome> {
  const { owner_repo, pr_number, repo_path, gh_token, signoff } = input;

  // ── Gate 1: human sign-off ──
  //
  // This is what keeps the promotion manual. Nothing in the daemon constructs a
  // StagingSignoff on its own, so there is no path from a timer or an event to
  // a promotion — only from an explicit relay of Hunter's decision.
  const signoff_check = validate_signoff(signoff, input.authorized_approvers);
  if (signoff_check) return signoff_check;

  // ── Gate 2: the merge chokepoint (#102) ──
  //
  // Asserted here rather than trusted from the caller, so a future call site
  // that forgets to acquire gets refused instead of silently promoting.
  if (
    !assert_can_merge(
      input.review_leases,
      owner_repo,
      pr_number,
      "daemon-staging",
      input.lease_session_id,
    )
  ) {
    return {
      kind: "lease_not_held",
      current_lease: input.review_leases?.get(owner_repo, pr_number) ?? null,
    };
  }

  // ── Both gates passed: resolve refs ──
  const env = { ...process.env, GH_TOKEN: gh_token };

  try {
    await deps.fetch_origin(repo_path, env);
  } catch (err) {
    return { kind: "git_failed", error: `git fetch failed: ${error_message(err)}` };
  }

  let staging_sha: string | null;
  let main_sha: string | null;
  try {
    staging_sha = await deps.rev_parse("refs/remotes/origin/staging", repo_path, env);
    main_sha = await deps.rev_parse("refs/remotes/origin/main", repo_path, env);
  } catch (err) {
    return { kind: "git_failed", error: `git rev-parse failed: ${error_message(err)}` };
  }

  // Branch existence is the only signal for "does the staging gate apply"
  // (SOP step 4). No staging branch → this is a 4b repo, not ours to promote.
  if (!staging_sha) return { kind: "no_staging_branch" };
  if (!main_sha) {
    return { kind: "git_failed", error: "origin/main does not resolve — refusing to promote" };
  }

  // Idempotence: a re-relayed sign-off (Hunter says ✅ twice, or the route is
  // retried) must not be an error.
  if (staging_sha === main_sha) return { kind: "already_current", main_sha };

  // ── Fast-forward-only check ──
  //
  // SOP 4a.next is explicit: ff-only, and escalate on divergence. Don't merge
  // with a merge commit, don't rebase, don't force-push.
  let can_fast_forward: boolean;
  try {
    can_fast_forward = await deps.is_ancestor(main_sha, staging_sha, repo_path, env);
  } catch (err) {
    return { kind: "git_failed", error: `git merge-base failed: ${error_message(err)}` };
  }
  if (!can_fast_forward) return { kind: "diverged", main_sha, staging_sha };

  // ── Promote ──
  //
  // A non-forced push is rejected remotely on a non-fast-forward, so this stays
  // ff-only even if `main` moved since the ancestry check above.
  try {
    await deps.push_fast_forward(staging_sha, "main", repo_path, env);
  } catch (err) {
    return { kind: "push_failed", error: `git push failed: ${error_message(err)}` };
  }

  return { kind: "promoted", main_sha: staging_sha, previous_main_sha: main_sha };
}

// ── Internal helpers ──

/**
 * Reject a promotion that carries no usable human sign-off. Returns the
 * refusal outcome, or null when the sign-off is acceptable.
 *
 * An empty approver list refuses everything. That is the safe direction: a
 * misconfigured daemon must not promote, and "no approvers configured" must
 * never degrade into "anyone may approve".
 */
function validate_signoff(
  signoff: StagingSignoff | undefined,
  authorized_approvers: readonly string[],
): StagingPromotionOutcome | null {
  if (!signoff) {
    return { kind: "signoff_missing", reason: "no signoff supplied" };
  }
  const approved_by = signoff.approved_by?.trim() ?? "";
  if (!approved_by) {
    return { kind: "signoff_missing", reason: "signoff.approved_by is empty" };
  }
  if (!signoff.approved_at?.trim()) {
    return { kind: "signoff_missing", reason: "signoff.approved_at is empty" };
  }
  if (!signoff.source?.trim()) {
    return { kind: "signoff_missing", reason: "signoff.source is empty" };
  }

  const permitted = authorized_approvers.some(
    (name) => name.trim().toLowerCase() === approved_by.toLowerCase(),
  );
  if (!permitted) {
    return { kind: "signoff_unauthorized", approved_by };
  }
  return null;
}

function error_message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Dependency injection seam ──

type GitEnv = NodeJS.ProcessEnv;

/**
 * Git operations the promotion needs, broken out so tests can stub them
 * without a real repo. Production callers use `default_deps`.
 */
export interface StagingPromotionDeps {
  fetch_origin: (repo_path: string, env: GitEnv) => Promise<void>;
  /** Resolve a ref to a SHA, or null when the ref does not exist. */
  rev_parse: (ref: string, repo_path: string, env: GitEnv) => Promise<string | null>;
  /** True when `ancestor` is reachable from `descendant`. */
  is_ancestor: (
    ancestor: string,
    descendant: string,
    repo_path: string,
    env: GitEnv,
  ) => Promise<boolean>;
  /** Push `sha` to `refs/heads/<branch>` on origin, without --force. */
  push_fast_forward: (sha: string, branch: string, repo_path: string, env: GitEnv) => Promise<void>;
}

const GIT_TIMEOUT_MS = 60_000;

async function default_fetch_origin(repo_path: string, env: GitEnv): Promise<void> {
  // Explicit wildcard refspec rather than a bare `fetch origin`, which would
  // honour the clone's *configured* refspec. A single-branch clone
  // (`clone --single-branch`, as `try_local_rebase` creates) restricts that to
  // one branch, so `refs/remotes/origin/staging` would never materialize and we
  // would wrongly report `no_staging_branch` for a repo that does have one.
  // Spelling the refspec out also guarantees staging's objects are local, which
  // `merge-base --is-ancestor` needs. Harmless when staging doesn't exist.
  await exec_async(
    "git",
    ["-C", repo_path, "fetch", "origin", "--prune", "+refs/heads/*:refs/remotes/origin/*"],
    { env, timeout: GIT_TIMEOUT_MS },
  );
}

async function default_rev_parse(
  ref: string,
  repo_path: string,
  env: GitEnv,
): Promise<string | null> {
  try {
    const { stdout } = await exec_async("git", ["-C", repo_path, "rev-parse", "--verify", ref], {
      env,
      timeout: GIT_TIMEOUT_MS,
    });
    const sha = stdout.trim();
    return sha === "" ? null : sha;
  } catch {
    // `rev-parse --verify` exits non-zero for a ref that doesn't exist. That's
    // the "no staging branch" signal, not a failure.
    return null;
  }
}

async function default_is_ancestor(
  ancestor: string,
  descendant: string,
  repo_path: string,
  env: GitEnv,
): Promise<boolean> {
  try {
    await exec_async(
      "git",
      ["-C", repo_path, "merge-base", "--is-ancestor", ancestor, descendant],
      {
        env,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    return true;
  } catch {
    // Exit 1 means "not an ancestor" — a real answer, not an error.
    return false;
  }
}

async function default_push_fast_forward(
  sha: string,
  branch: string,
  repo_path: string,
  env: GitEnv,
): Promise<void> {
  // No --force, no --force-with-lease: a plain push is what makes the remote
  // reject a non-fast-forward for us.
  await exec_async("git", ["-C", repo_path, "push", "origin", `${sha}:refs/heads/${branch}`], {
    env,
    timeout: GIT_TIMEOUT_MS,
  });
}

export const default_deps: StagingPromotionDeps = {
  fetch_origin: default_fetch_origin,
  rev_parse: default_rev_parse,
  is_ancestor: default_is_ancestor,
  push_fast_forward: default_push_fast_forward,
};
