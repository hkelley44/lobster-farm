import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordBroker } from "../broker/index.js";
import type { PersistedPoolBot } from "../persistence.js";
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// Mock actions.ts — notify is imported by pool.ts for alerting
vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistence to avoid filesystem side effects
vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({
    bots: [],
    session_history: {},
    avatar_state: {},
  }),
}));

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

/**
 * Test-friendly subclass that stubs tmux/filesystem operations and
 * exposes internals needed for crash recovery assertions.
 */
class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  get_crash_history(): Map<number, number[]> {
    return (this as unknown as { crash_history: Map<number, number[]> }).crash_history;
  }

  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }

  /** Expose check_assigned_health for direct invocation in tests. */
  async run_health_check(): Promise<void> {
    await this.check_assigned_health();
  }

  /** Expose reconcile_assigned_health (restart-time repair) for tests. */
  async run_reconcile(): Promise<void> {
    await this.reconcile_assigned_health();
  }

  /** Seed the restart-time proactive-resume queue and run it. */
  set_resume_candidates(candidates: PersistedPoolBot[]): void {
    (this as unknown as { resume_candidates: PersistedPoolBot[] }).resume_candidates = candidates;
  }

  async run_resume(): Promise<void> {
    await this.resume_parked_bots();
  }

  /** Expose the canonical #89 gate for flag-OFF byte-identical assertions. */
  is_broker_channel(channel_id: string): boolean {
    return this.uses_broker(channel_id);
  }

  /** Override is_bot_idle — not relevant for crash recovery tests. */
  protected override is_bot_idle(): boolean {
    return true;
  }
}

// ── Tests ──

describe("crash recovery (issue #157)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let mock_start_tmux: ReturnType<typeof vi.fn>;
  let mock_is_tmux_alive: ReturnType<typeof vi.fn>;
  let mock_notify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "crash-recovery-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    // Get the module-level mock and clear accumulated calls between tests.
    // vi.mock() at the top replaces actions.notify with a vi.fn() — cast it.
    const actions = await import("../actions.js");
    mock_notify = actions.notify as unknown as ReturnType<typeof vi.fn>;
    mock_notify.mockClear();

    // Stub side effects
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_nickname" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_avatar" as never,
    ).mockResolvedValue(undefined);
    mock_start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>;

    // Default: tmux is dead for all sessions (crash scenario)
    mock_is_tmux_alive = vi
      .spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
      .mockReturnValue(false) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  // ── Single crash → restart ──

  describe("single crash detection and restart", () => {
    it("detects dead tmux and attempts restart", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
        channel_type: "work_room",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      // start_tmux should have been called to restart
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
    });

    it("uses --resume with existing session_id", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      // start_tmux args: bot, archetype, entity_id, working_dir, session_id, is_resume, extra_env
      const call_args = mock_start_tmux.mock.calls[0] as unknown[];
      expect(call_args[4]).toBe("sess-abc-123"); // session_id preserved
      expect(call_args[5]).toBe(true); // is_resume = true
    });

    it("generates fresh session_id when none exists", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: null, // no session to resume
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      const call_args = mock_start_tmux.mock.calls[0] as unknown[];
      expect(call_args[4]).toBeTruthy(); // a UUID was generated
      expect(call_args[5]).toBe(false); // is_resume = false
    });

    it("posts alert to #alerts on crash", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      expect(mock_notify).toHaveBeenCalledTimes(1);
      const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
      expect(channel_type).toBe("alerts");
      expect(message).toContain("Pool bot 2");
      expect(message).toContain("planner");
      expect(message).toContain("auto-restarted");
      expect(message).toContain("test-entity");
    });

    it("keeps bot in assigned state after successful restart", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("assigned");
      expect(bots[0].channel_id).toBe("ch-1");
      expect(bots[0].entity_id).toBe("test-entity");
      expect(bots[0].archetype).toBe("planner");
    });

    it("emits bot:crash_restarted event on successful restart", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:crash_restarted", (data) => events.push(data));

      await pool.run_health_check();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        bot_id: 2,
        channel_id: "ch-1",
        entity_id: "test-entity",
        resumed: true,
      });
    });

    it("falls back to free state when restart fails", async () => {
      mock_start_tmux.mockRejectedValue(new Error("tmux launch failed"));

      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:session_ended", (data) => events.push(data));
      pool.on("bot:released", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();
      expect(events).toHaveLength(2); // session_ended + released
    });

    it("stashes session history when restart fails", async () => {
      mock_start_tmux.mockRejectedValue(new Error("tmux launch failed"));

      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      const history = pool.get_session_history();
      expect(history.get("test-entity:ch-1")).toBe("sess-abc-123");
    });
  });

  // ── Crash loop detection ──

  describe("crash loop detection", () => {
    it("does not trigger crash loop with 3 total crashes (2 prior + 1 new)", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Simulate 2 prior crashes within the last hour — health check
      // records a 3rd. Total = 3, which does NOT exceed the >3 threshold.
      const now = Date.now();
      pool.get_crash_history().set(3, [now - 30 * 60_000, now - 10 * 60_000]);

      await pool.run_health_check();

      // Bot should be restarted (not released) — crash loop not triggered
      const bots = pool.get_bots();
      expect(bots[0].state).toBe("assigned");
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
    });

    it("triggers crash loop on 4th crash in 1 hour (3 prior + 1 new)", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes (within the hour)
      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      // After the 4th crash is recorded, >3 in 1 hour → crash loop
      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();

      // start_tmux should NOT have been called (crash loop bypasses restart)
      expect(mock_start_tmux).not.toHaveBeenCalled();
    });

    it("posts crash loop alert to #alerts", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes
      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      expect(mock_notify).toHaveBeenCalledTimes(1);
      const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
      expect(channel_type).toBe("alerts");
      expect(message).toContain("crash loop");
      expect(message).toContain("Pool bot 3");
    });

    it("emits bot:crash_loop event", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      const events: unknown[] = [];
      pool.on("bot:crash_loop", (data) => events.push(data));

      await pool.run_health_check();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        bot_id: 3,
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
      });
    });

    it("stashes session history on crash loop release", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      const history = pool.get_session_history();
      expect(history.get("test-entity:ch-1")).toBe("sess-loop-1");
    });
  });

  // ── Crash history cleanup ──

  describe("crash history cleanup", () => {
    it("removes entries older than 1 hour", async () => {
      // Pre-populate with old + recent crashes
      const now = Date.now();
      pool.get_crash_history().set(5, [
        now - 2 * 60 * 60_000, // 2 hours ago — should be removed
        now - 90 * 60_000, // 90 min ago — should be removed
        now - 30 * 60_000, // 30 min ago — should be kept
      ]);

      // Inject a bot that's NOT assigned (so health check doesn't trigger restart)
      pool.inject_bots([make_bot({ id: 5, state: "free" })]);

      // Running health check triggers cleanup_crash_history
      await pool.run_health_check();

      const history = pool.get_crash_history();
      const timestamps = history.get(5);
      expect(timestamps).toHaveLength(1);
      expect(timestamps![0]).toBe(now - 30 * 60_000);
    });

    it("deletes crash history entry entirely when all timestamps are old", async () => {
      const now = Date.now();
      pool.get_crash_history().set(7, [
        now - 2 * 60 * 60_000, // 2 hours ago
        now - 90 * 60_000, // 90 min ago
      ]);

      pool.inject_bots([make_bot({ id: 7, state: "free" })]);

      await pool.run_health_check();

      const history = pool.get_crash_history();
      expect(history.has(7)).toBe(false);
    });

    it("does not remove crashes within 3-crash threshold when they are recent", async () => {
      // 3 crashes within the last hour — not a crash loop yet, but should persist
      const now = Date.now();
      pool.get_crash_history().set(4, [now - 40 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      pool.inject_bots([make_bot({ id: 4, state: "free" })]);

      await pool.run_health_check();

      const history = pool.get_crash_history();
      expect(history.get(4)).toHaveLength(3);
    });
  });

  // ── Skips non-assigned bots ──

  describe("health check scope", () => {
    it("skips free bots", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(mock_notify).not.toHaveBeenCalled();
    });

    it("skips parked bots", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-1",
        }),
      ]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(mock_notify).not.toHaveBeenCalled();
    });

    it("skips assigned bots with alive tmux", async () => {
      mock_is_tmux_alive.mockReturnValue(true);

      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-1",
        }),
      ]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(mock_notify).not.toHaveBeenCalled();
    });

    it("skips health check entirely when draining", async () => {
      pool.drain();

      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-1",
        }),
      ]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
    });
  });

  // ── Concurrent health check serialization ──

  describe("concurrent health check guard", () => {
    it("serializes overlapping health checks — second call is a no-op", async () => {
      // Use a deferred promise so start_tmux blocks until we resolve it
      let resolve_start!: () => void;
      const blocking_promise = new Promise<void>((r) => {
        resolve_start = r;
      });
      mock_start_tmux.mockReturnValue(blocking_promise);

      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);

      // Fire two health checks without awaiting the first
      const first = pool.run_health_check();
      const second = pool.run_health_check();

      // Let start_tmux complete
      resolve_start();
      await first;
      await second;

      // start_tmux should have been called exactly once — the second
      // health check returned early because the first was still running
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
    });
  });

  // ── Null-guard force-free ──

  describe("null-guard force-free", () => {
    it("force-frees bot when entity_id is null in restart path", async () => {
      const bot = make_bot({
        id: 4,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: null, // missing — triggers null guard
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:released", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();
      expect(bots[0].entity_id).toBeNull();
      expect(bots[0].archetype).toBeNull();
      expect(bots[0].session_id).toBeNull();
      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ bot_id: 4 });
    });

    it("force-frees bot when archetype is null in restart path", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: null, // missing — triggers null guard
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:released", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
    });

    it("force-frees bot when channel_id is null in crash loop path", async () => {
      const bot = make_bot({
        id: 6,
        state: "assigned",
        channel_id: null, // missing — release() can't work
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes to trigger crash loop on the 4th
      const now = Date.now();
      pool.get_crash_history().set(6, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      const events: unknown[] = [];
      pool.on("bot:released", (data) => events.push(data));
      pool.on("bot:crash_loop", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();
      expect(bots[0].entity_id).toBeNull();
      expect(bots[0].session_id).toBeNull();
      expect(mock_start_tmux).not.toHaveBeenCalled();
      // Should have both bot:released (from force-free) and bot:crash_loop
      const released = events.filter(
        (e: unknown) =>
          (e as Record<string, unknown>).bot_id === 6 &&
          !("archetype" in (e as Record<string, unknown>)),
      );
      const crash_loop = events.filter(
        (e: unknown) => (e as Record<string, unknown>).archetype === "builder",
      );
      expect(released).toHaveLength(1);
      expect(crash_loop).toHaveLength(1);
    });
  });

  // ── notify() failure isolation ──

  describe("notify failure does not undo successful restart", () => {
    it("keeps bot assigned when notify throws after successful restart", async () => {
      mock_notify.mockRejectedValue(new Error("Discord API down"));

      const bot = make_bot({
        id: 7,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-notify-1",
      });
      pool.inject_bots([bot]);

      const restarted_events: unknown[] = [];
      const released_events: unknown[] = [];
      pool.on("bot:crash_restarted", (data) => restarted_events.push(data));
      pool.on("bot:released", (data) => released_events.push(data));

      await pool.run_health_check();

      // Bot should still be assigned — notify failure must not trigger
      // the catch block that frees the bot
      const bots = pool.get_bots();
      expect(bots[0].state).toBe("assigned");
      expect(bots[0].channel_id).toBe("ch-1");
      expect(bots[0].entity_id).toBe("test-entity");
      expect(bots[0].session_id).toBe("sess-notify-1");

      // start_tmux was called exactly once (the restart succeeded)
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);

      // crash_restarted event should still have fired (it's before notify)
      expect(restarted_events).toHaveLength(1);

      // bot:released must NOT have fired — the bot is still running
      expect(released_events).toHaveLength(0);
    });

    it("still emits bot:crash_loop when notify throws in crash loop path", async () => {
      mock_notify.mockRejectedValue(new Error("Discord API down"));

      const bot = make_bot({
        id: 8,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-notify-2",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes to trigger crash loop on the 4th
      const now = Date.now();
      pool.get_crash_history().set(8, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      const events: unknown[] = [];
      pool.on("bot:crash_loop", (data) => events.push(data));

      await pool.run_health_check();

      // crash_loop event should still have fired despite notify() throwing
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        bot_id: 8,
        entity_id: "test-entity",
        archetype: "builder",
      });
    });
  });

  // ── Alert channel label resolution ──

  describe("alert shows entity/channel-purpose format", () => {
    /** Inject a mock registry so pool can resolve channel purpose from config. */
    function inject_registry(
      pool_instance: TestBotPool,
      entity_id: string,
      channels: Array<{ type: string; id: string; purpose?: string }>,
    ): void {
      const fake_registry = {
        get: (eid: string) =>
          eid === entity_id
            ? {
                entity: {
                  id: entity_id,
                  channels: { category_id: "", list: channels },
                  secrets: {},
                  repos: [{ path: `/tmp/test-${entity_id}` }],
                },
              }
            : undefined,
      };
      (pool_instance as unknown as { registry: unknown }).registry = fake_registry;
    }

    it("restart alert shows entity/purpose when channel has purpose", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-workflows",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", [
        { type: "work_room", id: "ch-workflows", purpose: "workflows" },
      ]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("canal-street/workflows");
    });

    it("restart alert falls back to channel_id when no purpose", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-unknown-123",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", [
        { type: "work_room", id: "ch-unknown-123" }, // no purpose
      ]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("canal-street/ch-unknown-123");
    });

    it("restart alert falls back to channel_id when channel not in config", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-orphan",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", []); // empty channel list

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("canal-street/ch-orphan");
    });

    it("crash-loop alert shows entity/purpose", async () => {
      const bot = make_bot({
        id: 6,
        state: "assigned",
        channel_id: "ch-ar-site",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", [
        { type: "work_room", id: "ch-ar-site", purpose: "ar-site" },
      ]);

      // Pre-populate with 3 recent crashes to trigger crash loop
      const now = Date.now();
      pool.get_crash_history().set(6, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("crash loop");
      expect(message).toContain("canal-street/ar-site");
    });

    it("crash-loop alert falls back to channel_id when no purpose", async () => {
      const bot = make_bot({
        id: 6,
        state: "assigned",
        channel_id: "ch-mystery",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-loop-2",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", []); // no matching channel

      const now = Date.now();
      pool.get_crash_history().set(6, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("crash loop");
      expect(message).toContain("canal-street/ch-mystery");
    });
  });

  // ── Broker lazy/message-driven crash handling (#89, closes #83) ──
  //
  // Broker channels are lazy: a session exists iff an inbound drives it. A dead
  // broker session must be RELEASED to dark (history stashed for --resume, queue
  // preserved for redelivery), never respawned into an idle session. The 07-05
  // crash loop started because the watchdog respawned an idle session with no
  // turn-driver; these tests prove the loop can't even begin.
  describe("broker channels release to dark, never respawn (#89)", () => {
    const BROKER_CHANNEL = "ch-broker-pilot";

    function make_broker_config(): LobsterFarmConfig {
      return LobsterFarmConfigSchema.parse({
        user: { name: "Test" },
        paths: { lobsterfarm_dir: temp_dir },
        discord: {
          server_id: "guild-1",
          broker: { enabled: true, pilot_channels: [BROKER_CHANNEL] },
        },
      });
    }

    // Build a broker-enabled pool with the same side-effect stubs beforeEach
    // installs on the plugin pool. We can't reuse the outer `pool` because its
    // config has no broker block — uses_broker() would be false.
    function make_broker_pool(): { pool: TestBotPool; broker: DiscordBroker } {
      const broker_config = make_broker_config();
      const bpool = new TestBotPool(broker_config);
      const broker = new DiscordBroker({
        config: broker_config,
        socket_path: join(temp_dir, "b.sock"),
        queue_path: join(temp_dir, "q.json"),
      });
      bpool.set_broker(broker);

      vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "kill_tmux" as never,
      ).mockImplementation(() => {});
      vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "write_access_json" as never,
      ).mockResolvedValue(undefined);
      vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "set_bot_nickname" as never,
      ).mockResolvedValue(undefined);
      vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "set_bot_avatar" as never,
      ).mockResolvedValue(undefined);
      // Dead tmux for every session (crash scenario) unless a test overrides.
      vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "is_tmux_alive" as never,
      ).mockReturnValue(false);
      // Reuse the outer start_tmux spy so "not respawned" assertions can watch it.
      vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "start_tmux" as never,
      ).mockResolvedValue(undefined);
      return { pool: bpool, broker };
    }

    it("watchdog releases a dead broker session to dark, never respawns", async () => {
      const { pool: bpool } = make_broker_pool();
      const local_start = vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "start_tmux" as never,
      );
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: BROKER_CHANNEL,
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-broker-1",
        session_confirmed: true,
      });
      bpool.inject_bots([bot]);

      const released: unknown[] = [];
      bpool.on("bot:released", (d) => released.push(d));

      await bpool.run_health_check();

      // Released to dark — NOT respawned.
      expect(bpool.get_bots()[0].state).toBe("free");
      expect(bpool.get_bots()[0].channel_id).toBeNull();
      expect(local_start).not.toHaveBeenCalled();
      expect(released).toHaveLength(1);

      // Continuity: session_id stashed for the cold-recreate's --resume.
      expect(bpool.get_session_history().get(`test-entity:${BROKER_CHANNEL}`)).toBe(
        "sess-broker-1",
      );
    });

    it("old crash-loop scenario terminates: each respawned broker bot re-releases, zero respawns, zero crashes", async () => {
      const { pool: bpool } = make_broker_pool();
      const local_start = vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "start_tmux" as never,
      );

      // Reproduce the 07-05 loop, not just its first turn. The old watchdog killed
      // the dead broker tmux and RESPAWNED it into another assigned-but-idle bot,
      // whose tmux was again dead, which the next health tick respawned again — an
      // endless crash loop. To prove the fix breaks that loop we must simulate the
      // respawn: before every tick we re-inject a fresh assigned broker bot on the
      // SAME channel (what the old respawn would have produced) and assert this
      // tick releases IT to dark too — never respawns, never records a crash. If
      // any tick respawned, `start_tmux` would fire; if any tick took the plugin
      // crash path, `record_crash` would tick. Neither may happen on any iteration.
      const bot_ids = [40, 41, 42];
      for (const id of bot_ids) {
        // Simulate the respawn that the old watchdog would have created.
        const respawned = make_bot({
          id,
          state: "assigned",
          channel_id: BROKER_CHANNEL,
          entity_id: "test-entity",
          archetype: "planner",
          session_id: `sess-broker-loop-${String(id)}`,
          session_confirmed: true,
        });
        bpool.inject_bots([respawned]);

        await bpool.run_health_check();

        // This respawned bot was released to dark, not respawned into idle again.
        const [after] = bpool.get_bots();
        expect(after.id).toBe(id);
        expect(after.state).toBe("free");
        expect(after.channel_id).toBeNull();
        // Its crash counter never ticked — the broker release short-circuits
        // BEFORE record_crash, so the loop's restart-counter never starts.
        expect(bpool.get_crash_history().get(id) ?? []).toHaveLength(0);
      }

      // Across the whole simulated loop: not a single respawn.
      expect(local_start).not.toHaveBeenCalled();
    });

    it("restart-time reconcile releases a half-spawned broker bot to dark, no respawn", async () => {
      const { pool: bpool } = make_broker_pool();
      const local_start = vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "start_tmux" as never,
      );
      // A broker bot that came back `assigned` with dead tmux but was NOT a resume
      // candidate (unconfirmed at drain) — the #66 half-spawn case.
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: BROKER_CHANNEL,
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-broker-half",
        session_confirmed: true,
      });
      bpool.inject_bots([bot]);

      await bpool.run_reconcile();

      expect(local_start).not.toHaveBeenCalled();
      expect(bpool.get_bots()[0].state).toBe("free");
      expect(bpool.get_bots()[0].channel_id).toBeNull();
    });

    it("does NOT stash an unconfirmed broker session (no phantom --resume, #256)", async () => {
      const { pool: bpool } = make_broker_pool();
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: BROKER_CHANNEL,
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-unconfirmed",
        session_confirmed: false, // never wrote a JSONL turn
      });
      bpool.inject_bots([bot]);

      await bpool.run_health_check();

      expect(bpool.get_bots()[0].state).toBe("free");
      // Unconfirmed → not stashed, so the cold-recreate spawns fresh instead of
      // --resume-ing a phantom UUID.
      expect(bpool.get_session_history().has(`test-entity:${BROKER_CHANNEL}`)).toBe(false);
    });

    it("PLUGIN channel is unaffected — still respawns on dead tmux (flag-scoped)", async () => {
      // Same broker-enabled config, but this channel is NOT in the pilot allowlist
      // → uses_broker() is false → unchanged plugin respawn path.
      const { pool: bpool } = make_broker_pool();
      const local_start = vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "start_tmux" as never,
      );
      const bot = make_bot({
        id: 7,
        state: "assigned",
        channel_id: "ch-plugin-not-pilot",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-plugin",
        session_confirmed: true,
      });
      bpool.inject_bots([bot]);

      await bpool.run_health_check();

      // Plugin path: respawned, stays assigned.
      expect(local_start).toHaveBeenCalledTimes(1);
      expect(bpool.get_bots()[0].state).toBe("assigned");
    });

    it("proactive-resume-on-restart skips a broker channel — no spawn, stays dark", async () => {
      const { pool: bpool } = make_broker_pool();
      const local_start = vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "start_tmux" as never,
      );
      // A broker bot that was assigned before shutdown — restored as `parked`,
      // queued for proactive-resume.
      const bot = make_bot({
        id: 3,
        state: "parked",
        channel_id: BROKER_CHANNEL,
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-parked-broker",
        session_confirmed: true,
      });
      bpool.inject_bots([bot]);
      bpool.set_resume_candidates([
        {
          id: 3,
          state: "parked",
          channel_id: BROKER_CHANNEL,
          entity_id: "test-entity",
          archetype: "planner",
          channel_type: "general",
          session_id: "sess-parked-broker",
          last_active: null,
        },
      ]);

      await bpool.run_resume();

      // Never spawned an idle session — the channel goes dark.
      expect(local_start).not.toHaveBeenCalled();
      expect(bpool.get_bots()[0].state).toBe("free");
      expect(bpool.get_bots()[0].channel_id).toBeNull();
      // Continuity preserved for the cold-recreate: session_id stashed for --resume.
      expect(bpool.get_session_history().get(`test-entity:${BROKER_CHANNEL}`)).toBe(
        "sess-parked-broker",
      );
    });

    it("proactive-resume still resumes a PLUGIN channel (flag-scoped)", async () => {
      const { pool: bpool } = make_broker_pool();
      const local_start = vi.spyOn(
        bpool as unknown as Record<string, unknown>,
        "start_tmux" as never,
      );
      // A non-pilot channel under the same broker-enabled config — uses_broker() is
      // false, so the unchanged proactive-resume path spawns it.
      const bot = make_bot({
        id: 8,
        state: "parked",
        channel_id: "ch-plugin-not-pilot",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-parked-plugin",
        session_confirmed: true,
      });
      bpool.inject_bots([bot]);
      bpool.set_resume_candidates([
        {
          id: 8,
          state: "parked",
          channel_id: "ch-plugin-not-pilot",
          entity_id: "test-entity",
          archetype: "planner",
          channel_type: "general",
          session_id: "sess-parked-plugin",
          last_active: null,
        },
      ]);

      await bpool.run_resume();

      // Plugin path: resumed with --resume, stays assigned.
      expect(local_start).toHaveBeenCalledTimes(1);
      const call = local_start.mock.calls[0] as unknown[];
      expect(call[4]).toBe("sess-parked-plugin"); // session_id
      expect(call[5]).toBe(true); // is_resume
      expect(bpool.get_bots()[0].state).toBe("assigned");
    });
  });

  describe("flag OFF is byte-identical to the plugin path (#89 merge-safety)", () => {
    // The outer `pool` uses make_config() — NO discord.broker block, and no
    // set_broker() call — mirroring index.ts when broker.enabled is false. Every
    // #89 branch gates on uses_broker(), which returns false here, so the modified
    // drivers behave exactly like today's plugin path.

    it("uses_broker() is false with the flag off — even for a would-be pilot channel id", () => {
      // No broker wired at all → the gate is false regardless of channel id.
      expect(pool.is_broker_channel("ch-broker-pilot")).toBe(false);
      expect(pool.is_broker_channel("any-channel")).toBe(false);
    });

    it("a dead session still RESPAWNS via the plugin path (no release-to-dark)", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-broker-pilot", // pilot-looking id, but flag is OFF
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-off",
        session_confirmed: true,
      });
      pool.inject_bots([bot]);
      mock_is_tmux_alive.mockReturnValue(false);

      await pool.run_health_check();

      // Unchanged plugin behavior: respawned + stays assigned, NOT released to dark.
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
      expect(pool.get_bots()[0].state).toBe("assigned");
    });

    it("proactive-resume still resumes a would-be pilot channel with the flag off", async () => {
      const bot = make_bot({
        id: 3,
        state: "parked",
        channel_id: "ch-broker-pilot",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-off-parked",
        session_confirmed: true,
      });
      pool.inject_bots([bot]);
      mock_is_tmux_alive.mockReturnValue(false);
      pool.set_resume_candidates([
        {
          id: 3,
          state: "parked",
          channel_id: "ch-broker-pilot",
          entity_id: "test-entity",
          archetype: "planner",
          channel_type: "general",
          session_id: "sess-off-parked",
          last_active: null,
        },
      ]);

      await pool.run_resume();

      // Plugin proactive-resume: spawned with --resume, stays assigned.
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
      expect(pool.get_bots()[0].state).toBe("assigned");
    });
  });
});
