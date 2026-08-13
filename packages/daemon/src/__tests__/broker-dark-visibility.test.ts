/**
 * #91 — operator visibility when a broker channel intentionally goes dark.
 *
 * Dark-and-waiting is DESIGNED behavior under the lazy/message-driven broker
 * (#89), not a failure. The signal contract:
 *   - exactly ONE info-level signal per channel per dark transition
 *     (structured "[broker-dark]" log + low-severity work_log note),
 *   - never per health tick (no spam),
 *   - never an `alerts`-severity notification,
 *   - plugin revive-failure alerting untouched.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedPoolBot } from "../persistence.js";
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({ bots: [], session_history: {}, avatar_state: {} }),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import { notify } from "../actions.js";

const BROKER_CHANNEL = "ch-broker-pilot";
const BROKER_CHANNEL_2 = "ch-broker-pilot-2";

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
    discord: {
      server_id: "guild-1",
      broker: { enabled: true, pilot_channels: [BROKER_CHANNEL, BROKER_CHANNEL_2] },
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
  dark_signals: Array<{ channel_id: string | null; reason: string }> = [];

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  set_resume_candidates(candidates: PersistedPoolBot[]): void {
    (this as unknown as { resume_candidates: PersistedPoolBot[] }).resume_candidates = candidates;
  }
  async run_resume(): Promise<void> {
    await this.resume_parked_bots();
  }
  async run_reconcile(): Promise<void> {
    await this.reconcile_assigned_health();
  }
  async run_health_check(): Promise<void> {
    await this.check_assigned_health();
  }
  protected override is_bot_idle(): boolean {
    return true;
  }
  protected override emit_broker_dark_signal(
    bot: PoolBot,
    channel_id: string | null,
    entity_id: string | null,
    reason: string,
  ): void {
    this.dark_signals.push({ channel_id, reason });
    super.emit_broker_dark_signal(bot, channel_id, entity_id, reason);
  }
}

function make_pool(): TestBotPool {
  const pool = new TestBotPool(make_config());
  // uses_broker requires a broker to be set; a stand-in is enough (the tests
  // here never exercise queue/ownership).
  pool.set_broker({ deregister_channel: () => {}, release_channel: () => {} } as never);
  vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
    () => {},
  );
  vi.spyOn(
    pool as unknown as Record<string, unknown>,
    "write_access_json" as never,
  ).mockResolvedValue(undefined);
  vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
    false,
  );
  vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never).mockResolvedValue(
    undefined,
  );
  vi.spyOn(
    pool as unknown as Record<string, unknown>,
    "set_bot_nickname" as never,
  ).mockResolvedValue(undefined);
  vi.spyOn(pool as unknown as Record<string, unknown>, "set_bot_avatar" as never).mockResolvedValue(
    undefined,
  );
  return pool;
}

function assigned_broker_bot(id: number, channel = BROKER_CHANNEL): PoolBot {
  return make_bot({
    id,
    state: "assigned",
    channel_id: channel,
    entity_id: "test-entity",
    archetype: "planner",
    session_id: `sess-${String(id)}`,
    session_confirmed: true,
  });
}

function work_log_notes(): string[] {
  return (notify as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === "work_log")
    .map((c) => String(c[1]));
}

function alerts_notes(): string[] {
  return (notify as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === "alerts")
    .map((c) => String(c[1]));
}

describe("broker dark-transition visibility (#91)", () => {
  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "broker-dark-vis-"));
    (notify as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("restart (reconcile) with a previously-assigned broker channel: exactly ONE info signal, no alerts-severity", async () => {
    const pool = make_pool();
    const log_spy = vi.spyOn(console, "log");
    pool.inject_bots([assigned_broker_bot(3)]);

    await pool.run_reconcile();

    // One dark signal for the channel, naming channel + reason.
    expect(pool.dark_signals).toHaveLength(1);
    expect(pool.dark_signals[0]).toMatchObject({ channel_id: BROKER_CHANNEL });
    expect(pool.dark_signals[0]!.reason).toContain("restart");
    // Structured info log emitted once.
    const dark_logs = log_spy.mock.calls.filter((c) => String(c[0]).includes("[broker-dark]"));
    expect(dark_logs).toHaveLength(1);
    expect(String(dark_logs[0]![0])).toContain(BROKER_CHANNEL);
    expect(String(dark_logs[0]![0])).toContain("awaiting inbound");
    // Low-severity work_log note, and NO alerts-severity notification.
    expect(work_log_notes()).toHaveLength(1);
    expect(work_log_notes()[0]).toContain(BROKER_CHANNEL);
    expect(alerts_notes()).toHaveLength(0);
  });

  it("restart (proactive-resume) path emits the signal too — once per channel", async () => {
    const pool = make_pool();
    pool.inject_bots([
      assigned_broker_bot(3, BROKER_CHANNEL),
      assigned_broker_bot(4, BROKER_CHANNEL_2),
    ]);
    pool.set_resume_candidates([
      {
        id: 3,
        state: "assigned",
        channel_id: BROKER_CHANNEL,
        entity_id: "test-entity",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-3",
        last_active: null,
      },
      {
        id: 4,
        state: "assigned",
        channel_id: BROKER_CHANNEL_2,
        entity_id: "test-entity",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-4",
        last_active: null,
      },
    ]);

    await pool.run_resume();

    // One signal per channel, not per tick and not per candidate-pass.
    expect(pool.dark_signals).toHaveLength(2);
    expect(new Set(pool.dark_signals.map((s) => s.channel_id))).toEqual(
      new Set([BROKER_CHANNEL, BROKER_CHANNEL_2]),
    );
    expect(alerts_notes()).toHaveLength(0);
  });

  it("health-tick release emits once, then subsequent ticks stay silent (no per-tick spam)", async () => {
    const pool = make_pool();
    pool.inject_bots([assigned_broker_bot(3)]);

    await pool.run_health_check(); // session dead → released to dark, one signal
    expect(pool.dark_signals).toHaveLength(1);

    // Three more ticks over the now-free bot: zero additional signals.
    await pool.run_health_check();
    await pool.run_health_check();
    await pool.run_health_check();
    expect(pool.dark_signals).toHaveLength(1);
    expect(work_log_notes()).toHaveLength(1);
  });

  it("a failing work_log note never breaks the release path", async () => {
    const pool = make_pool();
    (notify as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Discord API down"),
    );
    pool.inject_bots([assigned_broker_bot(3)]);

    await pool.run_health_check();

    // Release completed despite the failed note.
    expect((pool as unknown as { bots: PoolBot[] }).bots[0]!.state).toBe("free");
    expect(pool.dark_signals).toHaveLength(1);
  });

  it("plugin revive-failure alerting unchanged: a dead PLUGIN bot that cannot be revived still alerts at alerts-severity", async () => {
    const pool = make_pool();
    // Make the plugin respawn fail so reconcile takes the un-revivable path.
    (pool as unknown as { start_tmux: ReturnType<typeof vi.fn> }).start_tmux.mockRejectedValue(
      new Error("tmux launch failed"),
    );
    pool.inject_bots([
      make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-plugin",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-5",
      }),
    ]);

    await pool.run_reconcile();

    // No broker dark signal for a plugin channel …
    expect(pool.dark_signals).toHaveLength(0);
    // … and the pre-existing alerts-severity path still fires.
    expect(alerts_notes().some((m) => m.includes("could not be revived"))).toBe(true);
  });
});
