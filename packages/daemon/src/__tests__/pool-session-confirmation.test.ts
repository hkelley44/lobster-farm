import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process BEFORE importing the module under test so the
// spawn() used inside pool.ts routes through our stub. We capture every call
// on a module-level array and assert against it in the #260 test below.
const spawn_calls: unknown[][] = [];
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawn_calls.push(args);
      const fake = new EventEmitter() as EventEmitter & { unref: () => void; kill: () => void };
      fake.unref = () => {};
      fake.kill = () => {};
      setImmediate(() => fake.emit("close", 0));
      return fake as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

import { save_pool_state } from "../persistence.js";
import type { PersistedPoolBot } from "../persistence.js";
import { BotPool, encode_project_slug } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

async function seed_pool_dir(id: number): Promise<void> {
  const dir = join(temp_dir, "channels", `pool-${String(id)}`);
  await mkdir(dir, { recursive: true });
  // bot_user_id_from_token() parses a Discord token as base64. Use a
  // syntactically valid fake — the first segment decodes to "12345".
  await writeFile(join(dir, ".env"), "DISCORD_BOT_TOKEN=MTIzNDU.abc.def", "utf-8");
}

function make_persisted(overrides: Partial<PersistedPoolBot> & { id: number }): PersistedPoolBot {
  return {
    state: "assigned",
    channel_id: "ch-100",
    entity_id: "test-entity",
    archetype: "builder",
    channel_type: null,
    session_id: null,
    last_active: null,
    ...overrides,
  };
}

/**
 * TestBotPool variant for session-confirmation tests.
 *
 * Unlike the helpers in other test files, this subclass exposes the JSONL
 * existence check so individual tests can control whether a session is
 * considered "real" or "phantom". Watch timer is disabled to avoid bleeding
 * into afterEach teardown.
 */
class TestBotPool extends BotPool {
  /** Set of session_ids that tests should treat as having a JSONL on disk. */
  public existing_sessions = new Set<string>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }

  /** Spy-ready accessor for the crash_history map. */
  get_crash_history(): Map<number, number[]> {
    return (this as unknown as { crash_history: Map<number, number[]> }).crash_history;
  }

  protected override is_bot_idle(): boolean {
    return true;
  }

  protected override check_session_jsonl_exists_anywhere(session_id: string): Promise<boolean> {
    return Promise.resolve(this.existing_sessions.has(session_id));
  }

  protected override check_session_jsonl_exists(
    _working_dir: string,
    session_id: string,
  ): Promise<boolean> {
    return Promise.resolve(this.existing_sessions.has(session_id));
  }

  /** Disable real watcher — its deferred persist races with rm on teardown. */
  protected override watch_session_confirmation(bot: PoolBot): void {
    bot.session_confirmed = true;
  }
}

// ── #256: session_id persistence hardening ──

describe("pool session confirmation hardening (#256)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pool-confirm-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    // Stub all side effects that would otherwise touch tmux/FS.
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
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      false,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  describe("initialize() phantom filtering", () => {
    it("drops persisted session_id when its JSONL does not exist on disk", async () => {
      await seed_pool_dir(1);
      await save_pool_state(
        [
          make_persisted({
            id: 1,
            state: "parked",
            session_id: "sess-phantom-abc",
            channel_id: "ch-1",
          }),
        ],
        config,
      );

      const fresh = new TestBotPool(config);
      vi.spyOn(
        fresh as unknown as Record<string, unknown>,
        "is_tmux_alive" as never,
      ).mockReturnValue(false);
      // existing_sessions is empty — phantom should be dropped
      await fresh.initialize();

      const bots = fresh.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.session_id).toBeNull();
      expect(bots[0]!.session_confirmed).toBe(false);
    });

    it("keeps persisted session_id when its JSONL is on disk", async () => {
      await seed_pool_dir(1);
      await save_pool_state(
        [
          make_persisted({
            id: 1,
            state: "parked",
            session_id: "sess-real-xyz",
            channel_id: "ch-1",
          }),
        ],
        config,
      );

      const fresh = new TestBotPool(config);
      fresh.existing_sessions.add("sess-real-xyz");
      vi.spyOn(
        fresh as unknown as Record<string, unknown>,
        "is_tmux_alive" as never,
      ).mockReturnValue(false);
      await fresh.initialize();

      const bots = fresh.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.session_id).toBe("sess-real-xyz");
      expect(bots[0]!.session_confirmed).toBe(true);
    });

    it("drops phantom session_history entries", async () => {
      await seed_pool_dir(1);
      await save_pool_state([], config, {
        "e1:ch-dead": "sess-dead",
        "e1:ch-alive": "sess-alive",
      });

      const fresh = new TestBotPool(config);
      fresh.existing_sessions.add("sess-alive");
      await fresh.initialize();

      const history = fresh.get_session_history();
      expect(history.get("e1:ch-dead")).toBeUndefined();
      expect(history.get("e1:ch-alive")).toBe("sess-alive");
    });
  });

  describe("persist() gate", () => {
    it("writes null for unconfirmed session_id to avoid planting phantoms", async () => {
      pool.inject_bots([
        {
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          channel_type: "general",
          session_id: "sess-fresh-unconfirmed",
          session_confirmed: false,
          tmux_session: "pool-1",
          last_active: null,
          assigned_at: null,
          state_dir: "/tmp/pool-1",
          model: null,
          effort: null,
          last_avatar_archetype: null,
          last_avatar_set_at: null,
        },
      ]);

      // Use the private persist() method via bracket notation
      await (pool as unknown as { persist: () => Promise<void> }).persist();

      const { load_pool_state } = await import("../persistence.js");
      const state = await load_pool_state(config);
      expect(state.bots).toHaveLength(1);
      expect(state.bots[0]!.session_id).toBeNull();
    });

    it("writes real session_id for confirmed bots", async () => {
      pool.inject_bots([
        {
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          channel_type: "general",
          session_id: "sess-confirmed",
          session_confirmed: true,
          tmux_session: "pool-1",
          last_active: null,
          assigned_at: null,
          state_dir: "/tmp/pool-1",
          model: null,
          effort: null,
          last_avatar_archetype: null,
          last_avatar_set_at: null,
        },
      ]);

      await (pool as unknown as { persist: () => Promise<void> }).persist();

      const { load_pool_state } = await import("../persistence.js");
      const state = await load_pool_state(config);
      expect(state.bots[0]!.session_id).toBe("sess-confirmed");
    });
  });

  describe("handle_crash_loop() phantom guard", () => {
    it("does not stash an unconfirmed session into session_history", async () => {
      pool.inject_bots([
        {
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          channel_type: "general",
          session_id: "sess-unconfirmed",
          session_confirmed: false,
          tmux_session: "pool-1",
          last_active: null,
          assigned_at: null,
          state_dir: "/tmp/pool-1",
          model: null,
          effort: null,
          last_avatar_archetype: null,
          last_avatar_set_at: null,
        },
      ]);

      await (
        pool as unknown as { handle_crash_loop: (b: PoolBot) => Promise<void> }
      ).handle_crash_loop(pool.get_bots()[0]!);

      expect(pool.get_session_history().get("e1:ch-1")).toBeUndefined();
    });

    it("does not stash a confirmed-but-missing-JSONL session into session_history", async () => {
      pool.inject_bots([
        {
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          channel_type: "general",
          session_id: "sess-was-confirmed",
          session_confirmed: true,
          tmux_session: "pool-1",
          last_active: null,
          assigned_at: null,
          state_dir: "/tmp/pool-1",
          model: null,
          effort: null,
          last_avatar_archetype: null,
          last_avatar_set_at: null,
        },
      ]);
      // existing_sessions is empty → JSONL missing
      await (
        pool as unknown as { handle_crash_loop: (b: PoolBot) => Promise<void> }
      ).handle_crash_loop(pool.get_bots()[0]!);

      expect(pool.get_session_history().get("e1:ch-1")).toBeUndefined();
    });

    it("stashes a confirmed session whose JSONL is still on disk", async () => {
      pool.existing_sessions.add("sess-real");
      pool.inject_bots([
        {
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          channel_type: "general",
          session_id: "sess-real",
          session_confirmed: true,
          tmux_session: "pool-1",
          last_active: null,
          assigned_at: null,
          state_dir: "/tmp/pool-1",
          model: null,
          effort: null,
          last_avatar_archetype: null,
          last_avatar_set_at: null,
        },
      ]);

      await (
        pool as unknown as { handle_crash_loop: (b: PoolBot) => Promise<void> }
      ).handle_crash_loop(pool.get_bots()[0]!);

      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-real");
    });
  });
});

// ── encode_project_slug helper (#256) ──

describe("encode_project_slug", () => {
  it("replaces slashes and dots with dashes", () => {
    expect(encode_project_slug("/Users/me/.lobsterfarm/entities/foo")).toBe(
      "-Users-me--lobsterfarm-entities-foo",
    );
  });
});

// ── #260: --add-dir defaults ──
// spawn() is mocked at the top of the file to capture tmux invocations.

describe("start_tmux --add-dir defaults (#260)", () => {
  it("includes ~/.claude and /tmp in the trusted directory set", async () => {
    spawn_calls.length = 0;
    temp_dir = await mkdtemp(join(tmpdir(), "pool-adddir-test-"));
    const config = make_config();
    const pool = new TestBotPool(config);

    // is_tmux_alive → false so start_tmux short-circuits after spawn resolves
    // (it only does the trust-dialog send-keys if tmux_alive returns true).
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      false,
    );

    const start_tmux = (
      pool as unknown as {
        start_tmux: (
          bot: PoolBot,
          archetype: string,
          entity_id: string,
          working_dir: string,
          session_id: string,
          is_resume?: boolean,
        ) => Promise<void>;
      }
    ).start_tmux.bind(pool);

    const bot: PoolBot = {
      id: 0,
      state: "free",
      channel_id: "ch-1",
      entity_id: "e1",
      archetype: "builder",
      channel_type: "general",
      session_id: null,
      session_confirmed: false,
      tmux_session: "pool-0",
      last_active: null,
      assigned_at: null,
      state_dir: join(temp_dir, "pool-0"),
      model: null,
      effort: null,
      last_avatar_archetype: null,
      last_avatar_set_at: null,
    };

    try {
      await start_tmux(bot, "builder", "e1", join(temp_dir, "work"), "sess-test", false);
    } catch {
      // start_tmux throws when is_tmux_alive returns false — but spawn_spy
      // has already captured the command string we care about.
    }

    // Find the tmux spawn call (there may also be an unrelated spawn earlier).
    const tmux_call = spawn_calls.find((c) => c[0] === "tmux");
    expect(tmux_call).toBeDefined();
    const argv = tmux_call![1] as string[];
    // The last element is the DISCORD_STATE_DIR=... <git_env> <claude_cmd> string.
    const claude_cmd = argv[argv.length - 1]!;
    expect(claude_cmd).toContain("--add-dir");
    // ~/.claude should be expanded to an absolute path containing ".claude"
    expect(claude_cmd).toMatch(/--add-dir\s+'[^']*\.claude'/);
    expect(claude_cmd).toContain("--add-dir '/tmp'");

    await rm(temp_dir, { recursive: true, force: true });
  });
});

// ── watch_session_confirmation timer loop ──
// These tests exercise the REAL watcher (no override) with fake timers
// to verify the poll loop's branching: confirmation, exhaustion, and
// mid-poll reassignment.

describe("watch_session_confirmation timer loop", () => {
  /**
   * Subclass that runs the REAL watch_session_confirmation — only the JSONL
   * check is overridden, returning results from a test-controlled Set.
   */
  class RealWatcherTestPool extends BotPool {
    public existing_sessions = new Set<string>();

    /** Hook fired inside check_session_jsonl_exists — lets tests simulate
     * side effects during the async suspension window (e.g. bot reassignment). */
    public on_check_hook: (() => void) | null = null;

    inject_bots(bots: PoolBot[]): void {
      (this as unknown as { bots: PoolBot[] }).bots = bots;
    }

    get_bots(): PoolBot[] {
      return (this as unknown as { bots: PoolBot[] }).bots;
    }

    protected override is_bot_idle(): boolean {
      return true;
    }

    protected override check_session_jsonl_exists_anywhere(session_id: string): Promise<boolean> {
      return Promise.resolve(this.existing_sessions.has(session_id));
    }

    protected override async check_session_jsonl_exists(
      _working_dir: string,
      session_id: string,
    ): Promise<boolean> {
      // Fire the hook before returning — simulates work happening during
      // the async suspension in the real watcher tick.
      this.on_check_hook?.();
      return this.existing_sessions.has(session_id);
    }
  }

  let pool: RealWatcherTestPool;

  function make_watcher_bot(overrides?: Partial<PoolBot>): PoolBot {
    return {
      id: 1,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "e1",
      archetype: "builder",
      channel_type: "general",
      session_id: "sess-watch-test",
      session_confirmed: false,
      tmux_session: "pool-1",
      last_active: null,
      assigned_at: null,
      state_dir: "/tmp/pool-1",
      model: null,
      effort: null,
      last_avatar_archetype: null,
      last_avatar_set_at: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    temp_dir = await mkdtemp(join(tmpdir(), "pool-watcher-test-"));
    const config = make_config();
    pool = new RealWatcherTestPool(config);
  });

  afterEach(async () => {
    // Cancel any in-flight watchers so timers don't leak into other tests
    await (pool as unknown as { shutdown: () => Promise<void> }).shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("promotes session_confirmed and calls persist when JSONL appears on tick 3", async () => {
    const bot = make_watcher_bot();
    pool.inject_bots([bot]);
    const persist_spy = vi
      .spyOn(pool as unknown as { persist: () => Promise<void> }, "persist" as never)
      .mockResolvedValue(undefined as never);
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Start the real watcher
    (
      pool as unknown as {
        watch_session_confirmation: (b: PoolBot, wd: string, sid: string) => void;
      }
    ).watch_session_confirmation(bot, "/tmp/work", "sess-watch-test");

    // Tick 1 (t=0): JSONL not found
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.session_confirmed).toBe(false);

    // Tick 2 (t=500): JSONL still not found
    await vi.advanceTimersByTimeAsync(500);
    expect(bot.session_confirmed).toBe(false);

    // JSONL appears before tick 3
    pool.existing_sessions.add("sess-watch-test");

    // Tick 3 (t=1000): JSONL found → confirmed
    await vi.advanceTimersByTimeAsync(500);
    expect(bot.session_confirmed).toBe(true);
    expect(persist_spy).toHaveBeenCalledOnce();
    expect(log_spy).toHaveBeenCalledWith(expect.stringContaining("confirmed"));
  });

  it("gives up after max_attempts without setting session_confirmed", async () => {
    const bot = make_watcher_bot();
    pool.inject_bots([bot]);
    const persist_spy = vi
      .spyOn(pool as unknown as { persist: () => Promise<void> }, "persist" as never)
      .mockResolvedValue(undefined as never);
    const warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    (
      pool as unknown as {
        watch_session_confirmation: (b: PoolBot, wd: string, sid: string) => void;
      }
    ).watch_session_confirmation(bot, "/tmp/work", "sess-watch-test");

    // Advance past all 120 attempts: first tick at 0ms, then 119 * 500ms = 59500ms
    // Use 61000ms to ensure we're past the full window.
    await vi.advanceTimersByTimeAsync(61_000);

    expect(bot.session_confirmed).toBe(false);
    expect(persist_spy).not.toHaveBeenCalled();
    expect(warn_spy).toHaveBeenCalledWith(expect.stringContaining("unconfirmed"));
  });

  it("aborts when bot is reassigned during the async check_session_jsonl_exists call", async () => {
    const bot = make_watcher_bot();
    pool.inject_bots([bot]);
    const persist_spy = vi
      .spyOn(pool as unknown as { persist: () => Promise<void> }, "persist" as never)
      .mockResolvedValue(undefined as never);

    // During the JSONL check, reassign the bot to a different session —
    // simulates a message arriving while the filesystem call is in flight.
    pool.on_check_hook = () => {
      bot.session_id = "sess-different";
    };

    // Make the JSONL exist for the original session — the watcher should
    // still abort because the bot was reassigned mid-check.
    pool.existing_sessions.add("sess-watch-test");

    (
      pool as unknown as {
        watch_session_confirmation: (b: PoolBot, wd: string, sid: string) => void;
      }
    ).watch_session_confirmation(bot, "/tmp/work", "sess-watch-test");

    // First tick fires and hits the post-await re-check guard
    await vi.advanceTimersByTimeAsync(0);

    // Bot should NOT be confirmed — the session_id changed mid-tick
    expect(bot.session_confirmed).toBe(false);
    expect(persist_spy).not.toHaveBeenCalled();
  });
});
