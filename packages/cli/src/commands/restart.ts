import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LAUNCHD_LABEL, pid_file_path } from "@lobster-farm/shared";
import { Command } from "commander";
import { generate_plist, generate_wrapper_sh, plist_path } from "../lib/launchd.js";
import { is_service_loaded } from "../lib/launchd.js";
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
    const home = homedir();
    const wrapper_path = join(home, ".lobsterfarm", "bin", "start-daemon.sh");
    const log_path = join(home, ".lobsterfarm", "logs", "daemon.log");
    const working_dir = join(home, ".lobsterfarm");

    const wrapper_content = generate_wrapper_sh(resolve_node_path(), resolve_daemon_path());
    await writeFile(wrapper_path, wrapper_content, { encoding: "utf-8", mode: 0o755 });
    await chmod(wrapper_path, 0o755);

    const plist_content = generate_plist(wrapper_path, log_path, working_dir);
    await writeFile(plist_path(), plist_content, { encoding: "utf-8" });

    console.log("Regenerated wrapper script and plist.");

    // launchctl kickstart -k sends SIGTERM to the running process and
    // starts a fresh one after ExitTimeout.  The daemon's shutdown handler
    // drains active sessions before exiting — pool bots survive the restart
    // and are rediscovered on startup via pool-state.json + tmux checks.
    // Send a second SIGTERM (kill the PID) to force immediate shutdown.
    const uid = process.getuid?.() ?? 501;
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`]);

    console.log("Daemon restarting — draining active sessions (up to 5 min)...");

    // Poll for the new process to start and write its PID file.
    const POLL_INTERVAL_MS = 500;
    const TIMEOUT_MS = 10_000;
    const start = Date.now();
    let pid: number | null = null;

    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      pid = await read_pid_file(pid_file_path());
      if (pid !== null && is_process_running(pid)) {
        break;
      }
      pid = null;
    }

    if (pid !== null) {
      console.log(`Daemon is back online (PID ${pid}).`);
    } else {
      console.log("Warning: daemon may not have restarted. Check logs.");
    }
  });
