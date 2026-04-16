/**
 * Tests for the typing loop grace period and idle detection hardening (#280).
 *
 * The typing loop polls is_bot_idle every 4 seconds to determine when to
 * finalize the status embed. Three defenses prevent premature finalization:
 * 1. A 15-second grace period — no idle checks at all during MCP delivery
 * 2. IDLE_THRESHOLD of 3 — requires 12 seconds of consecutive idle after grace
 * 3. "← discord" pane indicator — resets consecutive idle when MCP push is in flight
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

// Mock child_process before importing modules that use it at parse time
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(""),
    spawn: vi.fn(),
  };
});

// Mock discord.js to avoid real WebSocket connections
vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn(),
      destroy: vi.fn(),
      user: null,
      channels: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
      application: null,
    })),
  };
});

import { execFileSync } from "node:child_process";
import { DiscordBot } from "../discord.js";
import type { BotPool, PoolBot } from "../pool.js";
import { EntityRegistry } from "../registry.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

/** Minimal PoolBot shape for testing. */
function make_pool_bot(id = 0): PoolBot {
  return {
    id,
    state: "assigned",
    channel_id: "test-channel",
    entity_id: "test-entity",
    archetype: "planner",
    channel_type: "general",
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(id)}`,
    last_active: new Date(),
    assigned_at: new Date(),
    state_dir: `/tmp/test-pool-${String(id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
  };
}

/** Create a mock BotPool with controllable idle/oauth behavior. */
function make_mock_pool(opts?: {
  idle?: boolean;
  stale_oauth?: boolean;
  bot?: PoolBot | null;
}): BotPool {
  const bot = opts?.bot ?? make_pool_bot();
  return {
    get_assignment: vi.fn().mockReturnValue(opts?.bot === null ? null : bot),
    is_bot_idle: vi.fn().mockReturnValue(opts?.idle ?? false),
    has_stale_oauth: vi.fn().mockReturnValue(opts?.stale_oauth ?? false),
    kill_stale_session: vi.fn(),
    release_with_history: vi.fn().mockResolvedValue(undefined),
    set_nickname_handler: vi.fn(),
    set_avatar_handler: vi.fn(),
    on: vi.fn().mockReturnThis(),
  } as unknown as BotPool;
}

/**
 * Test-friendly DiscordBot subclass. Exposes typing loop state and
 * stubs methods that would hit Discord's API.
 */
class TestDiscordBot extends DiscordBot {
  finalize_calls: string[] = [];

  constructor(config: LobsterFarmConfig, registry: EntityRegistry) {
    super(config, registry);
    // Override finalize_status_embed to track calls without Discord API
    (this as unknown as Record<string, unknown>).finalize_status_embed = vi
      .fn()
      .mockImplementation((channel_id: string) => {
        this.finalize_calls.push(channel_id);
        return Promise.resolve();
      });

    // Override update_status_embed_from_tmux to no-op (avoids tmux + Discord calls)
    (this as unknown as Record<string, unknown>).update_status_embed_from_tmux = vi
      .fn()
      .mockResolvedValue(undefined);
  }

  /** Check if a typing loop is active for the given channel. */
  has_typing_loop(channel_id: string): boolean {
    return (this as unknown as { typing_loops: Map<string, NodeJS.Timeout> }).typing_loops.has(
      channel_id,
    );
  }
}

// ── Setup / teardown ──

beforeEach(async () => {
  temp_dir = await mkdtemp(join(tmpdir(), "lf-typing-loop-test-"));
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(temp_dir, { recursive: true, force: true });
});

// ── Tests ──

describe("start_typing_loop — grace period (#280)", () => {
  it("does not finalize during the 15-second grace period even when bot appears idle", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    bot.start_typing_loop("test-channel");

    // Advance through 3 ticks (0s, 4s, 8s, 12s) — all within the 15s grace period
    vi.advanceTimersByTime(4000); // tick 1 @ 4s
    vi.advanceTimersByTime(4000); // tick 2 @ 8s
    vi.advanceTimersByTime(4000); // tick 3 @ 12s

    // The bot reports idle every tick, but grace period should prevent finalization
    expect(bot.finalize_calls).toHaveLength(0);
    expect(bot.has_typing_loop("test-channel")).toBe(true);
  });

  it("starts checking idle after grace period expires", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    // Mock execFileSync to return no "← discord" indicator
    (execFileSync as Mock).mockReturnValue("some output\n❯ ");

    bot.start_typing_loop("test-channel");

    // Advance past the 15s grace period
    vi.advanceTimersByTime(16000); // tick 1-4 covered, now past grace period

    // Now idle checks start. Need IDLE_THRESHOLD (3) consecutive idle ticks to finalize.
    // At 16s we're past grace — the tick at 16s is the first idle check.
    // Next ticks at 20s, 24s would be #2 and #3.
    vi.advanceTimersByTime(4000); // tick at 20s — consecutive_idle = 2
    vi.advanceTimersByTime(4000); // tick at 24s — consecutive_idle = 3 → finalize

    expect(bot.finalize_calls).toHaveLength(1);
    expect(bot.finalize_calls[0]).toBe("test-channel");
    expect(bot.has_typing_loop("test-channel")).toBe(false);
  });
});

describe("start_typing_loop — IDLE_THRESHOLD = 3 (#280)", () => {
  it("requires 3 consecutive idle checks (~12s) before finalizing", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    // No "← discord" indicator in pane
    (execFileSync as Mock).mockReturnValue("some output\n❯ ");

    bot.start_typing_loop("test-channel");

    // Skip past grace period
    vi.advanceTimersByTime(16000);

    // First idle check (post-grace) — consecutive_idle = 1
    expect(bot.finalize_calls).toHaveLength(0);

    vi.advanceTimersByTime(4000); // consecutive_idle = 2
    expect(bot.finalize_calls).toHaveLength(0);

    vi.advanceTimersByTime(4000); // consecutive_idle = 3 → finalize
    expect(bot.finalize_calls).toHaveLength(1);
  });

  it("resets idle counter when bot becomes active between checks", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    (execFileSync as Mock).mockReturnValue("some output\n❯ ");

    bot.start_typing_loop("test-channel");

    // Skip past grace period
    vi.advanceTimersByTime(16000); // post-grace, consecutive_idle = 1

    vi.advanceTimersByTime(4000); // consecutive_idle = 2

    // Bot becomes active (not idle)
    (pool.is_bot_idle as Mock).mockReturnValue(false);
    vi.advanceTimersByTime(4000); // consecutive_idle reset to 0

    // Bot goes idle again
    (pool.is_bot_idle as Mock).mockReturnValue(true);
    vi.advanceTimersByTime(4000); // consecutive_idle = 1
    vi.advanceTimersByTime(4000); // consecutive_idle = 2

    // Still not finalized — need 3 consecutive
    expect(bot.finalize_calls).toHaveLength(0);

    vi.advanceTimersByTime(4000); // consecutive_idle = 3 → finalize
    expect(bot.finalize_calls).toHaveLength(1);
  });
});

describe("start_typing_loop — MCP delivery indicator (#280)", () => {
  it("resets idle counter when '← discord' is in the tmux pane", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    bot.start_typing_loop("test-channel");

    // Skip past grace period
    vi.advanceTimersByTime(16000); // post-grace, first idle check

    // The pane shows "← discord" — MCP is delivering a message
    (execFileSync as Mock).mockReturnValue("← discord\n❯ ");
    vi.advanceTimersByTime(4000); // idle + "← discord" → consecutive_idle reset to 0

    // Now the indicator is gone, bot is still idle
    (execFileSync as Mock).mockReturnValue("some output\n❯ ");
    vi.advanceTimersByTime(4000); // consecutive_idle = 1
    vi.advanceTimersByTime(4000); // consecutive_idle = 2

    // Not finalized yet — need 3 consecutive after the reset
    expect(bot.finalize_calls).toHaveLength(0);

    vi.advanceTimersByTime(4000); // consecutive_idle = 3 → finalize
    expect(bot.finalize_calls).toHaveLength(1);
  });

  it("handles tmux capture failure gracefully (falls through to normal idle)", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    bot.start_typing_loop("test-channel");

    // Skip past grace period
    vi.advanceTimersByTime(16000);

    // Make the tmux capture-pane with -S -5 throw (simulating tmux failure)
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args.includes("-S")) {
        throw new Error("tmux not available");
      }
      return "";
    });

    // Should fall through to normal idle counting despite tmux failure
    vi.advanceTimersByTime(4000); // consecutive_idle = 2
    vi.advanceTimersByTime(4000); // consecutive_idle = 3 → finalize

    expect(bot.finalize_calls).toHaveLength(1);
  });
});

describe("start_typing_loop — stale OAuth still works during grace period", () => {
  it("detects stale OAuth even during the grace period", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ stale_oauth: true });

    // Override send to no-op (stale OAuth path sends a channel message)
    (bot as unknown as Record<string, unknown>).send = vi.fn().mockResolvedValue(undefined);

    bot.set_pool(pool);

    bot.start_typing_loop("test-channel");

    // First tick at 4s (within grace period) — should still detect stale OAuth
    vi.advanceTimersByTime(4000);

    expect(bot.finalize_calls).toHaveLength(1);
    expect(pool.kill_stale_session).toHaveBeenCalled();
    expect(bot.has_typing_loop("test-channel")).toBe(false);
  });
});
