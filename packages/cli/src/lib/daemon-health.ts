// Daemon health from launchd's point of view (#97).
//
// The PID file alone lied during the #97 incident: it pointed at an orphaned
// `node` that was serving traffic while launchd's managed job crash-looped
// underneath (`state = spawn scheduled`, `last exit code = 1`, `runs = 14882`).
// `lf status` / `lf start` reported "running" and never surfaced the loop.
//
// These helpers parse `launchctl print gui/<uid>/<label>` and reconcile it with
// the PID file so the split-brain and crash-loop states become loud, not
// silent. Parsing and classification are kept pure for unit testing; the
// impure `launchctl` call lives in launchd.ts.

/** Structured view of a launchd job, parsed from `launchctl print`. */
export interface LaunchdJobState {
  /** Whether launchd knows about the job at all (print exited 0). */
  loaded: boolean;
  /** e.g. "running", "spawn scheduled", "waiting". Null when not parseable. */
  state: string | null;
  /** launchd-tracked PID, or null when the job is not currently running. */
  pid: number | null;
  /** Lifetime spawn count. A climbing value with nonzero exit = crash loop. */
  runs: number | null;
  /** Last exit code, or null when never exited / not reported. */
  last_exit_code: number | null;
}

/** A job launchd doesn't manage — every field empty. */
export const UNLOADED_JOB: LaunchdJobState = {
  loaded: false,
  state: null,
  pid: null,
  runs: null,
  last_exit_code: null,
};

/**
 * Parse the output of `launchctl print gui/<uid>/<label>`.
 *
 * The output is tab-indented `key = value` lines. We read the top-level
 * `state`, `pid`, `runs`, and `last exit code`. Nested blocks (endpoints,
 * sockets) repeat `state = active` at deeper indentation — we take the *first*
 * `state` line, which is always the job's own top-level state.
 */
export function parse_launchd_print(output: string): LaunchdJobState {
  const first = (re: RegExp): string | null => output.match(re)?.[1]?.trim() ?? null;

  const state = first(/^\s*state = (.+)$/m);

  const pid_raw = first(/^\s*pid = (\d+)$/m);
  const runs_raw = first(/^\s*runs = (\d+)$/m);
  // "last exit code = 0" — but launchd prints "(never exited)" before the first
  // exit, which this integer-only pattern correctly leaves as null.
  const exit_raw = first(/^\s*last exit code = (-?\d+)$/m);

  return {
    loaded: true,
    state,
    pid: pid_raw !== null ? Number.parseInt(pid_raw, 10) : null,
    runs: runs_raw !== null ? Number.parseInt(runs_raw, 10) : null,
    last_exit_code: exit_raw !== null ? Number.parseInt(exit_raw, 10) : null,
  };
}

export type DaemonHealth =
  | "healthy" // launchd-managed, running, PID file agrees
  | "crash_looping" // launchd keeps respawning with a nonzero last exit
  | "split_brain" // PID file points at a process launchd isn't managing
  | "stopped" // launchd manages it but nothing is running
  | "not_managed"; // launchd has no such job (e.g. run by hand)

export interface HealthReport {
  health: DaemonHealth;
  /** One-line human summary, safe to print directly. */
  summary: string;
  /** True when the operator should be warned loudly (non-healthy, actionable). */
  warn: boolean;
}

/**
 * Reconcile the PID file against launchd's view and classify the daemon.
 *
 * @param pidfile_pid   PID read from the PID file, or null if absent.
 * @param pidfile_alive Whether that PID currently maps to a live process.
 * @param launchd       Parsed launchd job state (UNLOADED_JOB if not loaded).
 */
export function classify_daemon_health(
  pidfile_pid: number | null,
  pidfile_alive: boolean,
  launchd: LaunchdJobState,
): HealthReport {
  // launchd isn't managing the job. If a live PID file exists, the daemon is
  // running unsupervised (exactly the orphaned-node shape from #97).
  if (!launchd.loaded) {
    if (pidfile_alive && pidfile_pid !== null) {
      return {
        health: "split_brain",
        warn: true,
        summary: `PID file points at live PID ${String(pidfile_pid)}, but launchd is not managing the daemon — it is running unsupervised (orphaned). Run 'lf start --upgrade' to reload it under launchd.`,
      };
    }
    return {
      health: "not_managed",
      warn: false,
      summary: "Daemon is not managed by launchd.",
    };
  }

  const runs = launchd.runs ?? 0;
  const last_exit = launchd.last_exit_code;
  const is_running = launchd.state === "running" && launchd.pid !== null;

  // Not running, and the last exit was an error → launchd is throttling a
  // crash loop (state is typically "spawn scheduled" / "waiting").
  if (!is_running && last_exit !== null && last_exit !== 0) {
    return {
      health: "crash_looping",
      warn: true,
      summary: `Daemon is CRASH-LOOPING under launchd — state="${launchd.state ?? "unknown"}", last exit code ${String(last_exit)}, ${String(runs)} runs. Check daemon logs and run 'lf start --upgrade'.`,
    };
  }

  if (!is_running) {
    return {
      health: "stopped",
      warn: true,
      summary: `Daemon is not running (launchd state="${launchd.state ?? "unknown"}", ${String(runs)} runs). Run 'lf start' to bring it up.`,
    };
  }

  // launchd says running. If the PID file names a *different* live process,
  // the PID file is stale/split-brained even though launchd itself is healthy.
  if (pidfile_pid !== null && pidfile_alive && pidfile_pid !== launchd.pid) {
    return {
      health: "split_brain",
      warn: true,
      summary: `launchd is running PID ${String(launchd.pid)}, but the PID file points at a different live PID ${String(pidfile_pid)} (split-brain / orphan). Run 'lf start --upgrade' to reconcile.`,
    };
  }

  return {
    health: "healthy",
    warn: false,
    summary: `Daemon healthy under launchd (PID ${String(launchd.pid)}, ${String(runs)} runs, last exit ${last_exit === null ? "n/a" : String(last_exit)}).`,
  };
}
