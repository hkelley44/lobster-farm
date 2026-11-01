/**
 * Regression guard: memory extraction must feed its prompt over stdin and
 * CLOSE it (issue #79, second call site).
 *
 * `hooks.ts` used to call `promisify(execFile)` with the prompt as a trailing
 * argv element. `execFile` never closes the child's stdin, and `claude -p`
 * blocks on stdin regardless of how the prompt arrived — so every extraction
 * paid a fixed ~3s `no stdin data received in 3s` stall out of a 30s budget.
 * Under load that tipped over into a timeout, which `extract_session_learnings`
 * swallows as best-effort. The visible result was a daily-log entry reading
 * "extraction skipped" and the platform's memory silently going stale: 7 such
 * failures against 11 successes in the live daemon log.
 *
 * ── Why these tests drive a real child process ──
 *
 * This is a process-lifecycle bug. A mocked `spawn`/`execFile` models the very
 * lifecycle under test and passes happily against the broken code — which is
 * precisely how the bug survived at this call site after being fixed at the
 * other one. So `CLAUDE_BIN` points at a real fake-CLI script that reproduces
 * the two behaviours that matter about `claude -p`:
 *
 *   1. it reads its prompt from stdin, and
 *   2. if stdin is still open after a grace period it gives up with the real
 *      CLI's "no stdin data received" message on stderr and a non-zero exit.
 *
 * Against the old `execFile` code every test below fails (the fake CLI never
 * sees EOF, exits 1, and the daily log gets the "extraction skipped" marker).
 * Against `run_claude_print` they all pass in milliseconds.
 */

import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema, entity_daily_dir } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point `find_session_file` at a fixture we control instead of scanning
// ~/.claude/projects. Everything downstream of it — the JSONL parse, the prompt
// build, the spawn, the daily-log write — is the real implementation.
const { find_session_file_mock } = vi.hoisted(() => ({
  find_session_file_mock: vi.fn<(session_id: string) => Promise<string | null>>(),
}));

vi.mock("../session-context.js", async () => {
  const actual =
    await vi.importActual<typeof import("../session-context.js")>("../session-context.js");
  return { ...actual, find_session_file: find_session_file_mock };
});

import { extract_session_learnings } from "../hooks.js";

/** A marker planted in the transcript; proves prompt *content* reached stdin. */
const TRANSCRIPT_MARKER = "HOISTED_RUN_CLAUDE_PRINT_INTO_CLAUDE_CLI";

let temp_dir: string;
let argv_log: string;
let stdin_log: string;
const ORIGINAL_ENV = { ...process.env };

/**
 * Write a fake `claude` CLI that mimics the real binary's stdin dependency.
 *
 * `grace_ms` is the stdin deadline. The real CLI waits 3s; we use a short grace
 * so the broken-code direction fails fast and deterministically instead of
 * hanging out to the production timeout.
 */
async function write_fake_claude(grace_ms: number): Promise<string> {
  const path = join(temp_dir, "fake-claude.mjs");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

// Record how we were invoked so the test can assert the prompt is NOT in argv.
writeFileSync(process.env.LF_ARGV_LOG, JSON.stringify(process.argv.slice(2)), "utf-8");

let buf = "";
let ended = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { buf += d; });
process.stdin.on("end", () => {
  ended = true;
  writeFileSync(process.env.LF_STDIN_LOG, buf, "utf-8");
  process.stdout.write("- extracted the learnings\\n");
  process.exit(0);
});

// The behaviour under test: stdin left open is a hard failure, exactly as the
// real \`claude -p\` treats it (it warns "no stdin data received in 3s").
setTimeout(() => {
  if (ended) return;
  writeFileSync(process.env.LF_STDIN_LOG, "", "utf-8");
  process.stderr.write("Warning: no stdin data received in ${String(grace_ms)}ms\\n");
  process.exit(1);
}, ${String(grace_ms)});
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return path;
}

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

/** Read today's daily-log body for an entity ("" when nothing was written). */
async function read_daily_log(entity_id: string, config: LobsterFarmConfig): Promise<string> {
  const daily_dir = entity_daily_dir(config.paths, entity_id);
  let files: string[];
  try {
    files = await readdir(daily_dir);
  } catch {
    return "";
  }
  const bodies = await Promise.all(
    files.filter((f) => f.endsWith(".md")).map((f) => readFile(join(daily_dir, f), "utf-8")),
  );
  return bodies.join("\n");
}

/** Stage a transcript fixture containing the marker and point the finder at it. */
async function stage_transcript(session_id: string): Promise<void> {
  const lines = [
    JSON.stringify({
      type: "assistant",
      uuid: "t0",
      message: { role: "assistant", content: [{ type: "text", text: "Read the call sites." }] },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "t1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Then I ${TRANSCRIPT_MARKER} and shipped it.` }],
      },
    }),
  ];
  const path = join(temp_dir, `${session_id}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf-8");
  find_session_file_mock.mockImplementation(async (sid) => (sid === session_id ? path : null));
}

describe("memory extraction feeds its prompt over stdin (#79, hooks.ts call site)", () => {
  let config: LobsterFarmConfig;
  const SESSION = "aabbccdd-1111-2222-3333-444455556666";

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "lf-hooks-stdin-"));
    argv_log = join(temp_dir, "argv.json");
    stdin_log = join(temp_dir, "stdin.txt");
    config = make_config();

    // 250ms stdin grace: ample for a working implementation (stdin is closed
    // synchronously right after spawn), hard-fails the broken one fast.
    process.env.CLAUDE_BIN = await write_fake_claude(250);
    process.env.LF_ARGV_LOG = argv_log;
    process.env.LF_STDIN_LOG = stdin_log;

    await stage_transcript(SESSION);
  });

  afterEach(async () => {
    // Two-pass restore: drop keys we added, then put originals back.
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("closes stdin, so the CLI returns a summary instead of the skipped marker", async () => {
    // THE regression assertion. Broken code: the fake CLI never sees EOF, exits
    // 1, `extract_session_learnings` swallows it and writes "extraction
    // skipped". Fixed code: a real summary lands in the daily log.
    await extract_session_learnings("test-entity", "chan-1", "ben", SESSION, config);

    const log = await read_daily_log("test-entity", config);
    expect(log).toContain("extracted the learnings");
    expect(log).not.toContain("extraction skipped");
  });

  it("delivers the prompt over stdin, not as an argv element", async () => {
    await extract_session_learnings("test-entity", "chan-1", "ben", SESSION, config);

    const argv = JSON.parse(await readFile(argv_log, "utf-8")) as string[];
    const stdin = await readFile(stdin_log, "utf-8");

    // argv is the flag list only. The old code appended the whole prompt here,
    // which is what left stdin dangling.
    expect(argv).toEqual(["-p", "--model", "haiku", "--no-session-persistence", "--print"]);
    expect(argv.some((a) => a.includes(TRANSCRIPT_MARKER))).toBe(false);

    // ...and the prompt — transcript content included — arrived on stdin.
    expect(stdin).toContain(TRANSCRIPT_MARKER);
    expect(stdin).toContain("--- SESSION TRANSCRIPT ---");
  });

  it("writes a marker and logs a reason when the CLI exits 0 with empty stdout", async () => {
    // The silent hole. `claude` can succeed and still return nothing — an empty
    // completion, a refusal, a truncated response, a transcript Haiku declines
    // to summarize. The original code guarded the daily-log write behind
    // `if (summary)` with no `else`, so this produced ZERO daily-log entry and
    // ZERO log line: indistinguishable from extraction never having fired.
    //
    // That is strictly worse than the #79 bug this branch fixes, which at least
    // left an "extraction skipped" breadcrumb. It also contradicts the project
    // rule the author applied to every empty-return path in
    // `read_session_transcript` — a lookup gating a health signal must log on
    // failure, not only on success — while leaving the one at the actual Haiku
    // boundary unguarded.
    const empty = join(temp_dir, "empty-claude.mjs");
    await writeFile(
      empty,
      [
        "#!/usr/bin/env node",
        // Still drain stdin and exit 0: this is the SUCCESS path, so the test
        // cannot pass by accident through the failure branch.
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        // Whitespace-only, not strictly empty — `stdout.trim()` must be what
        // decides, so a CLI that emits a bare newline is covered too.
        '  process.stdout.write("   \\n  \\n");',
        "  process.exit(0);",
        "});",
      ].join("\n"),
      "utf-8",
    );
    await chmod(empty, 0o755);
    process.env.CLAUDE_BIN = empty;

    const log_spy = vi.spyOn(console, "log");

    await expect(
      extract_session_learnings("test-entity", "chan-1", "ben", SESSION, config),
    ).resolves.toBeUndefined();

    // 1. A gap marker exists in the daily log, so the day is not silently short
    //    one session...
    const log = await read_daily_log("test-entity", config);
    expect(log).toContain("extraction returned no summary");
    // ...and it is distinguishable from both of the other two outcomes.
    expect(log).not.toContain("extraction skipped");
    expect(log).not.toContain("no transcript to summarize");

    // 2. ...and the daemon log names the reason, so the next person grepping
    //    can tell "Haiku returned nothing" from "extraction never ran".
    const lines = log_spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("returned empty output"))).toBe(true);
  });

  it("still degrades to a marker entry when the CLI genuinely fails", async () => {
    // The best-effort contract must survive the fix: a real non-zero exit is
    // still swallowed and still leaves a breadcrumb in the daily log.
    const failing = join(temp_dir, "failing-claude.mjs");
    await writeFile(
      failing,
      '#!/usr/bin/env node\nprocess.stderr.write("boom\\n");\nprocess.exit(7);\n',
      "utf-8",
    );
    await chmod(failing, 0o755);
    process.env.CLAUDE_BIN = failing;

    await expect(
      extract_session_learnings("test-entity", "chan-1", "ben", SESSION, config),
    ).resolves.toBeUndefined();

    const log = await read_daily_log("test-entity", config);
    expect(log).toContain("extraction skipped");
  });
});
