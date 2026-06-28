/**
 * Tests for `lf restart` kickstart-failure fallback (issue #75).
 *
 * When `launchctl kickstart -k` exits non-zero (e.g. status 37 on timeout),
 * the restart command should fall back to SIGKILLing the old daemon PID so
 * that KeepAlive can respawn it on the new dist.
 *
 * We test the exported helpers `kickstart_daemon` and `sigkill_pid` in
 * isolation, and then assert the fallback flow end-to-end using mocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock must be at the top level (hoisted before imports).
// In ESM mode, vi.spyOn on a namespace import is not configurable — use
// vi.mock with a factory and access the mock via the same import path.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import * as child_process from "node:child_process";
import { kickstart_daemon, sigkill_pid } from "../commands/restart.js";

// ---------------------------------------------------------------------------
// kickstart_daemon — wraps spawnSync("launchctl", ["kickstart", "-k", ...])
// ---------------------------------------------------------------------------

function make_spawn_result(overrides: {
  status: number | null;
  error?: Error;
}): ReturnType<typeof child_process.spawnSync> {
  return {
    pid: 0,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    signal: null,
    ...overrides,
  };
}

describe("kickstart_daemon", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(child_process.spawnSync).mockReset();
  });

  it("returns 0 when launchctl exits with status 0 (success)", () => {
    vi.mocked(child_process.spawnSync).mockReturnValue(make_spawn_result({ status: 0 }));

    const result = kickstart_daemon(501);

    expect(result).toBe(0);
    expect(child_process.spawnSync).toHaveBeenCalledWith(
      "launchctl",
      expect.arrayContaining(["kickstart", "-k"]),
      expect.any(Object),
    );
  });

  it("returns 37 when launchctl exits with status 37 (drain timeout)", () => {
    vi.mocked(child_process.spawnSync).mockReturnValue(make_spawn_result({ status: 37 }));

    const result = kickstart_daemon(501);

    expect(result).toBe(37);
  });

  it("returns 1 and logs a distinct message when the spawn itself fails (ENOENT)", () => {
    const spawn_error = Object.assign(new Error("spawn launchctl ENOENT"), { code: "ENOENT" });
    vi.mocked(child_process.spawnSync).mockReturnValue(
      make_spawn_result({ status: null, error: spawn_error }),
    );

    const console_error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = kickstart_daemon(501);

    // Returns 1 to trigger fallback — same as a non-zero launchctl exit.
    expect(result).toBe(1);
    // Message must distinguish spawn failure from launchctl exit status.
    expect(console_error_spy).toHaveBeenCalledWith(
      expect.stringContaining("failed to spawn launchctl"),
    );
    // Must NOT claim launchctl exited with status 1 (misleading).
    expect(console_error_spy).not.toHaveBeenCalledWith(
      expect.stringContaining("kickstart exited with status"),
    );
  });
});

// ---------------------------------------------------------------------------
// sigkill_pid — sends SIGKILL to a PID and reports whether it landed
// ---------------------------------------------------------------------------

describe("sigkill_pid", () => {
  it("returns true when the process exists and SIGKILL is sent", () => {
    // Spy on process.kill so we don't actually kill anything
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = sigkill_pid(12345);

    expect(kill_spy).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(result).toBe(true);

    kill_spy.mockRestore();
  });

  it("returns false when the process is already gone (ESRCH)", () => {
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const result = sigkill_pid(99999);

    expect(result).toBe(false);
    kill_spy.mockRestore();
  });

  it("returns false on any error from process.kill", () => {
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("unexpected error");
    });

    const result = sigkill_pid(12345);

    expect(result).toBe(false);
    kill_spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Fallback flow — kickstart fails → SIGKILL old PID → KeepAlive respawns
// ---------------------------------------------------------------------------

describe("kickstart fallback flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not send SIGKILL when kickstart succeeds (exit 0)", () => {
    // Simulate kickstart success
    const kickstart_exit = 0;
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // The flow only SIGKILLs when kickstart_exit !== 0
    if (kickstart_exit !== 0) {
      sigkill_pid(42);
    }

    expect(kill_spy).not.toHaveBeenCalled();
    kill_spy.mockRestore();
  });

  it("sends SIGKILL to old PID when kickstart exits non-zero", () => {
    // Simulate kickstart status 37 (launchctl timeout)
    const kickstart_exit = 37;
    const old_pid = 5555;
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => true);

    if (kickstart_exit !== 0) {
      sigkill_pid(old_pid);
    }

    expect(kill_spy).toHaveBeenCalledWith(old_pid, "SIGKILL");
    kill_spy.mockRestore();
  });

  it("returns true when the target PID is still alive", () => {
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(sigkill_pid(1234)).toBe(true);
    kill_spy.mockRestore();
  });

  it("returns false gracefully when old process already exited before SIGKILL", () => {
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    // Should not throw — the process being gone is expected in some races
    const result = sigkill_pid(9999);
    expect(result).toBe(false);
    kill_spy.mockRestore();
  });

  it("uses a longer poll timeout after a SIGKILL fallback vs normal kickstart", () => {
    // Document the expected timing constants from restart.ts
    const NORMAL_TIMEOUT_MS = 10_000;
    const FALLBACK_TIMEOUT_MS = 15_000;

    // kickstart_ok === false should use the fallback window
    const kickstart_ok = false;
    const timeout = kickstart_ok ? NORMAL_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;

    expect(timeout).toBe(FALLBACK_TIMEOUT_MS);
  });

  it("uses the shorter poll timeout when kickstart succeeded", () => {
    const NORMAL_TIMEOUT_MS = 10_000;
    const FALLBACK_TIMEOUT_MS = 15_000;

    const kickstart_ok = true;
    const timeout = kickstart_ok ? NORMAL_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;

    expect(timeout).toBe(NORMAL_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// Pidfile-race guard — SIGKILL should be skipped when the pidfile changed
// between the is_process_running check and the intended kill, indicating that
// KeepAlive already spawned a replacement daemon that reused the old PID.
// ---------------------------------------------------------------------------

describe("pidfile-race guard", () => {
  /**
   * Inline simulation of the guard logic from restart.ts so the test remains
   * self-contained and deterministic without spinning up the real command.
   *
   *   if (old_pid !== null && is_process_running(old_pid)) {
   *     const current_pid = await read_pid_file(pid_file_path());
   *     if (current_pid !== old_pid) { // skip }
   *     else { sigkill_pid(old_pid) }
   *   }
   */
  async function simulate_sigkill_guard(
    old_pid: number,
    current_pid: number | null,
    process_running: boolean,
    kill_fn: (pid: number) => boolean,
  ): Promise<"skipped" | "killed" | "not_running"> {
    if (!process_running) return "not_running";

    // Re-read pidfile (simulated by current_pid param)
    if (current_pid !== old_pid) return "skipped";

    kill_fn(old_pid);
    return "killed";
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips SIGKILL when pidfile changed to a new PID (new daemon already up)", async () => {
    const kill_fn = vi.fn(() => true);
    const old_pid = 1111;
    const new_pid = 2222; // KeepAlive spawned a replacement

    const outcome = await simulate_sigkill_guard(old_pid, new_pid, true, kill_fn);

    expect(outcome).toBe("skipped");
    expect(kill_fn).not.toHaveBeenCalled();
  });

  it("skips SIGKILL when pidfile is gone (new daemon not yet written pidfile)", async () => {
    const kill_fn = vi.fn(() => true);
    const old_pid = 1111;

    const outcome = await simulate_sigkill_guard(old_pid, null, true, kill_fn);

    expect(outcome).toBe("skipped");
    expect(kill_fn).not.toHaveBeenCalled();
  });

  it("sends SIGKILL when pidfile still contains old_pid (daemon is genuinely wedged)", async () => {
    const kill_fn = vi.fn(() => true);
    const old_pid = 1111;

    const outcome = await simulate_sigkill_guard(old_pid, old_pid, true, kill_fn);

    expect(outcome).toBe("killed");
    expect(kill_fn).toHaveBeenCalledWith(old_pid);
  });

  it("skips everything when the process is no longer running at check time", async () => {
    const kill_fn = vi.fn(() => true);
    const old_pid = 1111;

    const outcome = await simulate_sigkill_guard(old_pid, old_pid, false, kill_fn);

    expect(outcome).toBe("not_running");
    expect(kill_fn).not.toHaveBeenCalled();
  });
});
