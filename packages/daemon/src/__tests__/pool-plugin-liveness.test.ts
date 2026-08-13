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

  it("detects deafness and recycles release-to-fresh: alert, release, fresh assign resuming the session (#106)", async () => {
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

    // Recycled: the same release + assign an operator does by hand. One spawn.
    expect(start_tmux).toHaveBeenCalledTimes(1);
    const spawn_args = start_tmux.mock.calls[0] as unknown[];
    // The stash → assign flow resumes the confirmed session for continuity...
    expect(spawn_args[4]).toBe("sess-live");
    expect(spawn_args[5]).toBe(true);
    // ...and injects a recovery message so the fresh session runs a first turn
    // and catches up on whatever the deaf plugin dropped.
    expect((spawn_args[6] as Record<string, string>).LF_PENDING_FILE).toBeDefined();

    // The channel ends up with an assigned bot again.
    const assigned = pool
      .get_bots()
      .find((b) => b.channel_id === "chan-foods" && b.state === "assigned");
    expect(assigned).toBeDefined();
    // The recovery injection arms the probe on the fresh bot: if the new
    // session never processes it either, deafness is re-detected and the loop
    // guard eventually stops the churn.
    expect(assigned!.last_inbound_at).not.toBeNull();
    expect(assigned!.last_processing_at).toBeNull();

    // A "went DEAF" alert fired; the un-recoverable alert did NOT.
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => m.includes("went DEAF"))).toBe(true);
    expect(messages.some((m) => m.includes("could not be reassigned"))).toBe(false);
  });

  it("alerts that the channel is dark when the recycle's reassign fails", async () => {
    // Make the fresh spawn fail — assign() throws, the recycle reports "dark",
    // and the probe surfaces the unattended channel.
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

    // Bot was released and the reassign never landed...
    expect(bot.state).toBe("free");
    // ...and both the initial deaf alert and the un-recoverable alert fired.
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => m.includes("went DEAF"))).toBe(true);
    expect(messages.some((m) => m.includes("could not be reassigned"))).toBe(true);
  });

  it("loop guard: repeated deafness within the window releases WITHOUT reassign and alerts at failure severity", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Two auto-recycles already happened on this channel inside the window —
    // a third deaf verdict means recycling is not curing the root cause.
    (pool as unknown as { deaf_recycle_history: Map<string, number[]> }).deaf_recycle_history.set(
      "chan-foods",
      [Date.now() - 10 * 60 * 1000, Date.now() - 5 * 60 * 1000],
    );

    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    // No reassign — released and left dark for a human.
    expect(start_tmux).not.toHaveBeenCalled();
    expect(bot.state).toBe("free");
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => m.includes("keeps going DEAF"))).toBe(true);
  });

  it("loop guard: recycle timestamps outside the window are forgotten", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Old recycles (>1h) don't count against the budget.
    (pool as unknown as { deaf_recycle_history: Map<string, number[]> }).deaf_recycle_history.set(
      "chan-foods",
      [Date.now() - 2 * 60 * 60 * 1000, Date.now() - 3 * 60 * 60 * 1000],
    );

    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    // Normal recycle proceeds.
    expect(start_tmux).toHaveBeenCalledTimes(1);
    const assigned = pool
      .get_bots()
      .find((b) => b.channel_id === "chan-foods" && b.state === "assigned");
    expect(assigned).toBeDefined();
  });

  it("mark_processed stamps last_processing_at for the matching assigned session only (#106)", () => {
    const bot = make_assigned_bot(3, { session_id: "sess-live", last_processing_at: null });
    const other = make_bot({
      id: 4,
      state: "assigned",
      channel_id: "chan-other",
      entity_id: "healthydogs",
      archetype: "planner",
      session_id: "sess-other",
      last_processing_at: null,
    });
    pool.inject_bots([bot, other]);

    pool.mark_processed("sess-live");

    expect(bot.last_processing_at).not.toBeNull();
    expect(other.last_processing_at).toBeNull();

    // Unknown session id is a no-op.
    pool.mark_processed("sess-unknown");
    expect(other.last_processing_at).toBeNull();
  });

  it("skips the DEAF-restart path for a broker-transport session (broker redelivery is the liveness mechanism)", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Same DEAF-eligible conditions as the plugin case below: inbound past the
    // threshold, idle the whole time, never processed. The ONLY difference is
    // that the broker owns this channel — the daemon's durable queue holds and
    // redelivers the message, so the observational probe must NOT restart it
    // (a restart mid-reconnect would fight the broker's redelivery).
    (pool as unknown as { broker: { owns(id: string): boolean } | null }).broker = {
      owns: (id: string) => id === "chan-foods",
    };

    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    // No restart, no alert — the broker session is exempt.
    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
    // The inbound marker is untouched: the broker owns delivery liveness, so the
    // probe leaves the session's markers entirely alone.
    expect(bot.last_inbound_at).not.toBeNull();
    expect(bot.state).toBe("assigned");
  });

  it("still restarts a plugin-transport session under the same DEAF conditions (broker exemption is targeted)", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // A broker exists but does NOT own this channel → plugin transport → the
    // probe behaves exactly as before. This pins that the exemption is scoped to
    // broker-owned channels only, not "any broker present". release_channel is
    // the no-op the recycle's release() path calls on non-broker channels.
    (
      pool as unknown as {
        broker: { owns(id: string): boolean; release_channel(id: string): void } | null;
      }
    ).broker = {
      owns: () => false,
      release_channel: () => {},
    };

    const bot = make_assigned_bot(3, {
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    // The plugin session IS deaf and IS recycled — the exemption didn't apply.
    expect(start_tmux).toHaveBeenCalledTimes(1);
    const assigned = pool
      .get_bots()
      .find((b) => b.channel_id === "chan-foods" && b.state === "assigned");
    expect(assigned).toBeDefined();
    const deaf_alert = notify_mock.mock.calls.some(
      (call) => typeof call[1] === "string" && call[1].includes("went DEAF"),
    );
    expect(deaf_alert).toBe(true);
  });

  it("warm-up gate: takes NO reading on a freshly-spawned bot, even when boot noise reads as working (#106 review)", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Spawn-armed marker (resume nudge / recycle recovery message) at T≈0 with
    // a pane that would read as "working" (startup banner mis-read). Without
    // the gate this produced healthy_working: last_processing_at falsely
    // stamped, marker cleared, BOTH deaf detectors silenced forever.
    const bot = make_assigned_bot(3, {
      assigned_at: new Date(), // just spawned — inside the warm-up window
      last_inbound_at: new Date(),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, false); // "working" per the pane heuristic

    await pool.run_probe(bot);

    // No reading taken: marker preserved, no processing stamp, no recovery.
    expect(bot.last_inbound_at).not.toBeNull();
    expect(bot.last_processing_at).toBeNull();
    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("warm-up gate: readings resume once the session has settled past the window", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Same conditions, but the session is old — the gate no longer applies and
    // a genuinely-working pane clears the marker as before.
    const bot = make_assigned_bot(3, {
      assigned_at: new Date(Date.now() - 10 * 60 * 1000),
      last_inbound_at: new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000),
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, false); // working

    await pool.run_probe(bot);

    expect(bot.last_inbound_at).toBeNull();
    expect(bot.last_processing_at).not.toBeNull();
    expect(start_tmux).not.toHaveBeenCalled();
  });

  it("warm-up gate: a spawn-armed session still idle after the window IS judged deaf and recycled", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    // Armed at spawn, warm-up elapsed, still idle with zero processing — the
    // gate delays the verdict but must not swallow it.
    const spawn_time = new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000);
    const bot = make_assigned_bot(3, {
      assigned_at: spawn_time,
      last_inbound_at: spawn_time,
      last_processing_at: null,
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);

    await pool.run_probe(bot);

    expect(start_tmux).toHaveBeenCalledTimes(1);
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => m.includes("went DEAF"))).toBe(true);
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
