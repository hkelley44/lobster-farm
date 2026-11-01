import { describe, expect, it } from "vitest";
import { ReviewLeaseStore } from "../review-lease.js";
import {
  type StagingPromotionDeps,
  type StagingPromotionInput,
  type StagingSignoff,
  run_staging_promotion,
} from "../staging-promotion.js";

// Unit coverage for the #104 staging-gate chokepoint.
//
// The property under test is the one #104 exists to establish: a staging
// promotion cannot happen unless (a) a human signed off and (b) the caller
// holds the daemon-staging lease. Both refusals must land BEFORE any git
// command runs — a refused promotion that already spent a `git fetch`, or
// worse reached the push, would be a gate in name only. So every negative test
// asserts on the recorded git call list, not just the outcome tag.

const OWNER_REPO = "hkelley44/lobster-farm";
const PR = 104;
const MAIN_SHA = "1111111111111111111111111111111111111111";
const STAGING_SHA = "2222222222222222222222222222222222222222";
const APPROVER = "Hunter";

const VALID_SIGNOFF: StagingSignoff = {
  approved_by: APPROVER,
  approved_at: "2026-10-31T12:00:00Z",
  source: "discord://alerts/message/123",
};

interface Recorder {
  calls: string[];
  deps: StagingPromotionDeps;
}

/**
 * Deps that record every git invocation. Default scenario: `staging` is ahead
 * of `main` and a fast-forward is possible — i.e. the happy path, so that any
 * refusal a test observes is caused by the gate under test rather than by the
 * repo state.
 */
function tracking_deps(overrides: Partial<StagingPromotionDeps> = {}): Recorder {
  const calls: string[] = [];
  const deps: StagingPromotionDeps = {
    fetch_origin: async () => {
      calls.push("fetch");
    },
    rev_parse: async (ref) => {
      calls.push(`rev-parse ${ref}`);
      if (ref.endsWith("staging")) return STAGING_SHA;
      if (ref.endsWith("main")) return MAIN_SHA;
      return null;
    },
    is_ancestor: async (ancestor, descendant) => {
      calls.push(`is-ancestor ${ancestor}..${descendant}`);
      return true;
    },
    push_fast_forward: async (sha, branch) => {
      calls.push(`push ${sha}:${branch}`);
    },
    ...overrides,
  };
  return { calls, deps };
}

function base_input(overrides: Partial<StagingPromotionInput> = {}): StagingPromotionInput {
  return {
    owner_repo: OWNER_REPO,
    pr_number: PR,
    repo_path: "/tmp/does-not-matter-deps-are-stubbed",
    gh_token: "test-token-not-a-secret",
    signoff: VALID_SIGNOFF,
    authorized_approvers: [APPROVER],
    review_leases: null,
    ...overrides,
  };
}

/** A store with a live daemon-staging lease held under `session_id`. */
function store_holding_staging_lease(session_id: string): ReviewLeaseStore {
  const store = new ReviewLeaseStore();
  const result = store.acquire(OWNER_REPO, PR, "daemon-staging", { session_id });
  expect(result.ok).toBe(true);
  return store;
}

describe("run_staging_promotion — the lease chokepoint (#104)", () => {
  it("REFUSES to promote when the daemon-staging lease is not held", async () => {
    // An empty store means nobody acquired. This is the regression the whole
    // issue is about: before #104 the promotion ran agent-side with no lease
    // involved at all.
    const store = new ReviewLeaseStore();
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome.kind).toBe("lease_not_held");
    // The gate must short-circuit before any git side effect — including the
    // read-only fetch.
    expect(calls).toEqual([]);
  });

  it("PROMOTES when the daemon-staging lease is held", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome).toEqual({
      kind: "promoted",
      main_sha: STAGING_SHA,
      previous_main_sha: MAIN_SHA,
    });
    // And it actually pushed staging's SHA at main, fast-forward only.
    expect(calls).toContain(`push ${STAGING_SHA}:main`);
  });

  it("refuses when a DIFFERENT holder owns the lease — a review is in flight", async () => {
    // This is the #102 property extended to staging: the cron is mid-review on
    // this PR, so the promotion must defer rather than race it. On PR #86 two
    // racing reviewers produced a false APPROVE over a live token-exfil hole;
    // that is why merges funnel through one gate.
    const store = new ReviewLeaseStore();
    store.acquire(OWNER_REPO, PR, "daemon-cron", { session_id: "review-7" });
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome.kind).toBe("lease_not_held");
    if (outcome.kind === "lease_not_held") {
      expect(outcome.current_lease?.holder).toBe("daemon-cron");
    }
    expect(calls).toEqual([]);
  });

  it("refuses when the lease belongs to a DIFFERENT promotion session", async () => {
    // Guards the #102 delete-vs-release window: a stale daemon-staging lease
    // from an earlier promotion must not be piggybacked by a new one.
    const store = store_holding_staging_lease("promote-OLD");
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-NEW" }),
      deps,
    );

    expect(outcome.kind).toBe("lease_not_held");
    expect(calls).toEqual([]);
  });

  it("fails open when there is no store at all (#102 contract)", async () => {
    // Deliberate and consistent with assert_can_merge everywhere else: a
    // degraded/absent lease store must never permanently wedge merges. Pinned
    // by a test so it stays a decision rather than drifting into an accident.
    const { deps } = tracking_deps();
    const outcome = await run_staging_promotion(
      base_input({ review_leases: null, lease_session_id: "promote-1" }),
      deps,
    );
    expect(outcome.kind).toBe("promoted");
  });
});

describe("run_staging_promotion — human sign-off is still the trigger (#104)", () => {
  // Moving the actor into the daemon must not make the promotion automatic.
  // These tests are the negative that matters: without an explicit, recognised
  // human sign-off there is no promotion, even with the lease held.

  it("REFUSES with no sign-off, even holding the lease", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({
        review_leases: store,
        lease_session_id: "promote-1",
        // Simulates any caller (or future code path) that reaches the promotion
        // without a human decision behind it.
        signoff: undefined as unknown as StagingSignoff,
      }),
      deps,
    );

    expect(outcome.kind).toBe("signoff_missing");
    expect(calls).toEqual([]);
  });

  it.each([
    ["approved_by", { ...VALID_SIGNOFF, approved_by: "   " }],
    ["approved_at", { ...VALID_SIGNOFF, approved_at: "" }],
    ["source", { ...VALID_SIGNOFF, source: "" }],
  ])("refuses a partial sign-off missing %s", async (_field, signoff) => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1", signoff }),
      deps,
    );

    expect(outcome.kind).toBe("signoff_missing");
    expect(calls).toEqual([]);
  });

  it("refuses a sign-off from someone not on the approver list", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({
        review_leases: store,
        lease_session_id: "promote-1",
        signoff: { ...VALID_SIGNOFF, approved_by: "Ben" },
      }),
      deps,
    );

    expect(outcome.kind).toBe("signoff_unauthorized");
    if (outcome.kind === "signoff_unauthorized") {
      expect(outcome.approved_by).toBe("Ben");
    }
    expect(calls).toEqual([]);
  });

  it("refuses everything when the approver list is EMPTY (never allow-all)", async () => {
    // A misconfigured daemon must fail closed on this gate specifically. Note
    // this is the opposite direction from the lease store's fail-open — and
    // intentionally so: an absent lease store is a liveness concern, while an
    // empty approver list would otherwise mean "promotions need no human".
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({
        review_leases: store,
        lease_session_id: "promote-1",
        authorized_approvers: [],
      }),
      deps,
    );

    expect(outcome.kind).toBe("signoff_unauthorized");
    expect(calls).toEqual([]);
  });

  it("matches the approver case-insensitively", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({
        review_leases: store,
        lease_session_id: "promote-1",
        signoff: { ...VALID_SIGNOFF, approved_by: "hunter" },
      }),
      deps,
    );

    expect(outcome.kind).toBe("promoted");
  });

  it("checks sign-off BEFORE the lease — an unauthorized caller learns nothing about lease state", async () => {
    const store = new ReviewLeaseStore();
    const { calls, deps } = tracking_deps();

    const outcome = await run_staging_promotion(
      base_input({
        review_leases: store,
        lease_session_id: "promote-1",
        signoff: { ...VALID_SIGNOFF, approved_by: "nobody" },
      }),
      deps,
    );

    expect(outcome.kind).toBe("signoff_unauthorized");
    expect(calls).toEqual([]);
  });
});

describe("run_staging_promotion — fast-forward-only semantics (#104)", () => {
  it("refuses and reports divergence when main is not an ancestor of staging", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps({ is_ancestor: async () => false });

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome).toEqual({ kind: "diverged", main_sha: MAIN_SHA, staging_sha: STAGING_SHA });
    // SOP 4a.next: escalate on divergence. Never merge-commit, rebase, or
    // force-push — so no push may have been attempted.
    expect(calls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("reports no_staging_branch for a main-only repo (SOP 4b)", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps({
      rev_parse: async (ref) => (ref.endsWith("staging") ? null : MAIN_SHA),
    });

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome.kind).toBe("no_staging_branch");
    expect(calls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("is idempotent — a re-relayed sign-off when main already matches staging", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps({ rev_parse: async () => STAGING_SHA });

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome).toEqual({ kind: "already_current", main_sha: STAGING_SHA });
    expect(calls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("surfaces a rejected push rather than escalating privileges", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { deps } = tracking_deps({
      push_fast_forward: async () => {
        throw new Error("! [rejected] main -> main (non-fast-forward)");
      },
    });

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome.kind).toBe("push_failed");
    if (outcome.kind === "push_failed") {
      expect(outcome.error).toContain("non-fast-forward");
    }
  });

  it("reports git_failed when fetch blows up, without pushing", async () => {
    const store = store_holding_staging_lease("promote-1");
    const { calls, deps } = tracking_deps({
      fetch_origin: async () => {
        throw new Error("could not read from remote");
      },
    });

    const outcome = await run_staging_promotion(
      base_input({ review_leases: store, lease_session_id: "promote-1" }),
      deps,
    );

    expect(outcome.kind).toBe("git_failed");
    expect(calls.some((c) => c.startsWith("push"))).toBe(false);
  });
});
