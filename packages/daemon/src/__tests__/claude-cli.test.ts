/**
 * Tests for claude-cli.ts — the daemon's single headless `claude -p` entry
 * point (issue #79).
 *
 * These drive REAL child processes against fake `claude` scripts rather than a
 * mocked `spawn`. The bug this module exists to prevent is a stdin-lifecycle
 * bug; a mock of `spawn` models the lifecycle it is supposed to be testing and
 * would have passed against the broken code.
 *
 * Covers:
 *   - resolves on exit 0, with the prompt arriving over stdin
 *   - stdin is closed, so a stdin-reading child never hangs
 *   - rejects on non-zero exit (surfacing stderr) and on timeout
 *   - rejects on spawn failure
 *   - survives async EPIPE when the child dies mid-write (issue #81 item 1)
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAIKU_PRINT_ARGS, claude_bin, run_claude_print } from "../claude-cli.js";

describe("claude_bin", () => {
  const original = process.env.CLAUDE_BIN;

  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = original;
  });

  it("defaults to `claude` and honours CLAUDE_BIN", () => {
    delete process.env.CLAUDE_BIN;
    expect(claude_bin()).toBe("claude");
    process.env.CLAUDE_BIN = "/opt/fake/claude";
    expect(claude_bin()).toBe("/opt/fake/claude");
  });
});

describe("HAIKU_PRINT_ARGS", () => {
  it("is headless print mode with no session persistence, and carries no prompt", () => {
    expect(HAIKU_PRINT_ARGS).toEqual([
      "-p",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--print",
    ]);
    // The whole point of the module: the prompt is never an argv element.
    // A trailing positional would reintroduce the #79 bug at every call site.
    expect(HAIKU_PRINT_ARGS[HAIKU_PRINT_ARGS.length - 1]).toBe("--print");
  });

  it("is frozen, so no call site can append a prompt to it at runtime", () => {
    // `readonly string[]` is compile-time only. Both call sites share this one
    // array object, so a single cast-and-push would reintroduce #79 at both at
    // once — the exact bug the module exists to make impossible.
    expect(Object.isFrozen(HAIKU_PRINT_ARGS)).toBe(true);
    expect(() => (HAIKU_PRINT_ARGS as string[]).push("the prompt")).toThrow(TypeError);
    expect(HAIKU_PRINT_ARGS).toHaveLength(5);
  });
});

describe("run_claude_print", () => {
  let bin_dir: string;

  beforeEach(async () => {
    bin_dir = await mkdtemp(join(tmpdir(), "lf-claude-bin-"));
  });

  afterEach(async () => {
    await rm(bin_dir, { recursive: true, force: true });
  });

  /** Write an executable shell script and return its path. */
  async function make_script(name: string, body: string): Promise<string> {
    const path = join(bin_dir, name);
    await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, "utf-8");
    await chmod(path, 0o755);
    return path;
  }

  /**
   * Write an executable ESM Node script and return its path.
   *
   * `.mjs` because the temp bin dir has no `package.json`, so an extensionless
   * file would be parsed as CJS and `import` would throw. Used where a test
   * needs byte-level control over what the child writes — `fs.writeSync(fd)`
   * bypasses the stdout stream's own buffering, so the chunk boundaries the
   * test sets up are the chunk boundaries the parent actually reads.
   */
  async function make_node_script(name: string, body: string): Promise<string> {
    const path = join(bin_dir, `${name}.mjs`);
    await writeFile(path, `#!/usr/bin/env node\n${body}\n`, "utf-8");
    await chmod(path, 0o755);
    return path;
  }

  // ── UTF-8 chunk-boundary decoding ──
  //
  // A pipe is a byte stream with no respect for character boundaries: the
  // kernel can deliver a multibyte UTF-8 sequence split across two reads. The
  // original code accumulated with `stdout += String(d)`, which decodes each
  // Buffer INDEPENDENTLY — so a straddling sequence became U+FFFD replacement
  // characters on both sides of the boundary, irrecoverably. `setEncoding`
  // installs a StringDecoder that holds the partial sequence until the rest
  // arrives.
  //
  // Why this matters here specifically: Haiku's summaries of sessions in this
  // codebase are full of em-dashes, arrows and `✓`/`🔴` (the summarizer mirrors
  // its input). A split chunk silently wrote `??`-looking garbage into the
  // daily log — permanently, with no error anywhere — and the same accumulator
  // feeds `generate_heartbeat`, so the corruption could reach a Discord
  // message. Exactly the self-concealing-corruption class this module exists
  // to eliminate.
  //
  // `U+2014` EM DASH is `E2 80 94`. Splitting after two bytes leaves an
  // incomplete sequence at the end of chunk 1 and a stray continuation byte at
  // the start of chunk 2 — the worst case, and the one that produced
  // `"�� shipped the fix"` when reproduced against the real spawn
  // path.

  /** Body for a child that writes `text` split mid-character across two chunks. */
  function split_writer_body(text: string, fd: 1 | 2, exit_code: number): string {
    return [
      'import { writeSync } from "node:fs";',
      `const full = Buffer.from(${JSON.stringify(text)}, "utf8");`,
      // Two bytes into the leading 3-byte em-dash.
      `writeSync(${String(fd)}, full.subarray(0, 2));`,
      // A real gap so the parent's reader drains chunk 1 before chunk 2 exists.
      // Without this the kernel would hand both writes over in a single read
      // and the bug would be invisible — which is why it survived review.
      "setTimeout(() => {",
      `  writeSync(${String(fd)}, full.subarray(2));`,
      `  process.exit(${String(exit_code)});`,
      "}, 60);",
    ].join("\n");
  }

  const SPLIT_TEXT = "— shipped the fix ✓";

  it("reassembles a multibyte character split across two stdout chunks", async () => {
    const bin = await make_node_script("split-stdout", split_writer_body(SPLIT_TEXT, 1, 0));
    const out = await run_claude_print(bin, [], "", 5_000);

    expect(out).toBe(SPLIT_TEXT);
    // Spelled out separately: the failure mode is replacement characters, and
    // this is the assertion that names it.
    expect(out).not.toContain("�");
  });

  it("reassembles a multibyte character split across two stderr chunks", async () => {
    // stderr is not cosmetic — it is the only diagnostic in the rejection
    // message that reaches the daemon log and the daily-log marker, so it gets
    // the same guarantee as stdout.
    const bin = await make_node_script("split-stderr", split_writer_body(SPLIT_TEXT, 2, 3));
    await expect(run_claude_print(bin, [], "", 5_000)).rejects.toThrow(
      new RegExp(`exited 3: ${SPLIT_TEXT}`),
    );
  });

  it("resolves with stdout when the child exits 0", async () => {
    // Echoes back whatever it reads on stdin, proving the prompt is fed there
    // and stdin is closed (otherwise `cat` would block forever).
    const bin = await make_script("ok", "cat");
    const out = await run_claude_print(bin, [], "hello over stdin", 5_000);
    expect(out).toBe("hello over stdin");
  });

  it("closes stdin so a stdin-reading child never hangs", async () => {
    // `cat` with no args reads until EOF. If stdin were left open this would
    // hang until the 1s timeout and reject. It must resolve fast instead.
    const bin = await make_script("cat-eof", "cat");
    const out = await run_claude_print(bin, [], "", 1_000);
    expect(out).toBe("");
  });

  it("rejects when the child exits non-zero, surfacing stderr", async () => {
    const bin = await make_script("fail", 'echo "boom" >&2\nexit 3');
    // Names the binary (not a hardcoded "claude"), the exit code, and the
    // child's stderr — the three things a best-effort caller's single swallowed
    // log line has to carry.
    await expect(run_claude_print(bin, [], "x", 5_000)).rejects.toThrow(/\/fail exited 3: boom/);
  });

  it("rejects and kills the child on timeout", async () => {
    // Sleeps well past the timeout; run_claude_print must SIGKILL it and reject.
    const bin = await make_script("slow", "sleep 5");
    const started = Date.now();
    // The rejection message is generic over `bin` — it names the binary and the
    // elapsed budget rather than a hardcoded "claude -p timeout" string.
    await expect(run_claude_print(bin, [], "x", 150)).rejects.toThrow(/timed out after 150ms/);
    // Should reject promptly at the timeout, not wait out the full 5s sleep.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects when the binary does not exist (spawn error)", async () => {
    await expect(
      run_claude_print(join(bin_dir, "does-not-exist"), [], "x", 1_000),
    ).rejects.toBeInstanceOf(Error);
  });

  it("passes args through ahead of the stdin payload", async () => {
    // Guards the contract both call sites rely on: argv is the flag list only,
    // and the prompt is not appended to it.
    const bin = await make_script("echo-args", 'printf "%s\\n" "$@"\ncat >/dev/null');
    const out = await run_claude_print(bin, HAIKU_PRINT_ARGS, "the prompt", 5_000);
    expect(out.trim().split("\n")).toEqual([...HAIKU_PRINT_ARGS]);
    expect(out).not.toContain("the prompt");
  });

  // ── async stdin EPIPE (issue #81 item 1 — PRIORITY, daemon-crash vector) ──

  it("settles cleanly when the child exits before draining a large stdin payload (async EPIPE)", async () => {
    // Regression for the daemon-crash vector: a child that exits immediately
    // leaves its stdin pipe with no reader. Writing a payload LARGER than the OS
    // pipe buffer (~64 KiB on Darwin/Linux) can't complete synchronously — the
    // kernel raises EPIPE on the stdin stream ASYNCHRONOUSLY, as an 'error'
    // event. Without `child.stdin.on("error", ...)` Node escalates that to an
    // uncaught exception and kills the whole daemon. This test drives the REAL
    // spawn/stdin path (a real child process that exits at once) and asserts the
    // promise settles instead of throwing uncaught.
    const bin = await make_script("exit-fast", "exit 0");
    // 1 MiB — well past any pipe buffer, guaranteeing the write outlives the child.
    const big_payload = "x".repeat(1024 * 1024);

    // A rejection is a clean settle (the child exited non-zero or the write path
    // errored); a resolve is also clean. The ONLY unacceptable outcome is an
    // uncaught 'error' event crashing the process — which manifests here as the
    // test runner recording an unhandled error. Guard against that explicitly.
    let uncaught: unknown;
    const on_uncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", on_uncaught);
    try {
      await run_claude_print(bin, [], big_payload, 5_000).then(
        () => undefined,
        () => undefined, // reject is a valid clean settle
      );
      // Give any async EPIPE a tick to surface before we assert.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", on_uncaught);
    }
    expect(uncaught).toBeUndefined();
  });

  it("does not crash when the child dies mid-write on a large payload", async () => {
    // Complementary case: the child reads a little then exits, so the writer is
    // still pushing bytes when the read end closes — the classic broken-pipe
    // race the reviewer called out (SIGKILL-on-timeout / instant-exit). Must
    // settle without an uncaught throw.
    const bin = await make_script("read-then-die", "head -c 10 >/dev/null; exit 0");
    const big_payload = "y".repeat(1024 * 1024);
    let uncaught: unknown;
    const on_uncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", on_uncaught);
    try {
      await run_claude_print(bin, [], big_payload, 5_000).then(
        () => undefined,
        () => undefined,
      );
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", on_uncaught);
    }
    expect(uncaught).toBeUndefined();
  });
});
