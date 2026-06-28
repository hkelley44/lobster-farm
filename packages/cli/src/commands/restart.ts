import { execFileSync, spawnSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LAUNCHD_LABEL, daemon_log_path, expand_home, pid_file_path } from "@lobster-farm/shared";
import { Command } from "commander";
import {
  generate_plist,
  generate_wrapper_sh,
  is_service_loaded,
  plist_path,
} from "../lib/launchd.js";
import { is_process_running, read_pid_file } from "../lib/process.js";
import { resolve_daemon_path } from "./start.js";

/** Resolve the absolute path to the node binary. */
function resolve_node_path(): string {
  try {
    return execFileSync("which", ["node"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "/opt/homebrew/bin/node";
  }
}

/**
 * Run `launchctl kickstart -k` and return the exit code.
 * Isolated into its own function so tests can mock it without touching
 * the real launchctl.
 */
export function kickstart_daemon(uid: number): number {
  const result = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], {
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    // The spawn itself failed (ENOENT, EACCES, etc.) — launchctl never ran.
    // Log a distinct message so operators don't conflate this with a status-1
    // exit from launchctl (which would mean "daemon may be wedged").
    console.error(
      `Warning: failed to spawn launchctl — ${result.error.message}. Falling back to SIGKILL.`,
    );
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Send SIGKILL to the given PID.  Returns true if the signal was delivered
 * (process existed), false if the process was already gone.
 */
export function sigkill_pid(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export const restart_command = new Command("restart")
  .description("Hot-restart the daemon (preserves tmux sessions)")
  .action(async () => {
    const loaded = await is_service_loaded();
    if (!loaded) {
      console.log("Daemon is not running. Use 'lf start' instead.");
      return;
    }

    // Regenerate the wrapper script and plist before restarting so the new
    // process picks up any changes (heap size, op run integration, daemon
    // path, ExitTimeout for graceful drain).
    const wrapper_path = join(expand_home("~/.lobsterfarm"), "bin", "start-daemon.sh");
    const log_path = daemon_log_path();
    const working_dir = expand_home("~/.lobsterfarm");

    const wrapper_content = generate_wrapper_sh(resolve_node_path(), resolve_daemon_path());
    await writeFile(wrapper_path, wrapper_content, { encoding: "utf-8", mode: 0o755 });
    await chmod(wrapper_path, 0o755);

    const plist_content = generate_plist(wrapper_path, log_path, working_dir);
    await writeFile(plist_path(), plist_content, { encoding: "utf-8" });

    console.log("Regenerated wrapper script and plist.");

    // Snapshot the old PID before kickstart so we can detect whether the
    // daemon actually cycled (new PID) vs. got wedged.
    const old_pid = await read_pid_file(pid_file_path());

    // launchctl kickstart -k sends SIGTERM to the running process and
    // starts a fresh one after ExitTimeout.  The daemon's shutdown handler
    // drains active sessions before exiting — pool bots survive the restart
    // and are rediscovered on startup via pool-state.json + tmux checks.
    //
    // If the daemon's drain loop is stuck (e.g. an agent that never finishes),
    // kickstart times out with status 37 — see issue #75.  We detect this and
    // fall back to a SIGKILL on the old PID so KeepAlive can respawn cleanly.
    const uid = process.getuid?.() ?? 501;
    const kickstart_exit = kickstart_daemon(uid);

    // The daemon's drain deadline is SHUTDOWN_DRAIN_TIMEOUT_MS (default 90s),
    // well inside launchd's ExitTimeout (300s).  Under normal conditions
    // kickstart exits 0 as soon as the old daemon dies and the new one starts.
    // Status 37 ("service not in domain" / timeout) means the old process
    // didn't exit in time.
    const kickstart_ok = kickstart_exit === 0;

    if (!kickstart_ok) {
      console.log(
        `Warning: kickstart exited with status ${String(kickstart_exit)} — daemon may be wedged. Attempting SIGKILL fallback...`,
      );

      // Attempt to SIGKILL the old process so KeepAlive respawns it.
      if (old_pid !== null && is_process_running(old_pid)) {
        // Guard against PID-reuse race: if the wedged daemon exited between
        // kickstart returning and the is_process_running() check, KeepAlive
        // may have already spawned a *new* daemon that reused old_pid.  The
        // new daemon writes a fresh pidfile on startup, so if the pidfile now
        // contains a *different* PID (or is gone), the new daemon is already
        // up — don't SIGKILL it.
        const current_pid = await read_pid_file(pid_file_path());
        if (current_pid !== old_pid) {
          console.log(
            `Pidfile changed (was ${String(old_pid)}, now ${current_pid === null ? "gone" : String(current_pid)}) — new daemon already up. Skipping SIGKILL.`,
          );
        } else {
          const killed = sigkill_pid(old_pid);
          if (killed) {
            console.log(
              `Sent SIGKILL to old daemon (PID ${String(old_pid)}). KeepAlive will respawn on the new dist.`,
            );
          } else {
            console.log(
              `Old daemon (PID ${String(old_pid)}) was already gone — KeepAlive should respawn shortly.`,
            );
          }
        }
      } else if (old_pid === null) {
        console.log("No PID file found — cannot identify old daemon process. Check logs.");
      } else {
        console.log(
          `Old daemon (PID ${String(old_pid)}) is not running — KeepAlive should respawn shortly.`,
        );
      }
    } else {
      console.log("Daemon restarting — draining active sessions (up to 90s)...");
    }

    // Poll for the new process to start and write its PID file.
    // Allow extra time after a SIGKILL fallback since KeepAlive needs a
    // moment to detect the exit and spawn the replacement.
    const POLL_INTERVAL_MS = 500;
    const TIMEOUT_MS = kickstart_ok ? 10_000 : 15_000;
    const start = Date.now();
    let pid: number | null = null;

    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      pid = await read_pid_file(pid_file_path());
      // Accept a new PID, or the old PID if kickstart succeeded (the new
      // process may reuse a PID on a busy system, but that's rare).
      if (pid !== null && is_process_running(pid) && pid !== old_pid) {
        break;
      }
      pid = null;
    }

    if (pid !== null) {
      console.log(`Daemon is back online (PID ${String(pid)}).`);
    } else if (!kickstart_ok) {
      console.log(
        "Warning: new daemon PID not detected within timeout. KeepAlive may still be respawning — check logs.",
      );
    } else {
      console.log("Warning: daemon may not have restarted. Check logs.");
    }
  });
