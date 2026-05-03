/**
 * Detect whether the compiled `dist/` output is in sync with the current
 * source tree.
 *
 * Why this exists: `lf update` historically short-circuited whenever
 * `git pull` was a no-op, on the assumption that "no pull needed" implies
 * "no rebuild needed". That assumption breaks whenever HEAD has been
 * advanced (or moved) without going through `pnpm build` — e.g. `git reset
 * --hard`, branch switch, manual rebase. See issue #24.
 *
 * Strategy (preference order):
 *   1. No `dist/index.js` → stale (never built).
 *   2. `dist/.build-sha` exists and matches HEAD → fresh.
 *      `dist/.build-sha` exists and differs from HEAD → stale.
 *      The SHA stamp is the durable, branch-switch-robust signal. It is
 *      written by `lf update` after every successful rebuild it triggers.
 *   3. No SHA stamp (build predates this feature, or was done outside
 *      `lf update`) → fall back to mtime comparison: stale iff
 *      `dist/index.js` mtime is older than HEAD's commit time.
 *      mtime catches forward HEAD moves but is blind to backward branch
 *      switches — those will only be caught after the first stamped build.
 *
 * The IO seam (`fs_io`) is injected so this module can be unit-tested
 * against fixture data without needing a real git repo or real files.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Path of the dist artifact whose freshness gates rebuild decisions. */
export const DIST_INDEX_REL = "packages/daemon/dist/index.js";

/** Path of the SHA stamp written after a successful `lf update` build. */
export const DIST_SHA_STAMP_REL = "packages/daemon/dist/.build-sha";

/** Result of a staleness check, including a human-readable reason. */
export interface StalenessResult {
  /** True if dist is out of sync with HEAD (or unknown / missing). */
  stale: boolean;
  /** Short explanation suitable for logging. */
  reason: string;
}

/**
 * Filesystem read seam — kept narrow so tests can stub it without
 * touching real disk. Each method maps directly to one node:fs call.
 */
export interface DistFsIo {
  /** Does the path exist on disk? */
  exists(path: string): boolean;
  /** mtime in seconds since epoch (float). Throws if the file is missing. */
  mtime_seconds(path: string): number;
  /** Read a file as utf-8. Throws if missing. */
  read_text(path: string): string;
}

/** Default IO implementation backed by node:fs. */
export const default_dist_fs_io: DistFsIo = {
  exists: (path) => existsSync(path),
  mtime_seconds: (path) => statSync(path).mtimeMs / 1000,
  read_text: (path) => readFileSync(path, "utf-8"),
};

/**
 * Determine whether the compiled output at `repo_dir` matches `head_sha` /
 * `head_commit_time_s`.
 *
 * @param repo_dir              Absolute path of the repo root.
 * @param head_sha              Full SHA returned by `git rev-parse HEAD`.
 * @param head_commit_time_s    HEAD commit time as unix epoch seconds
 *                              (integer; from `git log -1 --format=%ct`).
 * @param fs_io                 Injectable filesystem reader. Defaults to node:fs.
 */
export function check_dist_staleness(
  repo_dir: string,
  head_sha: string,
  head_commit_time_s: number,
  fs_io: DistFsIo = default_dist_fs_io,
): StalenessResult {
  const dist_index = join(repo_dir, DIST_INDEX_REL);
  if (!fs_io.exists(dist_index)) {
    return { stale: true, reason: "dist not built yet" };
  }

  const sha_stamp = join(repo_dir, DIST_SHA_STAMP_REL);
  if (fs_io.exists(sha_stamp)) {
    const stamped = fs_io.read_text(sha_stamp).trim();
    if (stamped === head_sha) {
      return { stale: false, reason: `dist matches HEAD (${head_sha.slice(0, 8)})` };
    }
    const stamped_short = stamped ? stamped.slice(0, 8) : "<empty>";
    return {
      stale: true,
      reason: `dist built from ${stamped_short}, HEAD is ${head_sha.slice(0, 8)}`,
    };
  }

  // mtime fallback — only meaningful for forward HEAD moves.
  const dist_mtime_s = fs_io.mtime_seconds(dist_index);
  if (dist_mtime_s < head_commit_time_s) {
    return {
      stale: true,
      reason: `dist mtime ${Math.floor(dist_mtime_s)} older than HEAD commit time ${head_commit_time_s}`,
    };
  }
  return {
    stale: false,
    reason: "dist mtime newer than HEAD commit time (no SHA stamp; mtime fallback)",
  };
}
