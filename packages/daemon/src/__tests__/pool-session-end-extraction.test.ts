/**
 * Pool session-end extraction (#43).
 *
 * Verifies that `extract_session_learnings` (the Haiku-powered daily-log
 * helper in hooks.ts) fires exactly once per session lifecycle when the
 * bot transitions out of `assigned` — at park, at release, and on
 * post-mortem recovery from a crashed daemon — and *not* once per
 * assistant turn (which would happen if the Stop hook were the venue).
 *
 * We mock `execFile` so the test never actually shells out to `claude -p`;
 * each call to the real `extract_session_learnings` returns a deterministic
 * stdout that we check landed in the daily log.
 */
import { readFile, readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema, entity_daily_dir } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub `child_process.execFile` so `extract_session_learnings` (which goes
// through promisify(execFile)) resolves with a canned Haiku summary and
// NEVER actually spawns a real `claude` binary. Defined as a hoisted ref
// so `vi.mock` can capture it before the module-under-test loads.
const { execFile_mock } = vi.hoisted(() => {
  // The promisified form passes `(cmd, args, opts, cb)` — we pull the
  // callback off the end and invoke it asynchronously.
  const mock = vi.fn(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // simulate a successful Haiku summary
      setImmediate(() => cb(null, { stdout: "- did things\n- learned stuff", stderr: "" }));
    },
  );
  return { execFile_mock: mock };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFile_mock };
});

// Mock sentry — avoid real network/logging side effects.
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Mock persistence so pool.persist() doesn't try to write JSON to disk
// outside our temp dir layout (which `entity_daily_dir` uses but
// `save_pool_state` does its own pathing).
vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn(async () => {}),
  load_pool_state: vi.fn(async () => null),
}));

// Import AFTER vi.mock so the daemon picks up our stubs.
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

/** Test subclass that exposes the private surface we need to drive
 * session-end transitions directly, and short-circuits side-effecting
 * helpers (tmux, access.json, persist). */
class TestPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }
  /** Direct passthrough to the private park_bot — the test's primary entry
   * point for the "park a bot" acceptance case. */
  async test_park(bot: PoolBot): Promise<void> {
    await (this as unknown as { park_bot: (b: PoolBot) => Promise<void> }).park_bot(bot);
  }
  /** Direct passthrough to the protected extract_on_session_end so we can
   * assert the gate-on-state semantic without juggling park_bot/release. */
  async test_extract(bot: PoolBot): Promise<void> {
    await (
      this as unknown as { extract_on_session_end: (b: PoolBot) => Promise<void> }
    ).extract_on_session_end(bot);
  }
}

/** Read the entity's daily-log entries — returns one string per `## HH:MM:SS`
 * timestamped block written by `append_to_daily_log`. */
async function read_daily_entries(entity_id: string, config: LobsterFarmConfig): Promise<string[]> {
  const daily_dir = entity_daily_dir(config.paths, entity_id);
  let files: string[];
  try {
    files = await readdir(daily_dir);
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const body = await readFile(join(daily_dir, file), "utf-8");
    // Each entry is `\n## HH:MM:SS\n\n...`. Split on the `## ` marker and
    // drop the header line so the result is one element per session-end.
    const blocks = body.split(/^## /m).slice(1);
    entries.push(...blocks);
  }
  return entries;
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

function assigned_bot(id: number): PoolBot {
  return make_bot({
    id,
    state: "assigned",
    channel_id: `chan-${String(id)}`,
    entity_id: "test-entity",
    archetype: "ben",
    session_id: `session-${String(id)}-uuid-1234567890abcdef`,
    last_active: new Date(),
    assigned_at: new Date(),
  });
}

describe("pool session-end extraction (#43)", () => {
  let config: LobsterFarmConfig;
  let pool: TestPool;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pool-session-end-"));
    config = make_config();
    pool = new TestPool(config);
    execFile_mock.mockClear();

    // Silence side-effecting privates: tmux kill, access.json write.
    vi.spyOn(
      pool as unknown as { kill_tmux: (s: string) => void },
      "kill_tmux" as never,
    ).mockImplementation(() => {});
    vi.spyOn(
      pool as unknown as { write_access_json: (...args: unknown[]) => Promise<void> },
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("park_bot: writes exactly one daily-log entry per session", async () => {
    const bot = assigned_bot(1);
    pool.inject_bots([bot]);

    await pool.test_park(bot);

    // Haiku invocation fires exactly once.
    expect(execFile_mock).toHaveBeenCalledTimes(1);

    // The bot is now parked (not assigned).
    expect(bot.state).toBe("parked");

    // The daily log has one timestamped entry containing the canned summary.
    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("did things");
    expect(entries[0]).toContain("learned stuff");
  });

  it("crash recovery: post-mortem extraction fires once on a dirty assigned bot", async () => {
    // Simulate the post-mortem path in `initialize`: the bot was assigned
    // at shutdown, tmux is now dead. The recovery branch transiently sets
    // the bot to `assigned` (so the helper's gate accepts), calls extract,
    // then flips to `parked` for the auto-resume path. We exercise the
    // helper directly here because the full `initialize` flow involves
    // filesystem scanning we don't need to re-cover.
    const bot = assigned_bot(2);
    pool.inject_bots([bot]);

    await pool.test_extract(bot);
    // After post-mortem, the recovery code immediately flips to parked.
    bot.state = "parked";

    expect(execFile_mock).toHaveBeenCalledTimes(1);
    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
  });

  it("10 turns within one session produces exactly 1 entry, not 10", async () => {
    const bot = assigned_bot(3);
    pool.inject_bots([bot]);

    // Simulate 10 assistant turns: in a Stop-hook-based implementation
    // each turn would re-run extraction. With pool-side extraction, turns
    // are invisible — no extraction fires until the bot transitions out
    // of `assigned`. We model this by re-touching last_active 10 times,
    // then parking once.
    for (let i = 0; i < 10; i++) {
      bot.last_active = new Date();
    }
    await pool.test_park(bot);

    expect(execFile_mock).toHaveBeenCalledTimes(1);
    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
  });

  it("subagent runs inside parent session: no separate entry beyond parent's", async () => {
    // Subagents don't have their own pool bots — they run inside the
    // parent's tmux session. The pool only ever sees the parent bot's
    // session-end transition. We verify that re-touching last_active to
    // simulate "subagent activity" and then parking once produces a
    // single extraction (the parent's), not two.
    const bot = assigned_bot(4);
    pool.inject_bots([bot]);

    // simulate subagent work as additional turns on the same bot
    bot.last_active = new Date();
    bot.last_active = new Date();
    await pool.test_park(bot);

    expect(execFile_mock).toHaveBeenCalledTimes(1);
    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
  });

  it("exactly-once gate: a re-park on an already-parked bot is a no-op", async () => {
    // Defensive gate check. The helper is `protected`; if a future call
    // site invokes it on a bot whose state is already `parked`, it must
    // bail without re-firing Haiku.
    const bot = assigned_bot(5);
    pool.inject_bots([bot]);

    await pool.test_park(bot);
    expect(execFile_mock).toHaveBeenCalledTimes(1);

    // bot is now `parked`. Call the helper again — must be a no-op.
    await pool.test_extract(bot);
    expect(execFile_mock).toHaveBeenCalledTimes(1);
  });

  it("missing entity/archetype: helper bails silently without writing a log", async () => {
    // The two force-free branches in restart_crashed_session can call the
    // helper with a partial bot (entity/archetype null). Verify we don't
    // shell out to Haiku and don't write a daily-log entry in that case.
    const bot = make_bot({ id: 6, state: "assigned" });
    pool.inject_bots([bot]);

    await pool.test_extract(bot);
    expect(execFile_mock).not.toHaveBeenCalled();

    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(0);
  });

  it("Haiku failure: extraction is best-effort — daily log gets a marker entry", async () => {
    // `extract_session_learnings` swallows execFile errors and writes a
    // fallback marker entry. Verify that contract holds end-to-end.
    execFile_mock.mockImplementationOnce((_cmd, _args, _opts, cb: (err: Error | null) => void) => {
      setImmediate(() => cb(new Error("haiku unavailable")));
    });

    const bot = assigned_bot(7);
    pool.inject_bots([bot]);
    await pool.test_park(bot);

    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("extraction skipped");
  });
});
