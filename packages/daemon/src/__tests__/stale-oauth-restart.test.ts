import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

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
 * Test-friendly BotPool subclass that stubs tmux/filesystem side effects.
 * Adds control over stale OAuth detection via pane_stale_overrides.
 */
class TestBotPool extends BotPool {
  private tmux_alive_overrides = new Map<string, boolean>();
  private pane_stale_overrides = new Map<string, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }

  /** Control whether is_tmux_alive returns true/false per session name. */
  set_tmux_alive(session_name: string, alive: boolean): void {
    this.tmux_alive_overrides.set(session_name, alive);
  }

  /** Control whether is_pane_stale_oauth returns true/false per session name. */
  set_pane_stale(session_name: string, stale: boolean): void {
    this.pane_stale_overrides.set(session_name, stale);
  }

  /** Override is_bot_idle — not the focus of these tests. */
  protected override is_bot_idle(_bot: PoolBot): boolean {
    return true;
  }

  /** Override is_pane_stale_oauth to use test-controlled map instead of tmux. */
  protected override is_pane_stale_oauth(session_name: string): boolean {
    return this.pane_stale_overrides.get(session_name) ?? false;
  }
}

// ── Tests ──

describe("stale OAuth detection and restart (issue #184)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "stale-oauth-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out side effects that touch the filesystem and tmux
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
    vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never).mockResolvedValue(
      undefined,
    );
    vi.spyOn(pool as unknown as Record<string, unknown>, "park_bot" as never).mockImplementation(
      async (bot: PoolBot) => {
        bot.state = "parked";
      },
    );

    // Default: tmux is alive (we're testing the stale-but-alive case)
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "is_tmux_alive" as never,
    ).mockImplementation((session_name: string) => {
      return pool["tmux_alive_overrides" as keyof typeof pool]
        ? ((
            pool as unknown as { tmux_alive_overrides: Map<string, boolean> }
          ).tmux_alive_overrides.get(session_name) ?? true)
        : true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  // ── has_stale_oauth() ──

  describe("has_stale_oauth()", () => {
    it("returns true when bot is assigned and pane shows 'Not logged in'", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: "sess-stale",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", true);
      pool.set_pane_stale("pool-1", true);

      expect(pool.has_stale_oauth(1)).toBe(true);
    });

    it("returns false when bot is assigned and pane is healthy", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: "sess-healthy",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", true);
      pool.set_pane_stale("pool-1", false);

      expect(pool.has_stale_oauth(1)).toBe(false);
    });

    it("returns false when bot is not assigned (free)", () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      expect(pool.has_stale_oauth(1)).toBe(false);
    });

    it("returns false when bot is parked", () => {
      pool.inject_bots([make_bot({ id: 1, state: "parked", channel_id: "ch-1", entity_id: "e1" })]);

      expect(pool.has_stale_oauth(1)).toBe(false);
    });

    it("returns false for a bot_id that does not exist", () => {
      pool.inject_bots([]);

      expect(pool.has_stale_oauth(999)).toBe(false);
    });
  });

  // ── kill_stale_session() ──

  describe("kill_stale_session()", () => {
    it("calls kill_tmux for the bot's tmux session", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-kill-me",
      });
      pool.inject_bots([bot]);

      const kill_spy = vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never);

      pool.kill_stale_session(1);

      expect(kill_spy).toHaveBeenCalledWith("pool-1");
    });

    it("is a no-op for a bot_id that does not exist", () => {
      pool.inject_bots([]);

      const kill_spy = vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never);

      pool.kill_stale_session(999);

      expect(kill_spy).not.toHaveBeenCalled();
    });
  });

  // ── End-to-end: stale OAuth -> kill -> release_with_history -> reassign resumes ──

  describe("end-to-end: stale OAuth -> kill -> release_with_history -> reassign resumes", () => {
    it("kill + release_with_history followed by assign picks up stashed session", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: "sess-stale-oauth",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", true);
      pool.set_pane_stale("pool-1", true);

      // Verify the bot is detected as stale
      expect(pool.has_stale_oauth(1)).toBe(true);

      // Step 1: kill the stale tmux session
      pool.kill_stale_session(1);

      // Step 2: release_with_history stashes the session_id
      await pool.release_with_history(1);

      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-stale-oauth");

      const released_bot = pool.get_bots().find((b) => b.id === 1)!;
      expect(released_bot.state).toBe("free");
      expect(released_bot.session_id).toBeNull();

      // Step 3: re-assign picks up the stashed session for resume
      pool.set_tmux_alive("pool-1", true);
      pool.set_pane_stale("pool-1", false); // Fresh CLI will be healthy

      const result = await pool.assign("ch-1", "e1", "planner", undefined, "work_room");
      expect(result).toBeDefined();

      // The assign flow should have used the stashed session_id for --resume
      const start_tmux_spy = pool["start_tmux" as keyof typeof pool] as unknown as {
        mock: { calls: unknown[][] };
      };
      const last_call = start_tmux_spy.mock.calls[start_tmux_spy.mock.calls.length - 1]!;
      expect(last_call[4]).toBe("sess-stale-oauth"); // session_id preserved
      expect(last_call[5]).toBe(true); // is_resume = true
    });

    it("session history is cleared after successful resume assignment", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-to-resume",
      });
      pool.inject_bots([bot]);

      // Simulate: kill + release_with_history
      pool.kill_stale_session(1);
      await pool.release_with_history(1);

      expect(pool.get_session_history().has("e1:ch-1")).toBe(true);

      // Re-assign — should consume the stashed session
      pool.set_tmux_alive("pool-1", true);
      pool.set_pane_stale("pool-1", false);
      await pool.assign("ch-1", "e1", "builder", undefined, "work_room");

      // History should be consumed after the assign
      expect(pool.get_session_history().has("e1:ch-1")).toBe(false);
    });
  });
});
