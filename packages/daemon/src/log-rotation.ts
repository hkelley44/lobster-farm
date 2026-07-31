import { renameSync, statSync } from "node:fs";

// launchd never rotates the file it wires to StandardOutPath/StandardErrorPath.
// A crash-looping or long-wedged daemon therefore bloats daemon.log without
// bound — it hit 61 MB in #97. We cap it by rotating on startup: every launchd
// spawn runs main(), which renames an over-cap log aside before it writes much.
export const DEFAULT_MAX_LOG_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Rotate `log_path` to `${log_path}.1` if it is at or above `max_bytes`.
 *
 * Best-effort: any filesystem error (missing file, permission) is swallowed —
 * log rotation must never block daemon startup. Returns true only when a
 * rotation actually happened.
 *
 * Only a single backup is kept; a prior `.1` is replaced. That's deliberate —
 * the goal is to bound disk usage, not to archive history. The live log is a
 * launchd-owned fd we cannot redirect from inside the process, so on the spawn
 * that trips the cap this run's output continues in the rotated `.1` file and
 * the next spawn opens a fresh `log_path`.
 */
export function rotate_log_if_needed(
  log_path: string,
  max_bytes: number = DEFAULT_MAX_LOG_BYTES,
): boolean {
  let size: number;
  try {
    size = statSync(log_path).size;
  } catch {
    // No log yet (or unreadable) — nothing to rotate.
    return false;
  }

  if (size < max_bytes) return false;

  try {
    renameSync(log_path, `${log_path}.1`);
    return true;
  } catch {
    return false;
  }
}
