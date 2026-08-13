/**
 * #107 choke-point guard + end-to-end zombie regression.
 *
 * The 07-05 re-pilot failure class: a broker session created with NO inbound
 * driver idles at the prompt, never confirms, and (pre-#90) crash-looped. #90
 * removed the restart paths; this suite proves the invariant is now enforced
 * INSIDE assign() — no caller, present or future, can create a driverless
 * broker session — and that the full restart→dark→driven-cold-recreate→kill→
 * dark→driven-cold-recreate sequence produces zero idle sessions at every step.
 *
 * Harness mirrors broker-first-message.test.ts: REAL start_tmux (mocked
 * child_process/fs) so prepare_broker_session registers ownership and the
 * first-message block actually runs.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(""),
    execSync: vi.fn().mockReturnValue(""),
    spawn: vi.fn(),
  };
});

vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { DiscordBroker } from "../broker/index.js";
import { BotPool, type PendingMessage, type PoolBot } from "../pool.js";
import * as sentry from "../sentry.js";

function fake_tmux_proc(): ChildProcess {
  return {
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      if (ev === "close") setTimeout(() => cb(0), 0);
      return undefined;
    },
  } as unknown as ChildProcess;
}

const PILOT_CHANNEL = "chan-broker-pilot";
const PLUGIN_CHANNEL = "chan-plugin";
const ENTITY = "entity-1";

let dir: string;

function make_config(broker_enabled: boolean): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: dir },
    discord: {
      server_id: "guild-1",
      broker: { enabled: broker_enabled, pilot_channels: [PILOT_CHANNEL] },
    },
  });
}

function make_bot(id: number, state_dir: string, overrides: Partial<PoolBot> = {}): PoolBot {
  return {
    id,
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: false,
    tmux_session: `pool-${String(id)}`,
    last_active: null,
    assigned_at: null,
    state_dir,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

function driver(content: string): PendingMessage {
  return {
    user: "hunter",
    channel_id: PILOT_CHANNEL,
    message_id: "",
    content,
    ts: new Date().toISOString(),
  };
}

/** Real start_tmux (so broker ownership registers), togglable tmux liveness,
 * simulated JSONL confirmation, side effects stubbed. */
class TestPool extends BotPool {
  tmux_alive = true;

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }
  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }
  get_crash_history(): Map<number, number[]> {
    return (this as unknown as { crash_history: Map<number, number[]> }).crash_history;
  }
  set_resume_candidates(candidates: unknown[]): void {
    (this as unknown as { resume_candidates: unknown[] }).resume_candidates = candidates;
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

  protected override is_tmux_alive(): boolean {
    return this.tmux_alive;
  }
  protected override check_session_jsonl_exists_anywhere(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override check_session_jsonl_exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  /** Simulated JSONL confirmation: the driven first turn commits to disk. */
  protected override watch_session_confirmation(bot: PoolBot): void {
    bot.session_confirmed = true;
  }
  protected override async write_access_json(): Promise<void> {}
  protected override async set_bot_nickname(): Promise<void> {}
  protected override async set_bot_avatar(): Promise<void> {}
  protected override async ensure_entity_channels_allowlisted(): Promise<void> {}
  protected override kill_tmux(): void {}
  protected override async persist(): Promise<void> {}
  protected override extract_on_session_end(): Promise<void> {
    return Promise.resolve();
  }
  protected override is_bot_idle(): boolean {
    return true;
  }
}

async function make_harness(broker_enabled = true): Promise<{
  pool: TestPool;
  broker: DiscordBroker;
  feed_spy: ReturnType<typeof vi.spyOn>;
}> {
  const config = make_config(broker_enabled);
  const pool = new TestPool(config);
  const broker = new DiscordBroker({
    config,
    socket_path: join(dir, "b.sock"),
    queue_path: join(dir, "q.json"),
  });
  const feed_spy = vi.spyOn(broker, "feed");
  pool.set_broker(broker);

  // state_dir must exist for prepare_broker_session (real mkdir bypassing the
  // fs mock) — otherwise broker prep falls back to the plugin transport.
  const state_dir = join(dir, "pool-4");
  const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await mkdir(state_dir, { recursive: true });
  pool.inject_bots([make_bot(4, state_dir)]);

  return { pool, broker, feed_spy };
}

/** AC helper: "zero idle sessions" — every assigned bot must be confirmed
 * (its first turn committed) and there must be at most `expected` assigned. */
function expect_no_idle_sessions(pool: TestPool, expected_assigned: number): void {
  const assigned = pool.get_bots().filter((b) => b.state === "assigned");
  expect(assigned).toHaveLength(expected_assigned);
  for (const bot of assigned) {
    expect(bot.session_confirmed).toBe(true);
  }
}

describe("assign() choke-point guard (#107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = join(tmpdir(), `broker-choke-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    (spawn as unknown as Mock).mockImplementation(() => fake_tmux_proc());
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { rm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("refuses a driverless assign for a broker channel: null, no spawn, structured refusal, Sentry event", async () => {
    const { pool } = await make_harness();
    const error_spy = vi.spyOn(console, "error");

    const result = await pool.assign(PILOT_CHANNEL, ENTITY, "planner");

    expect(result).toBeNull();
    // Nothing spawned — the channel stays dark.
    expect(spawn).not.toHaveBeenCalled();
    expect(pool.get_bots()[0]!.state).toBe("free");
    // One structured refusal log naming the caller-supplied context.
    const refusals = error_spy.mock.calls.filter((c) => String(c[0]).includes("[broker-guard]"));
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0]![0])).toContain(PILOT_CHANNEL);
    expect(String(refusals[0]![0])).toContain(ENTITY);
    expect(String(refusals[0]![0])).toContain("planner");
    // Sentry event recorded.
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("choke-point guard"),
      "warning",
      expect.objectContaining({
        contexts: expect.objectContaining({
          assign: expect.objectContaining({ channel_id: PILOT_CHANNEL, entity_id: ENTITY }),
        }),
      }),
    );
  });

  it("the guard sees through every caller shape: resume ids and channel types don't bypass it", async () => {
    const { pool } = await make_harness();
    // /open-style: resume_session_id + work_room, still driverless → refused.
    const result = await pool.assign(
      PILOT_CHANNEL,
      ENTITY,
      "builder",
      "sess-archived",
      "work_room",
    );
    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a driven assign on the same channel succeeds where the driverless one was refused", async () => {
    const { pool, feed_spy } = await make_harness();

    expect(await pool.assign(PILOT_CHANNEL, ENTITY, "planner")).toBeNull();

    const result = await pool.assign(
      PILOT_CHANNEL,
      ENTITY,
      "planner",
      undefined,
      undefined,
      undefined,
      driver("hello"),
    );
    expect(result).not.toBeNull();
    expect(feed_spy).toHaveBeenCalledTimes(1);
    expect((feed_spy.mock.calls[0]![0] as { content: string }).content).toBe("hello");
    expect_no_idle_sessions(pool, 1);
  });

  it("FLAG OFF: a driverless assign on a would-be pilot channel behaves byte-identically to the plugin path", async () => {
    const { pool } = await make_harness(false);
    const error_spy = vi.spyOn(console, "error");

    const result = await pool.assign(PILOT_CHANNEL, ENTITY, "planner");

    // Assigns exactly as today: no guard, no refusal, session spawns.
    expect(result).not.toBeNull();
    expect(spawn).toHaveBeenCalled();
    expect(
      error_spy.mock.calls.filter((c) => String(c[0]).includes("[broker-guard]")),
    ).toHaveLength(0);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("FLAG ON, plugin (non-pilot) channel: driverless assign is untouched", async () => {
    const { pool } = await make_harness(true);
    const result = await pool.assign(PLUGIN_CHANNEL, ENTITY, "planner");
    expect(result).not.toBeNull();
    expect(spawn).toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });
});

describe("end-to-end zombie regression (#107 AC): restart→dark→driven recreate→kill→dark→driven recreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = join(tmpdir(), `broker-zombie-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    (spawn as unknown as Mock).mockImplementation(() => fake_tmux_proc());
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { rm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("zero idle sessions at every step of the full lifecycle", async () => {
    const { pool, broker, feed_spy } = await make_harness();

    // ── Step 1: fresh driven assign (path 1) ──
    const first = await pool.assign(
      PILOT_CHANNEL,
      ENTITY,
      "planner",
      undefined,
      undefined,
      undefined,
      driver("msg-1"),
    );
    expect(first).not.toBeNull();
    const original_session = first!.session_id!;
    expect(broker.owns(PILOT_CHANNEL)).toBe(true);
    expect(feed_spy).toHaveBeenCalledTimes(1);
    expect_no_idle_sessions(pool, 1);
    const spawns_after_assign = (spawn as unknown as Mock).mock.calls.length;

    // ── Step 2: daemon restart simulation — proactive-resume must NOT respawn ──
    // What initialize() would persist/restore: the bot comes back assigned with
    // a dead tmux (old daemon took the MCP connection down with it).
    pool.tmux_alive = false;
    pool.set_resume_candidates([
      {
        id: 4,
        state: "assigned",
        channel_id: PILOT_CHANNEL,
        entity_id: ENTITY,
        archetype: "planner",
        channel_type: null,
        session_id: original_session,
        last_active: null,
      },
    ]);
    await pool.run_resume();

    // Dark: no session, no spawn, continuity stashed.
    expect_no_idle_sessions(pool, 0);
    expect(pool.get_bots()[0]!.state).toBe("free");
    expect((spawn as unknown as Mock).mock.calls.length).toBe(spawns_after_assign);
    expect(pool.get_session_history().get(`${ENTITY}:${PILOT_CHANNEL}`)).toBe(original_session);
    // Restart-reconcile pass finds nothing left to repair — still dark.
    await pool.run_reconcile();
    expect_no_idle_sessions(pool, 0);

    // ── Step 3: inbound arrives → SINGLE driven cold recreate with --resume ──
    pool.tmux_alive = true;
    const second = await pool.assign(
      PILOT_CHANNEL,
      ENTITY,
      "planner",
      undefined,
      undefined,
      undefined,
      driver("msg-2"),
    );
    expect(second).not.toBeNull();
    // Continuity: the stash resolved to the original session for --resume.
    expect(second!.session_id).toBe(original_session);
    expect(feed_spy).toHaveBeenCalledTimes(2);
    expect((feed_spy.mock.calls[1]![0] as { content: string }).content).toBe("msg-2");
    expect_no_idle_sessions(pool, 1);

    // ── Step 4: kill the session mid-idle → dark, zero respawns across 3 ticks ──
    pool.tmux_alive = false;
    const spawns_before_kill = (spawn as unknown as Mock).mock.calls.length;
    for (let tick = 0; tick < 3; tick++) {
      await pool.run_health_check();
      expect_no_idle_sessions(pool, 0);
    }
    expect(pool.get_bots()[0]!.state).toBe("free");
    expect((spawn as unknown as Mock).mock.calls.length).toBe(spawns_before_kill);
    // The crash-loop counter never ticked — release short-circuits before
    // record_crash (the 07-05 loop cannot even start).
    expect(pool.get_crash_history().get(4) ?? []).toHaveLength(0);
    // Continuity survived the kill too.
    expect(pool.get_session_history().get(`${ENTITY}:${PILOT_CHANNEL}`)).toBe(original_session);

    // ── Step 5: next inbound → single driven cold recreate again ──
    pool.tmux_alive = true;
    const third = await pool.assign(
      PILOT_CHANNEL,
      ENTITY,
      "planner",
      undefined,
      undefined,
      undefined,
      driver("msg-3"),
    );
    expect(third).not.toBeNull();
    expect(third!.session_id).toBe(original_session);
    expect(feed_spy).toHaveBeenCalledTimes(3);
    expect_no_idle_sessions(pool, 1);

    // Across the whole lifecycle: sessions were ONLY ever created by driven
    // assigns — one spawn per driven message-carrying assign, zero from
    // restart/watchdog paths.
    await (broker as unknown as { queue: { flush: () => Promise<void> } }).queue.flush();
  });

  it("caller-shaped drivers (swap/room/resume events) each produce a confirmed session with the driver as turn #1", async () => {
    // The four callers synthesize different driver contents; what the AC needs
    // is that EACH lands in the broker queue as the first turn and the session
    // confirms. (The callers' own synthesis is covered in
    // broker-driverless-callers.test.ts; the HTTP 422 in pool-assign-http.)
    const shapes: Array<{ label: string; content: string }> = [
      { label: "/swap", content: "hunter swapped you in as the builder archetype via /swap." },
      { label: "/room", content: "Room #warroom created by hunter via /room." },
      { label: "/resume", content: "Session warroom resumed by hunter via /resume." },
      { label: "HTTP", content: "operator-driven first message" },
    ];

    for (const shape of shapes) {
      const { pool, feed_spy } = await make_harness();
      const result = await pool.assign(
        PILOT_CHANNEL,
        ENTITY,
        "builder",
        undefined,
        undefined,
        undefined,
        driver(shape.content),
      );
      expect(result, shape.label).not.toBeNull();
      expect(feed_spy, shape.label).toHaveBeenCalledTimes(1);
      expect((feed_spy.mock.calls[0]![0] as { content: string }).content, shape.label).toBe(
        shape.content,
      );
      // JSONL confirms (simulated by the watcher override) — no idle session.
      expect_no_idle_sessions(pool, 1);
    }
  });
});
