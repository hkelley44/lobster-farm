import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../alert-router.js";
import { handle_dead_letter } from "../broker/dead-letter.js";
import { DiscordBroker } from "../broker/index.js";
import type { QueueEntry } from "../broker/queue.js";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// Mock actions.ts — notify is imported by pool.ts (crash alerts + #91 dark note).
vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistence to avoid filesystem side effects.
vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({ bots: [], session_history: {}, avatar_state: {} }),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

const BROKER_CHANNEL = "ch-broker-pilot";
const COOLDOWN_MS = BotPool.DEAD_LETTER_HEAL_COOLDOWN_MS;

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
    discord: {
      server_id: "guild-1",
      broker: { enabled: true, pilot_channels: [BROKER_CHANNEL] },
    },
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

class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }
  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }
}

function make_pool_with_broker(): { pool: TestBotPool; broker: DiscordBroker } {
  const config = make_config();
  const pool = new TestBotPool(config);
  const broker = new DiscordBroker({
    config,
    socket_path: join(temp_dir, "b.sock"),
    queue_path: join(temp_dir, "q.json"),
  });
  pool.set_broker(broker);

  vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
    () => {},
  );
  vi.spyOn(
    pool as unknown as Record<string, unknown>,
    "write_access_json" as never,
  ).mockResolvedValue(undefined);
  return { pool, broker };
}

function assigned_broker_bot(id: number, session = `sess-${String(id)}`): PoolBot {
  return make_bot({
    id,
    state: "assigned",
    channel_id: BROKER_CHANNEL,
    entity_id: "test-entity",
    archetype: "planner",
    session_id: session,
    session_confirmed: true,
  });
}

function make_entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "q-1",
    channel_id: BROKER_CHANNEL,
    bot_id: 3,
    content: "please deploy the thing",
    meta: { chat_id: BROKER_CHANNEL, message_id: "m-1", user: "hunter", user_id: "", ts: "t" },
    enqueued_at: "2026-08-09T10:00:00.000Z",
    deliveries: 5,
    status: "dead",
    last_delivery_ms: 0,
    ...overrides,
  };
}

describe("dead-letter session heal (#107)", () => {
  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "dead-letter-heal-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  // ── pool.heal_dead_letter ──

  it("releases the owning bot to dark: history stashed (#92 gate), ownership dropped, queue preserved", async () => {
    const { pool, broker } = make_pool_with_broker();
    pool.inject_bots([assigned_broker_bot(3, "sess-deaf-1")]);

    // Broker state as it stands when a dead-letter fires: ownership registered,
    // and a FOLLOW-UP inbound still pending in the durable queue.
    broker.register_channel(BROKER_CHANNEL, {
      bot_id: 3,
      state_dir: "/tmp/test-pool-3",
      chunk_config: {},
    });
    const survivor = (
      broker as unknown as {
        queue: {
          enqueue: (i: unknown) => unknown;
          depth: (c: string) => number;
          flush: () => Promise<void>;
        };
      }
    ).queue;
    survivor.enqueue({
      channel_id: BROKER_CHANNEL,
      bot_id: 3,
      content: "follow-up that must survive the heal",
      meta: { chat_id: BROKER_CHANNEL, message_id: "m-2", user: "hunter", user_id: "", ts: "t" },
    });

    const result = await pool.heal_dead_letter(BROKER_CHANNEL);

    expect(result).toEqual({ outcome: "healed", bot_id: 3, session_id: "sess-deaf-1" });
    // Bot released to dark.
    expect(pool.get_bots()[0]!.state).toBe("free");
    expect(pool.get_bots()[0]!.channel_id).toBeNull();
    // Continuity: session stashed through the shared confirmed-AND-JSONL gate.
    expect(pool.get_session_history().get(`test-entity:${BROKER_CHANNEL}`)).toBe("sess-deaf-1");
    // Channel is dark (ownership dropped) …
    expect(broker.owns(BROKER_CHANNEL)).toBe(false);
    // … but the durable queue was PRESERVED (deregister_channel, not
    // release_channel) — the follow-up redelivers to the cold-recreated session.
    expect(survivor.depth(BROKER_CHANNEL)).toBe(1);

    // Drain the queue's coalesced persist before afterEach removes temp_dir.
    await survivor.flush();
  });

  it("cool-down: a repeat dead-letter within the window is refused with no state change", async () => {
    const { pool } = make_pool_with_broker();
    pool.inject_bots([assigned_broker_bot(3)]);

    const t0 = 10_000_000;
    const first = await pool.heal_dead_letter(BROKER_CHANNEL, t0);
    expect(first.outcome).toBe("healed");

    // The channel dead-letters again 1 min later — a fresh session (or none)
    // is failing too. No second heal.
    pool.inject_bots([assigned_broker_bot(4)]);
    const repeat = await pool.heal_dead_letter(BROKER_CHANNEL, t0 + 60_000);
    expect(repeat).toEqual({ outcome: "cooldown", last_heal_ms: t0 });
    // The newly-injected bot was NOT touched — no automatic action on cooldown.
    expect(pool.get_bots()[0]!.state).toBe("assigned");
  });

  it("heals again once the cool-down has elapsed", async () => {
    const { pool } = make_pool_with_broker();
    pool.inject_bots([assigned_broker_bot(3)]);

    const t0 = 10_000_000;
    expect((await pool.heal_dead_letter(BROKER_CHANNEL, t0)).outcome).toBe("healed");

    pool.inject_bots([assigned_broker_bot(4)]);
    const later = await pool.heal_dead_letter(BROKER_CHANNEL, t0 + COOLDOWN_MS + 1);
    expect(later.outcome).toBe("healed");
  });

  it("no assigned session (channel already dark) → no_session, nothing mutated", async () => {
    const { pool } = make_pool_with_broker();
    pool.inject_bots([make_bot({ id: 3 })]); // free bot

    const result = await pool.heal_dead_letter(BROKER_CHANNEL);
    expect(result).toEqual({ outcome: "no_session" });
    expect(pool.get_bots()[0]!.state).toBe("free");
  });

  it("never heals a non-broker channel (belt-and-suspenders against stale entries)", async () => {
    const { pool } = make_pool_with_broker();
    const plugin_bot = make_bot({
      id: 3,
      state: "assigned",
      channel_id: "ch-plugin",
      entity_id: "test-entity",
      archetype: "planner",
      session_id: "sess-plugin",
    });
    pool.inject_bots([plugin_bot]);

    const result = await pool.heal_dead_letter("ch-plugin");
    expect(result).toEqual({ outcome: "no_session" });
    expect(pool.get_bots()[0]!.state).toBe("assigned"); // untouched
  });

  // ── handle_dead_letter (alert + heal composition) ──

  it("healed: one action_required alert naming the healed session, the drop, and NO re-enqueue", async () => {
    const alerts: AlertPayload[] = [];
    const heal = vi
      .fn()
      .mockResolvedValue({ outcome: "healed", bot_id: 3, session_id: "deafbeef-1234-5678" });

    await handle_dead_letter(make_entry(), {
      heal,
      post_alert: async (p) => {
        alerts.push(p);
      },
    });

    expect(heal).toHaveBeenCalledWith(BROKER_CHANNEL);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.tier).toBe("action_required");
    // The dropped message is quoted (the entry is its only copy) …
    expect(alert.body).toContain("please deploy the thing");
    // … the heal is named …
    expect(alert.body).toContain("pool-3");
    expect(alert.body).toContain("deafbeef"); // first 8 chars of the session id
    expect(alert.body).toContain("next message in the channel recreates it");
    // … and the no-re-enqueue decision is explicit (poison-loop breaker).
    expect(alert.body).toContain("NOT re-enqueued");
  });

  it("cooldown: escalates at failure severity (incident_open) and says no action was taken", async () => {
    const alerts: AlertPayload[] = [];
    await handle_dead_letter(make_entry(), {
      heal: vi.fn().mockResolvedValue({ outcome: "cooldown", last_heal_ms: 1_754_700_000_000 }),
      post_alert: async (p) => {
        alerts.push(p);
      },
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.tier).toBe("incident_open");
    expect(alerts[0]!.body).toContain("no automatic action");
    expect(alerts[0]!.body).toContain("please deploy the thing");
  });

  it("no_session: plain dead-letter alert, notes the channel was already dark", async () => {
    const alerts: AlertPayload[] = [];
    await handle_dead_letter(make_entry(), {
      heal: vi.fn().mockResolvedValue({ outcome: "no_session" }),
      post_alert: async (p) => {
        alerts.push(p);
      },
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.tier).toBe("action_required");
    expect(alerts[0]!.body).toContain("already dark");
  });

  it("end-to-end with a real pool: heal ordering preserves the alert's quoted content", async () => {
    const { pool } = make_pool_with_broker();
    pool.inject_bots([assigned_broker_bot(3, "sess-e2e")]);

    const alerts: AlertPayload[] = [];
    await handle_dead_letter(make_entry({ content: "the only copy of this message" }), {
      heal: (channel_id) => pool.heal_dead_letter(channel_id),
      post_alert: async (p) => {
        alerts.push(p);
      },
    });

    // The heal actually ran (bot dark) AND the alert still carries the content
    // that only existed on the entry.
    expect(pool.get_bots()[0]!.state).toBe("free");
    expect(alerts[0]!.body).toContain("the only copy of this message");
    expect(alerts[0]!.title).toContain("auto-healed");
  });
});
