import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRReviewCron } from "../pr-cron.js";
import type { EntityRegistry } from "../registry.js";
import { start_server } from "../server.js";
import { WorktreeLeaseStore } from "../worktree-lease.js";

/**
 * Acceptance coverage for #105: "no second agent is spawned into a worktree
 * that a live session is already editing."
 *
 * This is the regression test for the PR #103 incident. The sequence it
 * reproduces is the real one:
 *
 *   1. A human-directed builder is editing `worktrees/102-merge-gate-hardening`
 *      to address review feedback. It is NOT daemon-spawned, so the daemon only
 *      knows about it through the Stop hook that every Claude session on the
 *      machine POSTs once per completed turn.
 *   2. The autonomous pr-cron gets `changes_requested` on the same PR and goes
 *      to spawn its own auto-fix builder for the same branch.
 *   3. Before #105 it spawned, both agents edited one tree, and the auto-fix
 *      builder swept the other agent's uncommitted work into its own commit.
 *
 * Every test below fails if the lease acquire in `spawn_external_pr_fixer` is
 * removed — the spawn spy gets called instead of the deferral being recorded.
 */

vi.mock("../review-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../review-utils.js")>("../review-utils.js");
  return {
    ...actual,
    // Keep the gh CLI out of the spawn path; this test is about the gate.
    fetch_review_comments: vi.fn(async () => "Please fix the null check."),
  };
});

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  cronCheckInStart: vi.fn(() => "checkin-id"),
  cronCheckInFinish: vi.fn(),
}));

let STATE_ROOT: string;

const REPO_PATH = "/tmp/lf-gate-repo";
const BRANCH = "feature/102-merge-gate-hardening";
/** The linked worktree both agents want. Mirrors the #103 incident path. */
const WORKTREE = "/tmp/lf-gate-repo/worktrees/102-merge-gate-hardening";

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: STATE_ROOT },
  });
}

function make_entity(): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: "lobster-farm",
      name: "lobster-farm",
      memory: { path: "~/.lobsterfarm/entities/lobster-farm" },
      secrets: { vault_name: "entity-lobster-farm" },
      channels: { category_id: "111111111111111111", list: [] },
      repos: [
        {
          name: "lobster-farm",
          url: "https://github.com/test-org/lobster-farm.git",
          path: REPO_PATH,
        },
      ],
    },
  });
}

function make_pr(overrides: Partial<ReturnType<typeof base_pr>> = {}) {
  return { ...base_pr(), ...overrides };
}

function base_pr() {
  return {
    number: 103,
    title: "Merge gate hardening",
    headRefName: BRANCH,
    updatedAt: "2026-10-31T10:00:00Z",
    url: "https://github.com/test-org/lobster-farm/pull/103",
    body: "Closes #102",
    author: { login: "hkelley44" },
    isDraft: false,
  };
}

type PR = ReturnType<typeof base_pr>;

/**
 * Exposes the private spawn/drain paths and stubs the branch→worktree lookup so
 * the test needs no real git repo. `pr_worktree_path` is `protected` precisely
 * so this override is possible.
 */
class TestCron extends PRReviewCron {
  spawn_spy = vi.fn(async () => ({ session_id: "sess-autofix", pid: process.pid }));
  alerts: Array<{ title: string; body: string }> = [];
  /** Set null to model "this branch lives in the main working tree". */
  worktree_for_branch: string | null = WORKTREE;

  constructor(leases: WorktreeLeaseStore | null) {
    // `this` is unavailable until super() returns, so the collaborators close
    // over locals that get re-pointed at the instance afterwards.
    const sink: Array<{ title: string; body: string }> = [];
    const session_manager = {
      spawn: undefined as unknown,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const alert_router = {
      post_alert: vi.fn((a: { title: string; body: string }) => {
        sink.push(a);
        return Promise.resolve();
      }),
    };
    super(
      { get: () => make_entity(), get_active: () => [make_entity()] } as unknown as EntityRegistry,
      session_manager as never,
      make_config(),
      null, // discord
      null, // github_app
      null, // pr_watches
      alert_router as never,
      null, // review_leases
      leases,
    );
    session_manager.spawn = this.spawn_spy;
    this.alerts = sink;

    // Deterministic cycle count so the cap branch (#46) never fires and we
    // don't need to stub `gh`. Same idiom as pr-cron.test.ts.
    (this as unknown as Record<string, unknown>).count_review_cycles = vi.fn(() =>
      Promise.resolve(1),
    );
  }

  protected override pr_worktree_path(): Promise<string | null> {
    return Promise.resolve(this.worktree_for_branch);
  }

  spawn_fixer(pr: PR): Promise<"spawned" | "deferred" | "failed"> {
    type Fn = (
      entity_id: string,
      repo_path: string,
      pr: PR,
      entity_config?: EntityConfig,
    ) => Promise<"spawned" | "deferred" | "failed">;
    const fn = (this as unknown as { spawn_external_pr_fixer: Fn }).spawn_external_pr_fixer.bind(
      this,
    );
    return fn("lobster-farm", REPO_PATH, pr, make_entity());
  }

  /**
   * Drive the real `changes_requested` completion path — the caller that owns
   * writing the deferral marker. Going through it (rather than calling
   * `spawn_external_pr_fixer` directly) is what makes the queue test able to
   * catch a caller that forgets to persist the deferral.
   */
  complete_review_with_changes(pr: PR): Promise<void> {
    type Fn = (
      entity_id: string,
      repo_path: string,
      pr: PR,
      review_outcome: "changes_requested",
      gh_token?: string,
    ) => Promise<void>;
    const fn = (this as unknown as { handle_review_completion: Fn }).handle_review_completion.bind(
      this,
    );
    return fn("lobster-farm", REPO_PATH, pr, "changes_requested", undefined);
  }

  drain(prs: PR[]): Promise<void> {
    type Fn = (
      entity_id: string,
      repo_path: string,
      prs: PR[],
      entity_config: EntityConfig,
    ) => Promise<void>;
    const fn = (this as unknown as { retry_deferred_fixes: Fn }).retry_deferred_fixes.bind(this);
    return fn("lobster-farm", REPO_PATH, prs, make_entity());
  }

  /** The persisted review-state map, for asserting the deferral marker. */
  state(): Record<string, { fix_deferred_at?: string }> {
    return (this as unknown as { processed: Record<string, { fix_deferred_at?: string }> })
      .processed;
  }
}

describe("#105 auto-fix loop must not spawn into an occupied worktree", () => {
  let warn_spy: ReturnType<typeof vi.spyOn>;
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    STATE_ROOT = mkdtempSync(join(tmpdir(), "lf-worktree-gate-"));
    warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warn_spy.mockRestore();
    log_spy.mockRestore();
    vi.restoreAllMocks();
    rmSync(STATE_ROOT, { recursive: true, force: true });
  });

  // ── The acceptance criterion ──

  it("defers instead of spawning when another live agent holds the worktree", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);

    // The human-directed builder's Stop hook fired — this is exactly what the
    // daemon saw during the #103 incident, and the only signal it had.
    expect(leases.touch_observed(WORKTREE, "sess-human-builder")).toBe("created");

    const outcome = await cron.spawn_fixer(make_pr());

    expect(outcome).toBe("deferred");
    expect(cron.spawn_spy).not.toHaveBeenCalled();
    // The other agent's hold is untouched.
    expect(leases.get(WORKTREE)?.owner_id).toBe("sess-human-builder");
  });

  it("spawns normally when the worktree is free (the gate is not a blanket block)", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);

    const outcome = await cron.spawn_fixer(make_pr());

    expect(outcome).toBe("spawned");
    expect(cron.spawn_spy).toHaveBeenCalledTimes(1);
    // And it now owns the tree, bound to the worker it spawned.
    expect(leases.get(WORKTREE)?.holder).toBe("daemon-cron");
    expect(leases.get(WORKTREE)?.session_id).toBe("sess-autofix");
  });

  it("two concurrent auto-fix attempts cannot both spawn into one worktree", async () => {
    const leases = new WorktreeLeaseStore();
    const a = new TestCron(leases);
    const b = new TestCron(leases);

    const [first, second] = await Promise.all([a.spawn_fixer(make_pr()), b.spawn_fixer(make_pr())]);

    // Exactly one winner — acquire is the test-and-set, so a tie is impossible.
    expect([first, second].filter((o) => o === "spawned")).toHaveLength(1);
    expect([first, second].filter((o) => o === "deferred")).toHaveLength(1);
    expect(a.spawn_spy.mock.calls.length + b.spawn_spy.mock.calls.length).toBe(1);
  });

  it("announces the deferral rather than skipping silently", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    leases.touch_observed(WORKTREE, "sess-human-builder");

    await cron.spawn_fixer(make_pr());

    expect(warn_spy).toHaveBeenCalledWith(expect.stringContaining("DEFERRED for PR #103"));
    expect(cron.alerts.some((a) => a.title.includes("deferred"))).toBe(true);
  });

  it("leaves the main working tree unleased so reviewer+fixer still coexist", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    cron.worktree_for_branch = null; // branch lives in the repo root

    // Even with the repo root "occupied", a main-tree branch must not be gated:
    // leasing the shared root would serialize pairs that coexist today.
    leases.touch_observed(REPO_PATH, "sess-someone-else");

    expect(await cron.spawn_fixer(make_pr())).toBe("spawned");
    expect(cron.spawn_spy).toHaveBeenCalledTimes(1);
  });

  // ── The deferral queue must not silently drop the owed fix ──

  it("persists a deferral marker and drains it once the worktree frees", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    // Tick 1: review says changes_requested, but the tree is busy → the fix is
    // deferred and the marker is persisted by the completion handler.
    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    expect(cron.state()["lobster-farm:103"]?.fix_deferred_at).toBeTruthy();
    expect(cron.spawn_spy).not.toHaveBeenCalled();
    // The "spawning builder to fix" alert must NOT have been sent — claiming a
    // spawn that did not happen is the silent-success failure mode.
    expect(cron.alerts.some((a) => a.body.includes("spawning builder"))).toBe(false);

    // A drain while the tree is still busy keeps the marker and spawns nothing.
    await cron.drain([pr]);
    expect(cron.state()["lobster-farm:103"]?.fix_deferred_at).toBeTruthy();
    expect(cron.spawn_spy).not.toHaveBeenCalled();

    // Tick 2: the other agent is gone → the owed fix finally runs and the
    // marker clears, so it is not re-spawned forever.
    expect(leases.release(WORKTREE, "sess-human-builder")).toBe("released");
    await cron.drain([pr]);
    expect(cron.spawn_spy).toHaveBeenCalledTimes(1);
    expect(cron.state()["lobster-farm:103"]?.fix_deferred_at).toBeUndefined();
  });

  it("still alerts and leaves no marker on the normal free-worktree path", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);

    // Counterpart to the deferral test: proves the suppressed alert and the
    // marker are specific to deferral, not something the gate broke for
    // everyone.
    await cron.complete_review_with_changes(make_pr());

    expect(cron.spawn_spy).toHaveBeenCalledTimes(1);
    expect(cron.alerts.some((a) => a.body.includes("spawning builder"))).toBe(true);
    expect(cron.state()["lobster-farm:103"]?.fix_deferred_at).toBeUndefined();
  });

  it("holds the deferred fix while the PR is a draft", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    expect(cron.state()["lobster-farm:103"]?.fix_deferred_at).toBeTruthy();

    // Tree is free now, but the PR went back to draft — a builder is still
    // iterating on it. The drain is a second entry point into the spawn and
    // must respect the draft flag just like the main review loop does.
    leases.release(WORKTREE, "sess-human-builder");
    await cron.drain([make_pr({ isDraft: true })]);

    expect(cron.spawn_spy).not.toHaveBeenCalled();
    // The fix is still owed, not dropped.
    expect(cron.state()["lobster-farm:103"]?.fix_deferred_at).toBeTruthy();
  });

  it("frees the worktree when the spawn throws, instead of blocking it for the TTL", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    cron.spawn_spy.mockRejectedValue(new Error("boom"));

    expect(await cron.spawn_fixer(make_pr())).toBe("failed");

    // A lease held with no pid bound is immune to crash reaping, so a leak here
    // would block the tree for the full 60-minute TTL.
    expect(leases.get(WORKTREE)).toBeNull();
    // ...and the next attempt can proceed.
    cron.spawn_spy.mockResolvedValue({ session_id: "sess-retry", pid: process.pid });
    expect(await cron.spawn_fixer(make_pr())).toBe("spawned");
  });

  // ── Flag-OFF / no-store parity ──

  it("behaves exactly as before when no lease store is wired", async () => {
    const cron = new TestCron(null);

    // No store → no gate, no deferral, no lease bookkeeping. Byte-identical to
    // pre-#105 behavior, which is what makes the store optional everywhere.
    expect(await cron.spawn_fixer(make_pr())).toBe("spawned");
    expect(cron.spawn_spy).toHaveBeenCalledTimes(1);
    expect(cron.alerts.some((a) => a.title.includes("deferred"))).toBe(false);
  });
});

// ── The wiring itself ──

describe("#105 Stop hook feeds observed occupancy", () => {
  let server: Server;
  let port: number;
  let store: WorktreeLeaseStore;

  beforeEach(async () => {
    store = new WorktreeLeaseStore();
    server = start_server(
      { get_active: () => [] } as unknown as EntityRegistry,
      LobsterFarmConfigSchema.parse({ user: { name: "Test" } }),
      { get_active: () => [] } as never,
      {
        get_stats: () => ({ pending: 0, active: 0, total: 0 }),
        get_pending: () => [],
        get_active: () => [],
      } as never,
      null, // commander
      null, // discord
      null, // pool
      null, // github_app
      null, // pr_watches
      null, // alert_router
      null, // review_leases
      store, // worktree_leases
      0, // ephemeral port
    );
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  /**
   * This is the test that catches a dead gate. The store can be perfect and the
   * cron can consult it correctly, and #105 still would not be fixed if nothing
   * ever told the store that a non-daemon agent is in a worktree. That edge
   * runs through the live /hooks/stop route.
   */
  it("records a real POST /hooks/stop as occupancy the cron can see", async () => {
    const res = await fetch(`http://localhost:${String(port)}/hooks/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-human-builder", working_dir: WORKTREE }),
    });
    expect(res.status).toBe(200);

    const lease = store.get(WORKTREE);
    expect(lease?.holder).toBe("agent-observed");
    expect(lease?.session_id).toBe("sess-human-builder");

    // ...and that occupancy is what blocks the auto-fix spawn.
    expect(store.acquire(WORKTREE, "daemon-cron", "op-autofix").ok).toBe(false);
  });

  it("stays a 200 no-op when the lease is stood down (flag off)", async () => {
    // `pr_cron.worktree_lease_enabled: false` makes index.ts pass null here.
    // The route must still answer normally — the Stop hook also drives reply
    // enforcement and pool liveness, so a disabled lease must not break it.
    const off = start_server(
      { get_active: () => [] } as unknown as EntityRegistry,
      LobsterFarmConfigSchema.parse({ user: { name: "Test" } }),
      { get_active: () => [] } as never,
      {
        get_stats: () => ({ pending: 0, active: 0, total: 0 }),
        get_pending: () => [],
        get_active: () => [],
      } as never,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null, // worktree_leases — stood down
      0,
    );
    await new Promise<void>((resolve) => off.on("listening", resolve));
    const addr = off.address();
    const off_port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://localhost:${String(off_port)}/hooks/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "sess-x", working_dir: WORKTREE }),
      });
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        off.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("stays a 200 no-op for a malformed hook body", async () => {
    const res = await fetch(`http://localhost:${String(port)}/hooks/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
    expect(store.tracked_count()).toBe(0);
  });
});
