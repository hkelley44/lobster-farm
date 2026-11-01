import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeLeaseStore, canonical_worktree_path } from "../worktree-lease.js";

// Unit coverage for the #105 per-worktree mutex. The acceptance-level proof
// (the auto-fix loop actually deferring) lives in worktree-spawn-gate.test.ts;
// this file pins the store's own invariants — the ones the gate's correctness
// rests on.

/** Store with deterministic pid liveness, so crash reaping is testable. */
class TestStore extends WorktreeLeaseStore {
  dead = new Set<number>();
  protected override is_pid_alive(pid: number): boolean {
    return !this.dead.has(pid);
  }
}

const WT = "/tmp/lf-test-worktrees/102-merge-gate-hardening";

describe("WorktreeLeaseStore — explicit holds", () => {
  it("grants a free worktree and blocks a second owner", () => {
    const store = new WorktreeLeaseStore();

    const first = store.acquire(WT, "daemon-cron", "op-1");
    expect(first.ok).toBe(true);

    const second = store.acquire(WT, "daemon-cron", "op-2");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // The blocker is reported so the caller can name who holds it.
      expect(second.current_lease.owner_id).toBe("op-1");
    }
  });

  it("is idempotent for the same owner without extending the expiry", () => {
    const store = new WorktreeLeaseStore();
    const first = store.acquire(WT, "daemon-cron", "op-1");
    const again = store.acquire(WT, "daemon-cron", "op-1");

    expect(again.ok).toBe(true);
    if (first.ok && again.ok) {
      // Re-asking must not be a way to hold a worktree forever.
      expect(again.lease.expires_at).toBe(first.lease.expires_at);
    }
  });

  it("releases only to its owner", () => {
    const store = new WorktreeLeaseStore();
    store.acquire(WT, "daemon-cron", "op-1");

    expect(store.release(WT, "op-2")).toBe("forbidden");
    expect(store.release(WT, "op-1")).toBe("released");
    expect(store.release(WT, "op-1")).toBe("not_found");
  });

  it("expires a lease once its TTL passes", () => {
    const store = new WorktreeLeaseStore(1); // 1ms explicit TTL
    store.acquire(WT, "daemon-cron", "op-1");

    // A 1ms TTL is already in the past by the time we look.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(store.get(WT)).toBeNull();
        // ...and the worktree is grantable again.
        expect(store.acquire(WT, "daemon-cron", "op-2").ok).toBe(true);
        resolve();
      }, 5);
    });
  });
});

describe("WorktreeLeaseStore — crash reaping", () => {
  it("frees the worktree as soon as the bound pid is gone", () => {
    const store = new TestStore();
    store.acquire(WT, "daemon-cron", "op-1");
    expect(store.bind_session(WT, "op-1", "sess-1", 4242)).toBe(true);

    // Holder alive → still blocked.
    expect(store.acquire(WT, "daemon-cron", "op-2").ok).toBe(false);

    // Holder SIGKILLed: no handler of ours ever runs, but the next lookup
    // must free the tree rather than waiting out the 60-minute TTL.
    store.dead.add(4242);
    expect(store.get(WT)).toBeNull();
    expect(store.acquire(WT, "daemon-cron", "op-2").ok).toBe(true);
  });

  it("bind_session refuses to bind a lease owned by someone else", () => {
    const store = new TestStore();
    store.acquire(WT, "daemon-cron", "op-1");
    expect(store.bind_session(WT, "op-2", "sess-2", 99)).toBe(false);
  });

  it("holds no pid before bind, so a pre-spawn lease is never reaped early", () => {
    const store = new TestStore();
    store.acquire(WT, "daemon-cron", "op-1");
    // The lease exists before any worker does — that is what makes it a mutex.
    expect(store.get(WT)?.pid).toBeUndefined();
    expect(store.holds(WT, "op-1")).toBe(true);
  });
});

describe("WorktreeLeaseStore — observed holds (Stop hook)", () => {
  it("creates a lease on first sighting and renews it on later turns", () => {
    const store = new WorktreeLeaseStore();

    expect(store.touch_observed(WT, "sess-human")).toBe("created");
    const created = store.get(WT);
    expect(created?.holder).toBe("agent-observed");

    expect(store.touch_observed(WT, "sess-human")).toBe("renewed");
  });

  it("reports blocked without stealing when another agent owns the tree", () => {
    const store = new WorktreeLeaseStore();
    store.acquire(WT, "daemon-cron", "op-1");

    expect(store.touch_observed(WT, "sess-other")).toBe("blocked");
    // The original hold is untouched.
    expect(store.get(WT)?.owner_id).toBe("op-1");
  });

  it("attributes a bound session's own turns to its explicit lease", () => {
    const store = new WorktreeLeaseStore();
    store.acquire(WT, "daemon-cron", "op-1");
    store.bind_session(WT, "op-1", "sess-builder", null);

    // The worker we spawned must renew its own lease, not look like a second
    // occupant of the tree it legitimately owns.
    expect(store.touch_observed(WT, "sess-builder")).toBe("renewed");
    expect(store.get(WT)?.holder).toBe("daemon-cron");
  });
});

describe("canonical_worktree_path", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lf-wt-canon-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("collapses symlinks so two aliases of one tree cannot both be leased", () => {
    const real = join(root, "real-worktree");
    const alias = join(root, "alias-worktree");
    mkdirSync(real);
    symlinkSync(real, alias);

    // This is the live hazard: ~/.lobsterfarm/src is also reachable as
    // ~/.lobsterfarm/entities/lobster-farm/repos/lobster-farm.
    expect(canonical_worktree_path(alias)).toBe(canonical_worktree_path(real));

    const store = new WorktreeLeaseStore();
    expect(store.acquire(real, "daemon-cron", "op-1").ok).toBe(true);
    expect(store.acquire(alias, "daemon-cron", "op-2").ok).toBe(false);
  });

  it("normalizes trailing slashes and relative segments", () => {
    const real = join(root, "wt");
    mkdirSync(real);
    expect(canonical_worktree_path(`${real}/`)).toBe(canonical_worktree_path(real));
    expect(canonical_worktree_path(join(real, "..", "wt"))).toBe(canonical_worktree_path(real));
  });

  it("falls back to lexical resolution for a path that does not exist", () => {
    const missing = join(root, "not-created-yet");
    // No throw, and still absolute — a lease may be taken for a tree that is
    // about to be created.
    expect(canonical_worktree_path(missing)).toBe(missing);
  });
});
