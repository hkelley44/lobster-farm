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
import { readFile, readdir, writeFile } from "node:fs/promises";
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

// Mock session transcript resolution so tests control which JSONL (if any)
// `extract_session_learnings` finds for a given session id. `read_session_transcript`
// in hooks.ts calls `find_session_file` then reads the file with the real `readFile`,
// so we hand back a path to a real fixture written into the temp dir — exercising the
// actual parse/bound logic without scanning ~/.claude/projects.
const { find_session_file_mock } = vi.hoisted(() => ({
  find_session_file_mock: vi.fn<(session_id: string) => Promise<string | null>>(),
}));

vi.mock("../session-context.js", async () => {
  const actual =
    await vi.importActual<typeof import("../session-context.js")>("../session-context.js");
  return { ...actual, find_session_file: find_session_file_mock };
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
import { BotPool } from "../pool.js";
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
 * helpers (tmux, access.json, persist).
 *
 * Production fires extraction with `void` (fire-and-forget). To assert on
 * the daily-log side effect deterministically, we capture every launched
 * extraction promise and expose `flush_extractions()` as a join point. */
class TestPool extends BotPoolTestBase {
  private launched_extractions: Promise<void>[] = [];

  protected override extract_on_session_end(bot: PoolBot): Promise<void> {
    // BotPoolTestBase no-ops extraction to keep lifecycle tests from racing
    // teardown. This suite is the one that *does* test extraction, so reach
    // past the base to the real BotPool implementation.
    const p = BotPool.prototype.extract_on_session_end.call(this, bot) as Promise<void>;
    this.launched_extractions.push(p);
    return p;
  }

  /** Await all extraction work launched so far, then clear the buffer. */
  async flush_extractions(): Promise<void> {
    await Promise.all(this.launched_extractions);
    this.launched_extractions = [];
  }

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }
  /** Drive park_bot (the primary "park a bot" acceptance entry point), then
   * flush the fire-and-forget extraction it launched. */
  async test_park(bot: PoolBot): Promise<void> {
    await (this as unknown as { park_bot: (b: PoolBot) => Promise<void> }).park_bot(bot);
    await this.flush_extractions();
  }
  /** Drive release(channel_id) — the public release entry point with its own
   * in-flight lock — then flush the fire-and-forget extraction it launched. */
  async test_release(channel_id: string): Promise<void> {
    await this.release(channel_id);
    await this.flush_extractions();
  }
  /** Drive extract_on_session_end directly so we can assert the gate-on-state
   * semantic without juggling park_bot/release. */
  async test_extract(bot: PoolBot): Promise<void> {
    await this.extract_on_session_end(bot);
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

/** Build a minimal Claude Code JSONL transcript with the given assistant text
 * turns, matching the real on-disk shape (`type: "assistant"`, message.content
 * array of typed blocks). Returns the raw JSONL string. */
function make_transcript(...turns: string[]): string {
  const lines = turns.map((text, i) =>
    JSON.stringify({
      type: "assistant",
      uuid: `turn-${String(i)}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
  );
  // A trailing user line + a tool_use-only assistant line to prove we extract
  // only assistant *text* and ignore everything else.
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: "ignored" } }));
  lines.push(
    JSON.stringify({
      type: "assistant",
      uuid: "tool-only",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
    }),
  );
  return `${lines.join("\n")}\n`;
}

/** Write a transcript fixture into the temp dir and point `find_session_file`
 * at it for the given session id. Returns the absolute fixture path. */
async function stage_transcript(session_id: string, content: string): Promise<string> {
  const path = join(temp_dir, `${session_id}.jsonl`);
  await writeFile(path, content, "utf-8");
  find_session_file_mock.mockImplementation(async (sid: string) =>
    sid === session_id ? path : null,
  );
  return path;
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

    // Default: every session resolves to a real transcript fixture on disk, so
    // the Haiku-path tests below exercise the full read → prompt → summary flow.
    // Tests that need the no-transcript fallback override this per-case.
    const default_transcript = make_transcript(
      "Implemented the session-end extraction wiring.",
      "Verified the daily-log entry lands correctly.",
    );
    const default_path = join(temp_dir, "default-transcript.jsonl");
    await writeFile(default_path, default_transcript, "utf-8");
    find_session_file_mock.mockResolvedValue(default_path);

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

  it("release: writes exactly one daily-log entry and frees the bot", async () => {
    // The release() path has its own in-flight lock (releasing_channels) and
    // wasn't exercised end-to-end. Drive it via the public entry point and
    // confirm extraction fires once before the bot's metadata is nulled.
    const bot = assigned_bot(20);
    pool.inject_bots([bot]);

    await pool.test_release(bot.channel_id as string);

    expect(execFile_mock).toHaveBeenCalledTimes(1);
    // release() frees the bot and clears its session metadata.
    expect(bot.state).toBe("free");
    expect(bot.channel_id).toBeNull();
    expect(bot.session_id).toBeNull();

    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("did things");
  });

  it("release: in-flight lock collapses a concurrent double-release to one extraction", async () => {
    // Two callers (e.g. health monitor + explicit release) racing on the same
    // channel must extract exactly once — the second release should hit the
    // releasing_channels guard and bail before firing.
    const bot = assigned_bot(21);
    pool.inject_bots([bot]);
    const channel_id = bot.channel_id as string;

    // Fire both before awaiting so the second observes the in-flight lock.
    await Promise.all([pool.release(channel_id), pool.release(channel_id)]);
    await pool.flush_extractions();

    expect(execFile_mock).toHaveBeenCalledTimes(1);
    expect(bot.state).toBe("free");
    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
  });

  it("feeds the actual transcript content into the Haiku prompt", async () => {
    // Core regression guard: the prompt handed to `claude -p` must contain
    // text derived from the real JSONL transcript, not just metadata. A unique
    // marker string in the transcript must surface verbatim in the prompt.
    const marker = "REFACTORED_THE_RESUME_LADDER_42";
    const bot = assigned_bot(22);
    await stage_transcript(
      bot.session_id as string,
      make_transcript("Did some setup.", `Then I ${marker} and shipped it.`),
    );
    pool.inject_bots([bot]);

    await pool.test_park(bot);

    expect(execFile_mock).toHaveBeenCalledTimes(1);
    // execFile is called as (cmd, args, opts, cb). The prompt is the last arg.
    const args = execFile_mock.mock.calls[0]?.[1] as string[];
    const prompt = args[args.length - 1] as string;
    expect(prompt).toContain(marker);
    expect(prompt).toContain("SESSION TRANSCRIPT");
    // tool_use / user lines must NOT leak into the prompt — only assistant text.
    expect(prompt).not.toContain("tool_use");
    expect(prompt).not.toContain("ignored");
  });

  it("no-session sentinel: skips the transcript read and writes a marker", async () => {
    // When the bot never confirmed a JSONL, session_id is the `no-session`
    // sentinel. We must NOT attempt to locate/read a file, and must NOT shell
    // out to Haiku — just drop a marker entry.
    const bot = assigned_bot(23);
    bot.session_id = null; // extract_on_session_end maps null → NO_SESSION
    pool.inject_bots([bot]);

    await pool.test_park(bot);

    // No Haiku call, no file lookup.
    expect(execFile_mock).not.toHaveBeenCalled();
    expect(find_session_file_mock).not.toHaveBeenCalled();

    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("no transcript to summarize");
  });

  it("empty/missing transcript: falls back to a marker without calling Haiku", async () => {
    // A confirmed session id whose JSONL can't be found (or has no assistant
    // text) yields an empty transcript. We skip Haiku and write a marker rather
    // than ask it to summarize nothing.
    find_session_file_mock.mockResolvedValue(null);
    const bot = assigned_bot(24);
    pool.inject_bots([bot]);

    await pool.test_park(bot);

    expect(execFile_mock).not.toHaveBeenCalled();
    const entries = await read_daily_entries("test-entity", config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("no transcript to summarize");
  });

  it("does not block the lifecycle on the Haiku round-trip", async () => {
    // Extraction is fire-and-forget: park_bot must complete (bot parked, tmux
    // killed) without waiting on the slow `claude -p` call. Gate a manual
    // resolver so the Haiku call is still pending when we assert.
    let release_haiku: (() => void) | undefined;
    execFile_mock.mockImplementationOnce(
      (
        _cmd,
        _args,
        _opts,
        cb: (err: Error | null, r: { stdout: string; stderr: string }) => void,
      ) => {
        release_haiku = () => cb(null, { stdout: "- slow summary", stderr: "" });
      },
    );

    const bot = assigned_bot(8);
    pool.inject_bots([bot]);

    // park_bot returns immediately even though Haiku hasn't resolved — this is
    // the non-blocking guarantee: the lifecycle transition (state → parked,
    // tmux killed) does not await the extraction at all.
    await (pool as unknown as { park_bot: (b: PoolBot) => Promise<void> }).park_bot(bot);
    expect(bot.state).toBe("parked");

    // Extraction now does an async transcript read before the Haiku call, so
    // let pending IO/microtasks drain (without resolving the gated Haiku cb)
    // until the `claude -p` invocation is reached but still in flight.
    await vi.waitFor(() => expect(execFile_mock).toHaveBeenCalledTimes(1));

    // The daily log hasn't been written yet — extraction is still in flight.
    expect(await read_daily_entries("test-entity", config)).toHaveLength(0);

    // Now let Haiku finish and flush; the entry lands after the fact.
    release_haiku?.();
    await pool.flush_extractions();
    expect(await read_daily_entries("test-entity", config)).toHaveLength(1);
  });
});
