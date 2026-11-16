import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingInboundStore } from "../pending-inbound.js";
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

type DeafPolicy = "recycle" | "redeliver_then_recycle" | "alert_only";

function make_config(deaf_policy?: DeafPolicy): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
    ...(deaf_policy ? { discord: { server_id: "guild-1", deaf_policy } } : {}),
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

  /** tmux_session → pane text (null = unreadable, the default). */
  panes = new Map<string, string | null>();
  /** Message ids present in the session transcript. */
  transcript = new Set<string>();
  /** Text typed into sessions via the redelivery path. */
  sent: Array<{ session: string; text: string }> = [];
  send_ok = true;

  protected override read_pane(tmux_session: string): string | null {
    return this.panes.get(tmux_session) ?? null;
  }

  protected override async read_transcript(): Promise<string | null> {
    return [...this.transcript].join("\n");
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

    // This suite pins the recycle mechanics themselves (alerts, release-to-fresh,
    // loop guard), so it runs under `deaf_policy: "recycle"` — recycle on the
    // first verdict. The default policy's redeliver-first gate has its own
    // suite below.
    pool = new TestBotPool(make_config("recycle"));
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

const LIVENESS_WARMUP = 90_000;
const IDLE_PROMPT = ["● Done.", "╭────╮", "│ ❯  │", "╰────╯", "  ⏵⏵ bypass permissions on"].join(
  "\n",
);
const PERMISSION_PROMPT = [
  "● Bash(rm -rf build)",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No, and tell Claude what to do differently (esc)",
].join("\n");
const LOGIN_REQUIRED = ["> hi", "  ⎿  Not logged in · Please run /login", "│ ❯  │"].join("\n");

function human_message(id: string, content = `content ${id}`) {
  return {
    user: "ada",
    channel_id: "chan-foods",
    message_id: id,
    content,
    ts: new Date().toISOString(),
  };
}

/**
 * The deaf verdict is one idle pane reading. Under the default policy it must
 * not end a session until the daemon has (a) ruled out a visible blocking
 * state and (b) re-sent what the session missed.
 */
describe("deaf_policy (redeliver before recycle)", () => {
  let pool: TestBotPool;
  let start_tmux: ReturnType<typeof vi.spyOn>;

  function setup(policy?: DeafPolicy): void {
    pool = new TestBotPool(make_config(policy));
    (pool as unknown as { registry: EntityRegistry }).registry = make_registry([
      make_entity_config("healthydogs", ["chan-foods"]),
    ]);
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
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "send_via_tmux" as never,
    ).mockImplementation((async (session: string, text: string) => {
      pool.sent.push({ session, text });
      return pool.send_ok;
    }) as never);
    start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);
  }

  /** An assigned, alive, idle bot that received `ids` and never processed. */
  function deaf_bot(ids: string[] = ["m1"]): PoolBot {
    const bot = make_bot({
      id: 3,
      state: "assigned",
      channel_id: "chan-foods",
      entity_id: "healthydogs",
      archetype: "planner",
      session_id: "sess-live",
      assigned_at: new Date(Date.now() - 60 * 60_000),
    });
    pool.inject_bots([bot]);
    pool.set_tmux_alive("pool-3", true);
    pool.set_bot_idle_state(3, true);
    pool.panes.set("pool-3", IDLE_PROMPT);
    for (const id of ids) pool.mark_inbound("chan-foods", human_message(id));
    make_deaf_eligible(bot);
    return bot;
  }

  function make_deaf_eligible(bot: PoolBot): void {
    bot.last_inbound_at = new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000);
  }

  function alerts(): string[] {
    return notify_mock.mock.calls.map((c) => String(c[1]));
  }

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pool-deaf-policy-"));
    notify_mock.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("is the default when no policy is configured", async () => {
    setup(); // no discord block at all
    const bot = deaf_bot();
    await pool.run_probe(bot);
    expect(start_tmux).not.toHaveBeenCalled();
    expect(pool.sent).toHaveLength(1);
  });

  it("first deaf verdict re-sends the missed messages, in order, and does NOT release", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot(["m1", "m2"]);

    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(bot.state).toBe("assigned");
    expect(bot.session_id).toBe("sess-live");
    expect(pool.sent).toHaveLength(1);
    const text = pool.sent[0]!.text;
    expect(text).toContain("message_id m1");
    expect(text).toContain("message_id m2");
    expect(text.indexOf("message_id m1")).toBeLessThan(text.indexOf("message_id m2"));
    // Re-armed against the redelivery itself.
    expect(bot.last_inbound_at!.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(alerts().some((m) => m.includes("Re-sent 2 message(s)"))).toBe(true);
    expect(alerts().some((m) => m.includes("went DEAF"))).toBe(false);
  });

  it("second consecutive deaf verdict after the redelivery recycles", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();

    await pool.run_probe(bot); // redeliver
    make_deaf_eligible(bot); // still silent a full window later
    await pool.run_probe(bot); // recycle

    expect(pool.sent).toHaveLength(1); // no second redelivery
    expect(start_tmux).toHaveBeenCalledTimes(1);
    expect(alerts().some((m) => m.includes("went DEAF"))).toBe(true);
  });

  it("a healthy reading between verdicts resets the redelivery — the next silence gets its own", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();

    await pool.run_probe(bot); // redeliver
    pool.set_bot_idle_state(3, false); // it picked the redelivery up
    await pool.run_probe(bot); // healthy_working → tracking cleared
    expect(bot.last_inbound_at).toBeNull();

    // A new message later goes unanswered.
    pool.set_bot_idle_state(3, true);
    bot.last_processing_at = new Date(Date.now() - 30 * 60_000);
    pool.mark_inbound("chan-foods", human_message("m9"));
    make_deaf_eligible(bot);
    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(pool.sent).toHaveLength(2);
    expect(pool.sent[1]!.text).toContain("message_id m9");
  });

  it("does not re-send — or recycle — when the transcript shows the plugin delivered", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot(["m1"]);
    pool.transcript.add("m1");

    await pool.run_probe(bot);

    expect(pool.sent).toHaveLength(0);
    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
    expect(bot.last_inbound_at).toBeNull(); // not deaf after all
  });

  it("re-sends only what the transcript is missing", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot(["m1", "m2"]);
    pool.transcript.add("m1");

    await pool.run_probe(bot);

    expect(pool.sent[0]!.text).not.toContain("message_id m1");
    expect(pool.sent[0]!.text).toContain("message_id m2");
  });

  it("sends a generic catch-up prompt when the probe was armed without a message", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot([]);
    pool.mark_inbound("chan-foods"); // daemon-injected nudge: no message recorded
    make_deaf_eligible(bot);

    await pool.run_probe(bot);

    expect(start_tmux).not.toHaveBeenCalled();
    expect(pool.sent).toHaveLength(1);
    expect(pool.sent[0]!.text).toContain("chat_id=chan-foods");
  });

  it("a redelivery that could not be typed does not count — it is retried, and only then recycled", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();
    pool.panes.set("pool-3", null); // pane unreadable → cannot inject

    await pool.run_probe(bot); // attempt 1: nothing typed
    expect(pool.sent).toHaveLength(0);
    expect(alerts().some((m) => m.includes("could not re-send"))).toBe(true);

    make_deaf_eligible(bot);
    await pool.run_probe(bot); // attempt 2: still not recycled
    expect(start_tmux).not.toHaveBeenCalled();
    expect(bot.state).toBe("assigned");

    make_deaf_eligible(bot);
    await pool.run_probe(bot); // untypeable for two windows → recycle
    expect(start_tmux).toHaveBeenCalledTimes(1);
  });

  it("a retry that does get typed is the redelivery; the session is not recycled for the earlier miss", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();
    pool.panes.set("pool-3", null);
    await pool.run_probe(bot);

    pool.panes.set("pool-3", IDLE_PROMPT);
    make_deaf_eligible(bot);
    await pool.run_probe(bot);

    expect(pool.sent).toHaveLength(1);
    expect(start_tmux).not.toHaveBeenCalled();
  });

  it("login_required on an UNCONFIRMED session does not stash a phantom resume id (#256)", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();
    bot.session_confirmed = false;
    pool.panes.set("pool-3", LOGIN_REQUIRED);

    await pool.run_probe(bot);

    expect(bot.state).toBe("free");
    const history = (pool as unknown as { session_history: Map<string, string> }).session_history;
    expect(history.has("healthydogs:chan-foods")).toBe(false);
  });

  it("never recycles while a permission prompt is on screen, and alerts once", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();
    pool.panes.set("pool-3", PERMISSION_PROMPT);

    for (let i = 0; i < 4; i++) {
      await pool.run_probe(bot);
      make_deaf_eligible(bot);
    }

    expect(start_tmux).not.toHaveBeenCalled();
    expect(pool.sent).toHaveLength(0); // never type into a dialog
    expect(bot.state).toBe("assigned");
    const blocked = alerts().filter((m) => m.includes("waiting on a permission prompt"));
    expect(blocked).toHaveLength(1);
  });

  it("resumes normal handling once the blocking state clears", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();
    pool.panes.set("pool-3", PERMISSION_PROMPT);
    await pool.run_probe(bot);

    pool.panes.set("pool-3", IDLE_PROMPT);
    make_deaf_eligible(bot);
    await pool.run_probe(bot);

    expect(pool.sent).toHaveLength(1); // redelivered, not recycled
    expect(start_tmux).not.toHaveBeenCalled();
  });

  it("login_required: releases with history instead of deaf-recycling", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot();
    pool.panes.set("pool-3", LOGIN_REQUIRED);

    await pool.run_probe(bot);

    expect(bot.state).toBe("free");
    // No store is wired in this suite, so nothing drives a reassign: the
    // channel resumes on the next human message. (With a store, the parked
    // messages drive one restart — see the next test.)
    expect(start_tmux).not.toHaveBeenCalled();
    expect(alerts().some((m) => m.includes("not logged in"))).toBe(true);
    expect(alerts().some((m) => m.includes("went DEAF"))).toBe(false);
    const history = (pool as unknown as { session_history: Map<string, string> }).session_history;
    expect(history.get("healthydogs:chan-foods")).toBe("sess-live");
  });

  it("login_required with the queue wired: one restart carrying the missed message, then a manual-/login alert — never a loop", async () => {
    setup("redeliver_then_recycle");
    const store = new PendingInboundStore({
      path: join(temp_dir, "state", "pending-inbound.json"),
    });
    pool.set_pending_inbound(store);
    pool.set_channel_resolver(() => ({
      entity_id: "healthydogs",
      archetype: "planner",
      channel_type: "general",
      channel_name: "foods",
    }));
    const bot = deaf_bot(["m1"]);
    pool.panes.set("pool-3", LOGIN_REQUIRED);

    await pool.run_probe(bot);
    expect(store.peek_channel("chan-foods").map((e) => e.message_id)).toEqual(["m1"]);
    await pool.drain_pending_inbound(); // restart, driven by the parked message
    expect(start_tmux).toHaveBeenCalledTimes(1);
    expect(store.depth("chan-foods")).toBe(0);

    // The replacement is not logged in either. Probe it repeatedly.
    for (let i = 0; i < 5; i++) {
      const current = pool.get_assignment("chan-foods")!;
      expect(current).toBeDefined();
      current.assigned_at = new Date(Date.now() - 60 * 60_000);
      pool.panes.set(current.tmux_session, LOGIN_REQUIRED);
      pool.mark_inbound("chan-foods", human_message(`again-${String(i)}`));
      make_deaf_eligible(current);
      await pool.run_probe(current);
      await pool.drain_pending_inbound();
    }

    expect(start_tmux).toHaveBeenCalledTimes(1); // no second restart
    expect(pool.get_assignment("chan-foods")).toBeDefined(); // session left alone
    expect(alerts().filter((m) => m.includes("manual `/login`"))).toHaveLength(1);
    await store.flush();
  });

  it("a session whose listener is dead is recycled once redelivery has had to bridge it twice", async () => {
    setup("redeliver_then_recycle");
    const store = new PendingInboundStore({
      path: join(temp_dir, "state", "pending-inbound.json"),
    });
    pool.set_pending_inbound(store);
    const bot = deaf_bot([]);
    bot.last_inbound_at = null;

    // It answers whatever is typed into it, so every redelivery is followed by
    // a healthy verdict — and then it goes silent on the next Discord message.
    async function silence_then_redelivery(id: string): Promise<void> {
      pool.set_bot_idle_state(3, true);
      pool.mark_inbound("chan-foods", human_message(id));
      make_deaf_eligible(bot);
      await pool.run_probe(bot); // deaf → redeliver
      pool.transcript.add(id); // the typed text is now in its transcript
      pool.set_bot_idle_state(3, false);
      await pool.run_probe(bot); // healthy_working (it took the typed text)
      // ...and that turn finished some time before the next Discord message.
      bot.last_processing_at = new Date(Date.now() - 10 * 60_000);
    }
    await silence_then_redelivery("m1");
    await silence_then_redelivery("m2");
    expect(pool.sent).toHaveLength(2);
    expect(start_tmux).not.toHaveBeenCalled();

    // Third silence: no more bridging.
    pool.set_bot_idle_state(3, true);
    await new Promise((r) => setTimeout(r, 5));
    pool.mark_inbound("chan-foods", human_message("m3"));
    make_deaf_eligible(bot);
    await pool.run_probe(bot);

    expect(pool.sent).toHaveLength(2);
    expect(start_tmux).toHaveBeenCalledTimes(1);
    expect(alerts().some((m) => m.includes("went DEAF"))).toBe(true);
    // The unanswered message is waiting for the replacement session.
    expect(store.peek_channel("chan-foods").map((e) => e.message_id)).toEqual(["m3"]);
    await store.flush();
  });

  it("still re-sends the actual message after a crash restart refreshed assigned_at", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot(["before-crash"]);
    bot.assigned_at = new Date(Date.now() - LIVENESS_WARMUP - 1_000); // restarted after the message
    await new Promise((r) => setTimeout(r, 2));

    await pool.run_probe(bot);

    expect(pool.sent).toHaveLength(1);
    expect(pool.sent[0]!.text).toContain("message_id before-crash");
  });

  it("alert_only: alerts once and never recycles or types anything", async () => {
    setup("alert_only");
    const bot = deaf_bot();

    await pool.run_probe(bot);
    await pool.run_probe(bot); // marker consumed → nothing more

    expect(start_tmux).not.toHaveBeenCalled();
    expect(pool.sent).toHaveLength(0);
    expect(bot.state).toBe("assigned");
    expect(alerts().filter((m) => m.includes("alert_only"))).toHaveLength(1);
  });

  it("alert_only still names a blocking state rather than calling it deaf", async () => {
    setup("alert_only");
    const bot = deaf_bot();
    pool.panes.set("pool-3", PERMISSION_PROMPT);

    await pool.run_probe(bot);

    expect(alerts().some((m) => m.includes("permission prompt"))).toBe(true);
    expect(alerts().some((m) => m.includes("DEAF"))).toBe(false);
  });

  it("recycle: first verdict recycles even with a blocking pane (legacy behaviour)", async () => {
    setup("recycle");
    const bot = deaf_bot();
    pool.panes.set("pool-3", PERMISSION_PROMPT);

    await pool.run_probe(bot);

    expect(pool.sent).toHaveLength(0);
    expect(start_tmux).toHaveBeenCalledTimes(1);
  });

  it("remembers at most 10 inbound per bot and forgets what was processed", async () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot([]);
    for (let i = 0; i < 14; i++) pool.mark_inbound("chan-foods", human_message(`old-${String(i)}`));
    const recent = (
      pool as unknown as { recent_inbound: Map<number, Array<{ message_id: string }>> }
    ).recent_inbound.get(3)!;
    expect(recent).toHaveLength(10);
    expect(recent[0]!.message_id).toBe("old-4");

    // The session then processes a turn; a later message is the only one missed.
    await new Promise((r) => setTimeout(r, 5));
    pool.mark_processed("sess-live");
    await new Promise((r) => setTimeout(r, 5));
    pool.mark_inbound("chan-foods", human_message("fresh"));
    // Call the redelivery directly to see exactly what it would send.
    const outcome = await (
      pool as unknown as {
        redeliver_missed_inbound: (b: PoolBot, pane: string | null) => Promise<unknown>;
      }
    ).redeliver_missed_inbound(bot, IDLE_PROMPT);
    expect(outcome).toEqual({ sent: true, count: 1 });
    expect(pool.sent[0]!.text).toContain("message_id fresh");
    expect(pool.sent[0]!.text).not.toContain("old-");
  });

  it("arm_inbound_probe arms for a first-turn message — except under `recycle`", () => {
    setup("redeliver_then_recycle");
    const bot = deaf_bot([]);
    bot.last_inbound_at = null;
    pool.arm_inbound_probe("chan-foods", human_message("first"));
    expect(bot.last_inbound_at).not.toBeNull();

    setup("recycle");
    const legacy = deaf_bot([]);
    legacy.last_inbound_at = null;
    pool.arm_inbound_probe("chan-foods", human_message("first"));
    expect(legacy.last_inbound_at).toBeNull();
  });
});
