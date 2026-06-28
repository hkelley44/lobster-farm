import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_DEAF_THRESHOLD_MS } from "../pool.js";
import type { PoolBot } from "../pool.js";
import type { EntityRegistry } from "../registry.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// notify() makes a Discord webhook call — mock it so the probe's #alerts path
// can be asserted on without touching the network.
const { notify_mock } = vi.hoisted(() => ({ notify_mock: vi.fn(async () => {}) }));
vi.mock("../actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../actions.js")>();
  return { ...actual, notify: notify_mock };
});

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_entity_config(entity_id: string, channel_ids: string[]): EntityConfig {
  return {
    entity: {
      id: entity_id,
      name: `Test ${entity_id}`,
      description: "",
      status: "active",
      repos: [],
      accounts: {},
      channels: {
        category_id: "",
        list: channel_ids.map((id) => ({ type: "general" as const, id })),
      },
      memory: { path: "/tmp/memory", auto_extract: true },
      secrets: { vault: "1password", vault_name: `entity-${entity_id}` },
    },
  };
}

function make_registry(entities: EntityConfig[]): EntityRegistry {
  const map = new Map<string, EntityConfig>();
  for (const e of entities) map.set(e.entity.id, e);
  return {
    get: (id: string) => map.get(id),
    get_all: () => [...map.values()],
    get_active: () => [...map.values()].filter((e) => e.entity.status === "active"),
    count: () => map.size,
  } as unknown as EntityRegistry;
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
    last_inbound_at: null,
    last_processing_at: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

/**
 * Test pool with per-bot tmux liveness + pane-idle control, so we can simulate
 * a live-but-deaf bot (alive tmux, perpetually idle pane) without real tmux.
 */
class TestBotPool extends BotPoolTestBase {
  private alive = new Map<string, boolean>();
  private idle = new Map<number, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  set_tmux_alive(session: string, alive: boolean): void {
    this.alive.set(session, alive);
  }

  set_bot_idle_state(bot_id: number, idle: boolean): void {
    this.idle.set(bot_id, idle);
  }

  protected override is_tmux_alive(session_name: string): boolean {
    return this.alive.get(session_name) ?? false;
  }

  // is_bot_idle defaults to "idle" (the dangerous case the probe must catch).
  override is_bot_idle(bot: PoolBot): boolean {
    return this.idle.get(bot.id) ?? true;
  }

  // Expose the protected probe for direct invocation.
  async run_probe(bot: PoolBot): Promise<void> {
    await (
      this as unknown as { check_plugin_liveness: (b: PoolBot) => Promise<void> }
    ).check_plugin_liveness(bot);
  }
}

describe("check_plugin_liveness (issue #73)", () => {
  let pool: TestBotPool;

  function make_assigned_bot(id: number, overrides: Partial<PoolBot> = {}): PoolBot {
    return make_bot({
      id,
      state: "assigned",
      channel_id: "chan-foods",
      entity_id: "healthydogs",
      archetype: "planner",
      session_id: "sess-live",
      ...overrides,
    });
  }

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pool-plugin-liveness-"));
    notify_mock.mockClear();

    pool = new TestBotPool(make_config());
    (pool as unknown as { registry: EntityRegistry }).registry = make_registry([
      make_entity_config("healthydogs", ["chan-foods"]),
    ]);

    // Stub spawn-path side effects so no real tmux/Discord work happens.
    for (const method of [
      "kill_tmux",
      "write_access_json",
      "set_bot_nickname",
      "set_bot_avatar",
      "persist",
      "resolve_github_token_ref",
    ] as const) {
      vi.spyOn(pool as unknown as Record<string, unknown>, method as never).mockImplementation(
        (() => undefined) as never,
      );
    }
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "check_session_jsonl_exists_anywhere" as never,
    ).mockResolvedValue(true as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("does nothing when no inbound message was delivered", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    const bot = make_assigned_bot(3, { last_inbound_at: null });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("does nothing during the grace window after an inbound", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Inbound just arrived — well under the deaf threshold.
    const bot = make_assigned_bot(3, { last_inbound_at: new Date(Date.now() - 5_000) });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true); // still idle, but within grace — not deaf yet

    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
    // Inbound marker preserved so a later pass can still catch deafness.
    expect(bot.last_inbound_at).not.toBeNull();
  });

  it("clears the inbound marker when the bot is actively working (plugin delivered)", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Inbound is old enough to be deaf-eligible, but the bot is non-idle =>
    // the plugin delivered and the bot picked it up. Healthy.
    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 10_000),
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, false); // working

    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
    expect(bot.last_inbound_at).toBeNull();
    expect(bot.last_processing_at).not.toBeNull();
  });

  it("treats a bot that processed AFTER the inbound (then idled) as healthy", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    const inbound = new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 10_000);
    const bot = make_assigned_bot(3, {
      last_inbound_at: inbound,
      // Processed 1s after the inbound, then returned to idle (awaiting reply).
      last_processing_at: new Date(inbound.getTime() + 1_000),
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true); // idle now — but it DID process

    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
    expect(bot.last_inbound_at).toBeNull();
  });

  it("detects deafness and recovers: alerts #alerts and respawns the session", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Inbound is past the threshold, bot has been idle the whole time, and it
    // never processed since the inbound => DEAF.
    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    // Recovered via the restart path (resumes the confirmed session).
    expect(start_tmux).toHaveBeenCalledTimes(1);
    // Bot stays assigned on the same channel after a successful restart.
    expect(bot.state).toBe("assigned");
    expect(bot.channel_id).toBe("chan-foods");
    // The inbound marker is consumed so we don't re-trigger on the same silence.
    expect(bot.last_inbound_at).toBeNull();

    // A "went DEAF" alert fired; the un-recoverable alert did NOT.
    const deaf_alert = notify_mock.mock.calls.some(
      (call) => typeof call[1] === "string" && call[1].includes("went DEAF"),
    );
    const dark_alert = notify_mock.mock.calls.some(
      (call) => typeof call[1] === "string" && call[1].includes("could not be restarted"),
    );
    expect(deaf_alert).toBe(true);
    expect(dark_alert).toBe(false);
  });

  it("alerts that the channel is dark when recovery fails to respawn", async () => {
    // Make the respawn fail — restart_crashed_session frees the bot, then the
    // probe surfaces the dark channel.
    vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never).mockRejectedValue(
      new Error("tmux spawn failed") as never,
    );

    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    // Bot freed by the restart-failure path...
    expect(bot.state).toBe("free");
    // ...and both the initial deaf alert and the un-recoverable alert fired.
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => m.includes("went DEAF"))).toBe(true);
    expect(messages.some((m) => m.includes("could not be restarted"))).toBe(true);
  });

  it("skips a bot already mid-recovery (in-flight lock)", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    // Mark the bot as already being recovered.
    (pool as unknown as { recovering_plugin: Set<number> }).recovering_plugin.add(3);

    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("mark_inbound stamps last_inbound_at on the channel's assigned bot only", () => {
    const assigned = make_assigned_bot(3, { last_inbound_at: null });
    const other = make_bot({
      id: 4,
      state: "assigned",
      channel_id: "chan-other",
      entity_id: "healthydogs",
      archetype: "planner",
    });
    pool.inject_bots([assigned, other]);

    pool.mark_inbound("chan-foods");

    expect(assigned.last_inbound_at).not.toBeNull();
    expect(other.last_inbound_at).toBeNull();
  });
});
