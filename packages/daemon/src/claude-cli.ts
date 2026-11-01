/**
 * The daemon's single entry point for headless `claude -p` invocations.
 *
 * Every non-interactive `claude` call in the daemon MUST go through
 * `run_claude_print`. The reason is a footgun that has already cost us two
 * production outages (issue #79 in `reply-enforcement.ts`, then the identical
 * bug at the `hooks.ts` memory-extraction call site): `promisify(execFile)`
 * never closes the child's stdin, and `claude -p` waits on stdin regardless of
 * whether the prompt was passed as an argv argument. The call does not fail
 * loudly — it stalls, burns ~3s of the caller's budget, and only then proceeds.
 *
 * Centralizing the invocation is what keeps that invariant from drifting back
 * in. There is exactly one place that spawns `claude -p`, and it always closes
 * stdin.
 */

import { spawn } from "node:child_process";

/**
 * The `claude` binary to invoke. Overridable via `CLAUDE_BIN` so tests can
 * point at a fake CLI and operators can pin a specific install.
 */
export function claude_bin(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/**
 * Argv for a one-shot Haiku summarization: headless print mode, no session
 * written to disk. Shared by the heartbeat and memory-extraction call sites so
 * a model or flag change can't land on only one of them.
 *
 * The prompt is deliberately NOT part of this list — it travels over stdin.
 *
 * `Object.freeze`, not just `readonly`: the `readonly` modifier erases at
 * runtime, and this array is shared mutable state reachable from both call
 * sites. A single `(HAIKU_PRINT_ARGS as string[]).push(prompt)` would
 * reintroduce issue #79 at BOTH of them simultaneously. Freezing makes the
 * promise the module's whole existence rests on enforceable rather than
 * advisory.
 *
 * `-p` and `--print` are the same flag (`claude --help`: `-p, --print`), passed
 * twice. Kept byte-identical to the array this replaced so the extraction is
 * provably behaviour-preserving at the heartbeat call site; harmless to the
 * CLI, and not worth a behavioural delta to tidy.
 */
export const HAIKU_PRINT_ARGS: readonly string[] = Object.freeze([
  "-p",
  "--model",
  "haiku",
  "--no-session-persistence",
  "--print",
]);

/**
 * Run `claude -p --print` with the prompt fed over **stdin**, returning stdout.
 *
 * Why spawn (not `promisify(execFile)`): `execFile` never closes the child's
 * stdin, so `claude -p` sits waiting on stdin even when the prompt is passed as
 * an arg — it logs `no stdin data received in 3s, proceeding without it` and
 * routinely blows past a tight time budget (issue #79).
 *
 * The fix, verified against the pinned `CLAUDE_BIN`: pipe the prompt into stdin
 * and `end()` it immediately. This is the documented `claude -p` invocation and
 * removes the wait entirely. The essential invariant is **stdin is never left
 * open** — we always close it, whether or not we write.
 *
 * Kills the child on timeout and rejects. Rejects on any non-zero exit. Never
 * leaves a dangling process or timer.
 *
 * ── The timeout does NOT survive the daemon exiting ──
 *
 * Three facts that belong together, because any one of them alone is
 * misleading. They matter for the fire-and-forget callers (memory extraction)
 * whose child can still be running when the daemon shuts down:
 *
 *   1. **`timeout_ms` is parent-enforced.** It is a `setTimeout` in THIS
 *      process. Once the daemon calls `process.exit()` the timer is gone with
 *      it, so no value of `timeout_ms` bounds an orphaned child. Raising the
 *      budget does not widen the shutdown window — the post-exit window was
 *      always unbounded.
 *   2. **Post-exit reaping relies on launchd's implicit process-group kill.**
 *      `generate_plist` (packages/cli/src/lib/launchd.ts) sets no
 *      `AbandonProcessGroup`, which defaults to false, so launchd SIGKILLs the
 *      job's remaining process group when the main process dies; the daemon is
 *      its own group leader and a non-`detached` spawn inherits its PGID.
 *      ADDING `AbandonProcessGroup` TO THAT PLIST WOULD SILENTLY CONVERT EVERY
 *      SHUTDOWN-ADJACENT `claude -p` INTO AN UNBOUNDED, UNREAPED PROCESS. If
 *      you are here because you want that key for some other orphan problem,
 *      this is the cost.
 *
 *      Confidence, stated plainly because this whole section exists to stop a
 *      comment from over-promising: the plist contents and the PGID
 *      inheritance were verified directly; launchd actually delivering the
 *      group kill was NOT observed, since proving it means killing the live
 *      daemon. Treat (2) as well-founded inference. The warning above holds
 *      either way — if launchd does not reap the group, nothing does.
 *   3. **Outside launchd there is no prompt bound at all.** A foreground `node
 *      dist/index.js`, a dev run or a test leaves only the weak terminal-SIGPIPE
 *      path: `claude -p --print` writes nothing during inference and emits its
 *      answer in one write at the end, so EPIPE on the dead parent's pipe can
 *      only arrive at that final write. An orphan runs to completion — measured
 *      at 6 full seconds of post-parent-death execution and side effects.
 *
 * None of this corrupts the daily log: the child's only channel to the daemon
 * is the stdout pipe, and the log append happens in the parent strictly after
 * the child closes. A parent that dies mid-flight yields no entry, not a
 * partial one.
 */
export function run_claude_print(
  bin: string,
  args: readonly string[],
  input: string,
  timeout_ms: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${bin} timed out after ${String(timeout_ms)}ms`));
    }, timeout_ms);

    // Decode UTF-8 at the STREAM, not per chunk.
    //
    // A pipe is a byte stream and the kernel is free to split a multibyte
    // sequence across two reads. The previous `stdout += String(d)` decoded
    // each Buffer independently, so a straddling character became U+FFFD
    // replacement characters on both sides of the boundary — irrecoverably,
    // and with no error anywhere. `setEncoding` installs a StringDecoder that
    // holds the incomplete sequence until the rest of its bytes arrive.
    //
    // Not theoretical: Haiku's summaries of work in this repo are full of
    // em-dashes, arrows and ✓/🔴 (the summarizer mirrors its input), and this
    // accumulator feeds both the daily log and `generate_heartbeat`'s Discord
    // message. A split chunk silently persisted garbage to disk.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        // Name the binary, matching the timeout message above. These strings
        // are the only diagnostic that reaches the daemon log for a
        // best-effort caller, so "which claude" is worth the characters.
        reject(new Error(`${bin} exited ${String(code)}: ${stderr.slice(0, 200)}`));
      }
    });

    // Swallow async stdin errors. A broken-pipe (EPIPE) is emitted
    // asynchronously as an `'error'` event on the stdin *stream* when the child
    // dies before draining a payload larger than the pipe buffer. Without this
    // listener Node treats it as an unhandled stream error and crashes the
    // process — violating the "NEVER throw inside the Stop-hook budget"
    // invariant of the reply-enforcement caller. The `child.on("error")` and
    // `try/catch` below do NOT catch it (it's neither a spawn error nor
    // synchronous). The `close` handler still settles the promise with the real
    // exit reason.
    child.stdin.on("error", () => {});

    // Feed the prompt over stdin, then close it — this is what unblocks
    // `claude -p`. Guard the synchronous write in case the child died before
    // stdin opened; the async guard above covers the post-write EPIPE case.
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      // The `error`/`close` handlers above will settle the promise.
    }
  });
}
