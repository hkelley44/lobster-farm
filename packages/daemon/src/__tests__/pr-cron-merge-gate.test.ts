/**
 * Merge-gate regression tests for the cron path (#102 Gap 1).
 *
 * The #98 race auto-merged a PR while a *separately-spawned* reviewer was still
 * working and about to request changes. The per-PR review lease (#60) was meant
 * to make that impossible, but it only gated the reviewer *spawn* — the merge
 * itself ran with no lease held. These tests pin the fix: every cron merge site
 * now passes through `assert_can_merge`, so an auto-merge cannot fire unless the
 * live lease for that PR is held by the cron.
 */

import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRReviewCron } from "../pr-cron.js";
import { ReviewLeaseStore } from "../review-lease.js";

// ── Mocks ──

vi.mock("../persistence.js", () => ({
  load_pr_reviews: vi.fn().mockResolvedValue({}),
  save_pr_reviews: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  cronCheckInStart: vi.fn(() => "checkin-id"),
  cronCheckInFinish: vi.fn(),
}));

vi.mock("../review-utils.js", () => ({
  attempt_auto_merge: vi.fn().mockResolvedValue({ merged: true, method: "direct" }),
  check_ci_status: vi.fn().mockResolvedValue({ passed: true, pending: false, failures: [] }),
  fetch_review_comments: vi.fn().mockResolvedValue("review comments"),
  build_review_fix_prompt: vi.fn().mockReturnValue("fix prompt"),
  fetch_ci_failure_logs: vi.fn().mockResolvedValue([]),
  build_ci_fix_prompt: vi.fn().mockReturnValue("ci fix prompt"),
  get_authenticated_login: vi.fn().mockResolvedValue("botuser"),
  count_verdict_comments: vi.fn().mockResolvedValue(0),
  count_reviews_by_login: vi.fn().mockResolvedValue(0),
  MAX_CI_FIX_ATTEMPTS: 3,
}));

import { attempt_auto_merge } from "../review-utils.js";

// ── Fixtures ──

const ENTITY_ID = "test-entity";
const REPO_PATH = "/tmp/test-repo";
const REPO_URL = "https://github.com/test-org/test-repo.git";
const OWNER_REPO = "test-org/test-repo";
const AUTHOR = "botuser"; // internal author == entity github user

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
}

function make_entity(): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: ENTITY_ID,
      name: "Test Entity",
      status: "active",
      repos: [{ name: "test-repo", url: REPO_URL, path: REPO_PATH }],
      accounts: { github: { user: AUTHOR } },
      channels: { category_id: "cat-1", list: [] },
      memory: { path: "/tmp/memory" },
      secrets: { vault: "1password", vault_name: "test" },
    },
  });
}

const PR = {
  number: 42,
  title: "internal feature",
  headRefName: "feature/42-x",
  updatedAt: "2026-07-30T10:00:00Z",
  url: "https://github.com/test-org/test-repo/pull/42",
  body: "Closes #1",
  author: { login: AUTHOR },
  isDraft: false,
};

/** Cron with a lease store, exposing the private merge paths + a stubbed merge check. */
class TestCron extends PRReviewCron {
  constructor(leases: ReviewLeaseStore | null) {
    super(
      { get: () => make_entity(), get_active: () => [make_entity()] } as never,
      { spawn: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
      make_config(),
      null,
      null,
      null,
      { post_alert: vi.fn().mockResolvedValue({ message_id: null }) } as never,
      leases,
    );
    // The reviewer never self-merges now — the PR is always unmerged when the
    // daemon's gated merge runs.
    (this as unknown as { check_pr_merged: () => Promise<boolean> }).check_pr_merged = vi
      .fn()
      .mockResolvedValue(false);
  }

  get alerts(): Array<{ title: string; body: string }> {
    return (
      this as unknown as {
        alert_router: { post_alert: { mock: { calls: [{ title: string }][] } } };
      }
    ).alert_router.post_alert.mock.calls.map((c) => c[0] as { title: string; body: string });
  }

  run_handle_completion(review_session_id?: string): Promise<void> {
    const fn = (
      this as unknown as {
        handle_review_completion: (
          e: string,
          p: string,
          pr: typeof PR,
          o: string,
          t?: string,
          v?: string,
          sid?: string,
        ) => Promise<void>;
      }
    ).handle_review_completion.bind(this);
    return fn(ENTITY_ID, REPO_PATH, PR, "approved", undefined, undefined, review_session_id);
  }

  run_retry(processed_approved: boolean): Promise<void> {
    if (processed_approved) {
      (this as unknown as { processed: Record<string, unknown> }).processed[
        `${ENTITY_ID}:${String(PR.number)}`
      ] = {
        entity_id: ENTITY_ID,
        pr_number: PR.number,
        reviewed_at: "2026-07-30T09:00:00Z",
        outcome: "approved",
      };
    }
    const fn = (
      this as unknown as {
        retry_approved_unmerged: (
          e: string,
          p: string,
          prs: (typeof PR)[],
          cfg: EntityConfig,
        ) => Promise<void>;
      }
    ).retry_approved_unmerged.bind(this);
    return fn(ENTITY_ID, REPO_PATH, [PR], make_entity());
  }
}

describe("PR cron merge gate (#102)", () => {
  let log_spy: ReturnType<typeof vi.spyOn>;
  let warn_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(attempt_auto_merge).mockClear();
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
    warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    log_spy.mockRestore();
    warn_spy.mockRestore();
  });

  it("does NOT auto-merge while another review lease is active", async () => {
    // Regression for #98: a different origin (Tidus's manual review) holds the
    // lease. An approved outcome routed as the cron must NOT merge.
    const leases = new ReviewLeaseStore();
    leases.acquire(OWNER_REPO, PR.number, "tidus-manual");

    const cron = new TestCron(leases);
    await cron.run_handle_completion();

    expect(attempt_auto_merge).not.toHaveBeenCalled();
    expect(cron.alerts.some((a) => a.title.includes("Merge gate blocked"))).toBe(true);
    // The other holder's lease is untouched.
    expect(leases.get(OWNER_REPO, PR.number)?.holder).toBe("tidus-manual");
  });

  it("does NOT auto-merge when no lease is held at all", async () => {
    // A merge originating from a path that holds no lease is blocked.
    const leases = new ReviewLeaseStore();

    const cron = new TestCron(leases);
    await cron.run_handle_completion();

    expect(attempt_auto_merge).not.toHaveBeenCalled();
    expect(cron.alerts.some((a) => a.title.includes("Merge gate blocked"))).toBe(true);
  });

  it("DOES auto-merge when the cron holds the live lease", async () => {
    // The normal happy path: the cron acquired daemon-cron in review_pr and
    // still holds it through the merge (release moved to on_complete's finally).
    const leases = new ReviewLeaseStore();
    leases.acquire(OWNER_REPO, PR.number, "daemon-cron");

    const cron = new TestCron(leases);
    await cron.run_handle_completion();

    expect(attempt_auto_merge).toHaveBeenCalledTimes(1);
  });

  it("fail-open: with no lease store, merge proceeds unchanged (legacy/test)", async () => {
    const cron = new TestCron(null);
    await cron.run_handle_completion();

    expect(attempt_auto_merge).toHaveBeenCalledTimes(1);
  });

  it("retry pass defers the merge while another holder's lease is live", async () => {
    const leases = new ReviewLeaseStore();
    leases.acquire(OWNER_REPO, PR.number, "daemon-webhook");

    const cron = new TestCron(leases);
    await cron.run_retry(true);

    expect(attempt_auto_merge).not.toHaveBeenCalled();
    // The webhook's lease is left intact — retry backed off, didn't steal it.
    expect(leases.get(OWNER_REPO, PR.number)?.holder).toBe("daemon-webhook");
  });

  it("retry pass merges when free, then releases the lease it acquired", async () => {
    const leases = new ReviewLeaseStore();

    const cron = new TestCron(leases);
    await cron.run_retry(true);

    expect(attempt_auto_merge).toHaveBeenCalledTimes(1);
    // The retry-scoped lease is released after the merge — no lingering hold.
    expect(leases.get(OWNER_REPO, PR.number)).toBeNull();
  });

  it("retry pass does NOT double-merge while a daemon-cron on_complete merge is in flight", async () => {
    // #102 review follow-up: on_complete deletes the active_reviews entry
    // synchronously but holds the daemon-cron lease until its post-merge
    // .finally(). If a retry tick fires in that window, a blind idempotent
    // acquire of the same-holder lease would fire a SECOND concurrent merge and
    // then release the lease out from under the still-running one. The retry
    // must defer when ANY live lease exists — even its own holder's.
    const leases = new ReviewLeaseStore();
    leases.acquire(OWNER_REPO, PR.number, "daemon-cron"); // simulates in-flight on_complete

    const cron = new TestCron(leases);
    await cron.run_retry(true);

    expect(attempt_auto_merge).not.toHaveBeenCalled();
    // The in-flight merge's lease is left intact — retry didn't steal or release it.
    expect(leases.get(OWNER_REPO, PR.number)?.holder).toBe("daemon-cron");
  });

  // ── #102 review follow-up: the gate checks the session id, not just the holder ──

  it("blocks the merge when the live lease is the SAME holder but a DIFFERENT session", async () => {
    // A daemon-cron lease exists, but it belongs to a different review session
    // than the one now completing. The gate must prove ownership by session id,
    // not merely by holder — otherwise a stale/other daemon-cron lease would let
    // this completion merge a PR it doesn't actually own.
    const leases = new ReviewLeaseStore();
    leases.acquire(OWNER_REPO, PR.number, "daemon-cron", { session_id: "review-OTHER" });

    const cron = new TestCron(leases);
    await cron.run_handle_completion("review-MINE");

    expect(attempt_auto_merge).not.toHaveBeenCalled();
    expect(cron.alerts.some((a) => a.title.includes("Merge gate blocked"))).toBe(true);
  });

  it("merges when the live lease matches BOTH the holder and the review's session", async () => {
    const leases = new ReviewLeaseStore();
    leases.acquire(OWNER_REPO, PR.number, "daemon-cron", { session_id: "review-MINE" });

    const cron = new TestCron(leases);
    await cron.run_handle_completion("review-MINE");

    expect(attempt_auto_merge).toHaveBeenCalledTimes(1);
  });
});
