import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DEFERRED_FIX_ATTEMPTS, MAX_REVIEW_CYCLES, PRReviewCron } from "../pr-cron.js";
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
  /**
   * Review cycles the cap check will see. Settable so a test can model another
   * reviewer advancing the count *between* a deferral and its drain.
   */
  review_cycles = 1;

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

    // Deterministic cycle count so the cap branch (#46) fires only when a test
    // asks for it, and we don't need to stub `gh`. Same idiom as pr-cron.test.ts.
    (this as unknown as Record<string, unknown>).count_review_cycles = vi.fn(() =>
      Promise.resolve(this.review_cycles),
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
  state(): Record<string, { fix_deferred_at?: string; fix_deferred_failures?: number }> {
    return (
      this as unknown as {
        processed: Record<string, { fix_deferred_at?: string; fix_deferred_failures?: number }>;
      }
    ).processed;
  }

  /** Our PR's persisted entry, or undefined. */
  entry(): { fix_deferred_at?: string; fix_deferred_failures?: number } | undefined {
    return this.state()["lobster-farm:103"];
  }

  /** Discord alerts whose title contains `needle`. */
  alerts_matching(needle: string): Array<{ title: string; body: string }> {
    return this.alerts.filter((a) => a.title.includes(needle));
  }
}

describe("#105 auto-fix loop must not spawn into an occupied worktree", () => {
  let warn_spy: ReturnType<typeof vi.spyOn>;
  let log_spy: ReturnType<typeof vi.spyOn>;
  let error_spy: ReturnType<typeof vi.spyOn>;

  /** How many times the per-deferral warn log fired — the un-throttled signal. */
  function deferral_warnings(): number {
    return warn_spy.mock.calls.filter((c) => String(c[0]).includes("DEFERRED for PR #103")).length;
  }

  beforeEach(() => {
    STATE_ROOT = mkdtempSync(join(tmpdir(), "lf-worktree-gate-"));
    warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
    error_spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warn_spy.mockRestore();
    log_spy.mockRestore();
    error_spy.mockRestore();
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

  // ── Alert throttling: an ignored alert is a quiet gate (review 🟡-1) ──

  it("announces a deferral once, not once per tick, while the worktree stays busy", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    // The #103 situation: a human holds the tree for a long session, renewing
    // its observed lease, and the cron ticks every 5 minutes underneath.
    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    for (let tick = 0; tick < 5; tick++) await cron.drain([pr]);

    // Six deferrals happened and all six are in the log...
    expect(deferral_warnings()).toBe(6);
    // ...but Discord was told once. Un-throttled this was measured at one
    // identical alert per tick — ~36 for a three-hour hold.
    expect(cron.alerts_matching("deferred")).toHaveLength(1);
    // The alert says it will keep retrying, so "once" is not misleading.
    expect(cron.alerts_matching("deferred")[0]?.body).toContain("announced once");

    // Throttling the alert must not have quietened the gate itself.
    expect(cron.spawn_spy).not.toHaveBeenCalled();
    expect(cron.entry()?.fix_deferred_at).toBeTruthy();
  });

  it("announces again for a genuinely new deferral after the queue clears", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    // Deferral 1 → announced, then drained successfully (marker clears).
    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    leases.release(WORKTREE, "sess-human-builder");
    await cron.drain([pr]);
    expect(cron.entry()?.fix_deferred_at).toBeUndefined();
    expect(cron.alerts_matching("deferred")).toHaveLength(1);

    // A later review cycle defers again. This is new information, not a repeat,
    // so the throttle must not swallow it.
    leases.touch_observed(WORKTREE, "sess-another-agent");
    await cron.complete_review_with_changes(pr);
    expect(cron.alerts_matching("deferred")).toHaveLength(2);
  });

  // ── The drain is a full second entry point (review 🟡-3) ──

  it("does not spawn past the cycle cap when the count advances during a deferral", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    // Deferred at cycle 1/3 because the tree was busy.
    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    expect(cron.entry()?.fix_deferred_at).toBeTruthy();

    // A manual Discord review or a webhook-triggered reviewer lands in between
    // and takes the PR to the cap. MEMORY.md records this race as real (#67, #86).
    cron.review_cycles = MAX_REVIEW_CYCLES;
    leases.release(WORKTREE, "sess-human-builder");

    await cron.drain([pr]);

    // No fourth builder. The cap check lives in a helper both entry points
    // call, so the drain cannot skip it.
    expect(cron.spawn_spy).not.toHaveBeenCalled();
    expect(cron.alerts_matching("hit max review cycles")).toHaveLength(1);
    // No builder is coming, so the queue entry is dropped rather than re-running
    // a gh round-trip every tick forever. The escalation is the handoff.
    expect(cron.entry()?.fix_deferred_at).toBeUndefined();
  });

  it("still drains normally when the cycle count is below the cap", async () => {
    // Counterpart: the cap check must not have become a blanket block on the
    // drain, which would strand every deferred fix.
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    leases.release(WORKTREE, "sess-human-builder");
    cron.review_cycles = MAX_REVIEW_CYCLES - 1;

    await cron.drain([pr]);

    expect(cron.spawn_spy).toHaveBeenCalledTimes(1);
    expect(cron.alerts_matching("hit max review cycles")).toHaveLength(0);
    expect(cron.entry()?.fix_deferred_at).toBeUndefined();
  });

  // ── A transient spawn failure must not drop the owed fix (review 🟡-6) ──

  it("retries a transient spawn failure instead of abandoning the fix", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    leases.release(WORKTREE, "sess-human-builder");

    // A token refresh blips on the drain tick.
    cron.spawn_spy.mockRejectedValueOnce(new Error("token refresh failed"));
    await cron.drain([pr]);

    // The fix is STILL OWED. Clearing the marker here is what made a blip
    // permanent: `reviewed_at` is persisted, so check_repo skips the PR and the
    // fix is gone until someone pushes — a silent drop dressed as a review.
    expect(cron.entry()?.fix_deferred_at).toBeTruthy();
    expect(cron.entry()?.fix_deferred_failures).toBe(1);
    expect(cron.alerts_matching("abandoned")).toHaveLength(0);

    // Next tick, the blip is over.
    await cron.drain([pr]);
    expect(cron.spawn_spy).toHaveBeenCalledTimes(2);
    expect(cron.entry()?.fix_deferred_at).toBeUndefined();
    expect(cron.entry()?.fix_deferred_failures).toBeUndefined();
    expect(cron.alerts_matching("auto-fix resumed")).toHaveLength(1);
  });

  it("gives up loudly, not silently, after a persistent spawn failure", async () => {
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    leases.release(WORKTREE, "sess-human-builder");
    cron.spawn_spy.mockRejectedValue(new Error("persistently broken"));

    for (let tick = 0; tick < MAX_DEFERRED_FIX_ATTEMPTS; tick++) await cron.drain([pr]);

    expect(cron.spawn_spy).toHaveBeenCalledTimes(MAX_DEFERRED_FIX_ATTEMPTS);
    expect(cron.entry()?.fix_deferred_at).toBeUndefined();
    // Loud: a human is paged. The original behavior left only a Sentry event.
    expect(cron.alerts_matching("auto-fix abandoned")).toHaveLength(1);

    // ...and it genuinely stops, rather than retrying every five minutes.
    await cron.drain([pr]);
    expect(cron.spawn_spy).toHaveBeenCalledTimes(MAX_DEFERRED_FIX_ATTEMPTS);
    expect(cron.alerts_matching("auto-fix abandoned")).toHaveLength(1);
  });

  it("a worktree deferral never counts against the spawn-failure budget", async () => {
    // Otherwise a long human hold would exhaust the budget and abandon a fix
    // that never actually failed to spawn.
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    leases.touch_observed(WORKTREE, "sess-human-builder");
    await cron.complete_review_with_changes(pr);
    for (let tick = 0; tick < MAX_DEFERRED_FIX_ATTEMPTS + 3; tick++) await cron.drain([pr]);

    expect(cron.entry()?.fix_deferred_at).toBeTruthy();
    expect(cron.entry()?.fix_deferred_failures).toBeUndefined();
    expect(cron.alerts_matching("auto-fix abandoned")).toHaveLength(0);
  });

  it("queues a fix whose spawn failed at review completion", async () => {
    // The same drop, at the OTHER entry point: on a failed spawn the completion
    // handler used to just return, and `reviewed_at` was already persisted.
    const leases = new WorktreeLeaseStore();
    const cron = new TestCron(leases);
    const pr = make_pr();

    cron.spawn_spy.mockRejectedValueOnce(new Error("EMFILE"));
    await cron.complete_review_with_changes(pr);

    expect(cron.entry()?.fix_deferred_at).toBeTruthy();
    expect(cron.entry()?.fix_deferred_failures).toBe(1);
    // It did not claim to have spawned a builder.
    expect(cron.alerts.some((a) => a.body.includes("spawning builder"))).toBe(false);

    // And the drain owns it from here.
    await cron.drain([pr]);
    expect(cron.spawn_spy).toHaveBeenCalledTimes(2);
    expect(cron.entry()?.fix_deferred_at).toBeUndefined();
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
