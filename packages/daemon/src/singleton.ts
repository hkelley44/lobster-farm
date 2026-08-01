import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { DAEMON_PORT, pid_file_path } from "@lobster-farm/shared";

// Singleton port guard (#97).
//
// A duplicate daemon must never blind-loop on EADDRINUSE. In #97 an orphaned
// `node` (reparented off a dead `op run`) kept holding :7749; launchd's
// KeepAlive respawned the wrapper 14,882 times, and every fresh process threw
// an uncaught EADDRINUSE → exit 1 → respawn. Worse, listen() sat at the *end*
// of startup, so each doomed respawn first connected to the Discord gateway —
// which tripped Discord's abuse protection and auto-reset our bot token.
//
// The fix binds the port up-front (before Discord/pool/commander come up) and
// treats a conflict as a clean, deliberate exit rather than a crash.

export interface ListenErrorVerdict {
  /** 0 = intentional stand-aside (incumbent owns the port); 1 = real fault. */
  exit_code: 0 | 1;
  message: string;
}

/**
 * Decide how to react to a failed `listen()`. Pure, so it is unit-tested
 * without opening real sockets.
 *
 * EADDRINUSE → exit 0: another daemon already owns the port, so stepping aside
 * is success, not failure. Any other errno is a genuine fault → exit 1.
 */
export function classify_listen_error(
  err: NodeJS.ErrnoException,
  port: number,
  incumbent_pid: number | null,
): ListenErrorVerdict {
  if (err.code === "EADDRINUSE") {
    const who = incumbent_pid !== null ? ` (pid ${String(incumbent_pid)})` : "";
    return {
      exit_code: 0,
      message: `daemon already listening on :${String(port)}${who} — exiting`,
    };
  }
  return {
    exit_code: 1,
    message: `fatal listen error on :${String(port)}: ${err.message}`,
  };
}

/**
 * Best-effort read of the PID file so a conflict message can name the
 * incumbent. Synchronous and swallowing — this only ever decorates a log line.
 */
export function read_incumbent_pid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pid_file_path(), "utf-8").trim(), 10);
    return Number.isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Bind the daemon's port and return the listening Server.
 *
 * Called first thing in startup so a duplicate instance discovers the conflict
 * immediately — before any subsystem (notably the Discord gateway) is touched.
 * The returned server is handed to `start_server`, which attaches the request
 * handler; there is no second bind and thus no bind race.
 *
 * On EADDRINUSE this exits 0 (clean stand-aside); on any other listen error it
 * exits 1. Either way the process never falls through to an uncaught exception.
 */
export function acquire_port(port: number = DAEMON_PORT): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      const verdict = classify_listen_error(err, port, read_incumbent_pid());
      console.error(`[singleton] ${verdict.message}`);
      process.exit(verdict.exit_code);
    });

    server.listen(port, () => {
      // Bind succeeded — drop the startup error handler so later runtime errors
      // surface normally instead of triggering the stand-aside exit.
      server.removeAllListeners("error");
      resolve(server);
    });
  });
}
