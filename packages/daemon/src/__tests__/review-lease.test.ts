import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LEASE_TTL_MS, ReviewLeaseStore, is_lease_holder } from "../review-lease.js";

const OWNER_REPO = "hkelley44/lobster-farm";
const PR = 60;

describe("ReviewLeaseStore — state machine", () => {
  let store: ReviewLeaseStore;

  beforeEach(() => {
    store = new ReviewLeaseStore();
  });

  it("acquires a fresh lease when none exists", () => {
    const result = store.acquire(OWNER_REPO, PR, "daemon-cron");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lease.owner_repo).toBe(OWNER_REPO);
      expect(result.lease.pr_number).toBe(PR);
      expect(result.lease.holder).toBe("daemon-cron");
      expect(result.lease.acquired_at).toBeTruthy();
      expect(result.lease.expires_at).toBeTruthy();
    }
  });

  it("conflicts when a different holder owns a live lease", () => {
    store.acquire(OWNER_REPO, PR, "daemon-cron");
    const result = store.acquire(OWNER_REPO, PR, "tidus-manual");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The conflict surfaces the *current* holder so callers can report it.
      expect(result.current_lease.holder).toBe("daemon-cron");
    }
  });

  it("is idempotent for the same holder — returns existing lease, does NOT extend", () => {
    const first = store.acquire(OWNER_REPO, PR, "daemon-cron");
    expect(first.ok).toBe(true);
    const original_expiry = first.ok ? first.lease.expires_at : "";

    // Advance time, then re-acquire as the same holder. The lease must come back
    // unchanged — re-acquiring is not a way to extend the hold.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    const second = store.acquire(OWNER_REPO, PR, "daemon-cron");
    vi.useRealTimers();

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.lease.expires_at).toBe(original_expiry);
      expect(second.lease.acquired_at).toBe(first.ok ? first.lease.acquired_at : "");
    }
  });

  it("releases a lease held by the same holder", () => {
    store.acquire(OWNER_REPO, PR, "daemon-cron");
    expect(store.release(OWNER_REPO, PR, "daemon-cron")).toBe("released");
    // After release the PR is idle and a new holder can acquire.
    expect(store.get(OWNER_REPO, PR)).toBeNull();
    const reacquire = store.acquire(OWNER_REPO, PR, "tidus-manual");
    expect(reacquire.ok).toBe(true);
  });

  it("returns not_found when releasing a PR with no lease", () => {
    expect(store.release(OWNER_REPO, PR, "daemon-cron")).toBe("not_found");
  });

  it("forbids cross-holder release", () => {
    store.acquire(OWNER_REPO, PR, "daemon-cron");
    expect(store.release(OWNER_REPO, PR, "tidus-manual")).toBe("forbidden");
    // The original lease must survive a forbidden release attempt.
    expect(store.get(OWNER_REPO, PR)?.holder).toBe("daemon-cron");
  });

  it("get returns null for an unknown PR and the live lease otherwise", () => {
    expect(store.get(OWNER_REPO, PR)).toBeNull();
    store.acquire(OWNER_REPO, PR, "daemon-webhook");
    expect(store.get(OWNER_REPO, PR)?.holder).toBe("daemon-webhook");
  });

  it("scopes leases per-PR — different PRs don't collide", () => {
    store.acquire(OWNER_REPO, 1, "daemon-cron");
    const other = store.acquire(OWNER_REPO, 2, "tidus-manual");
    expect(other.ok).toBe(true);
    expect(store.get(OWNER_REPO, 1)?.holder).toBe("daemon-cron");
    expect(store.get(OWNER_REPO, 2)?.holder).toBe("tidus-manual");
  });

  it("scopes leases per-repo — same PR number on different repos don't collide", () => {
    store.acquire("org/repo-a", PR, "daemon-cron");
    const other = store.acquire("org/repo-b", PR, "tidus-manual");
    expect(other.ok).toBe(true);
  });
});

describe("ReviewLeaseStore — TTL auto-expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires a lease after its TTL and lets a new holder acquire", () => {
    const store = new ReviewLeaseStore(1000); // 1s TTL
    const first = store.acquire(OWNER_REPO, PR, "daemon-cron");
    expect(first.ok).toBe(true);

    // Just before expiry — still held, conflict for a different holder.
    vi.advanceTimersByTime(999);
    const during = store.acquire(OWNER_REPO, PR, "tidus-manual");
    expect(during.ok).toBe(false);

    // Past expiry — lazily evicted on the next acquire; new holder wins.
    vi.advanceTimersByTime(2);
    const after = store.acquire(OWNER_REPO, PR, "tidus-manual");
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.lease.holder).toBe("tidus-manual");
  });

  it("get() evicts an expired lease and reports idle", () => {
    const store = new ReviewLeaseStore(1000);
    store.acquire(OWNER_REPO, PR, "daemon-cron");
    vi.advanceTimersByTime(1001);
    expect(store.get(OWNER_REPO, PR)).toBeNull();
  });

  it("a per-acquire ttl_ms override beats the store default", () => {
    const store = new ReviewLeaseStore(DEFAULT_LEASE_TTL_MS);
    store.acquire(OWNER_REPO, PR, "daemon-cron", { ttl_ms: 500 });
    vi.advanceTimersByTime(501);
    // Expired despite the 20-min store default, because this lease used 500ms.
    expect(store.get(OWNER_REPO, PR)).toBeNull();
  });

  it("release on an expired lease reports not_found (treated as gone)", () => {
    const store = new ReviewLeaseStore(1000);
    store.acquire(OWNER_REPO, PR, "daemon-cron");
    vi.advanceTimersByTime(1001);
    expect(store.release(OWNER_REPO, PR, "daemon-cron")).toBe("not_found");
  });
});

describe("is_lease_holder", () => {
  it("accepts the three known holders", () => {
    expect(is_lease_holder("daemon-cron")).toBe(true);
    expect(is_lease_holder("daemon-webhook")).toBe(true);
    expect(is_lease_holder("tidus-manual")).toBe(true);
  });

  it("rejects unknown / malformed holders", () => {
    expect(is_lease_holder("daemon")).toBe(false);
    expect(is_lease_holder("")).toBe(false);
    expect(is_lease_holder(null)).toBe(false);
    expect(is_lease_holder(42)).toBe(false);
  });
});
