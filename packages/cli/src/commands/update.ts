import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  DIST_SHA_STAMP_REL,
  type StalenessResult,
  check_dist_staleness,
} from "../lib/dist-staleness.js";

/**
 * Resolve the monorepo root directory.
 *
 * Strategy: walk up from this file's location until we find a directory
 * that contains `pnpm-workspace.yaml` (the monorepo marker). This works
 * whether the CLI is running from source or from `dist/`.
 */
function resolve_repo_root(): string {
  const this_file = fileURLToPath(import.meta.url);
  let dir = dirname(this_file);

  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Fallback: ask git (works if git is available and we're inside the repo)
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(this_file),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "Could not resolve LobsterFarm repo root. " +
        "Is the CLI running from within the repository?",
    );
  }
}

/** Run a git command in the repo directory, returning stdout. */
function git(repo_dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo_dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Reason a rebuild was decided to be necessary. */
export type RebuildReason =
  | { kind: "force" }
  | { kind: "pulled" }
  | { kind: "stale"; detail: string }
  | { kind: "fresh" };

/**
 * Decide whether to rebuild based on three independent signals.
 *
 * Pulled commits trump everything; --force is the next escape hatch;
 * staleness is the silent path that fixes the original bug. Order matters
 * only for the log message — the rebuild action is the same.
 */
export function decide_rebuild(opts: {
  pulled: boolean;
  force: boolean;
  staleness: StalenessResult;
}): RebuildReason {
  if (opts.pulled) return { kind: "pulled" };
  if (opts.force) return { kind: "force" };
  if (opts.staleness.stale) return { kind: "stale", detail: opts.staleness.reason };
  return { kind: "fresh" };
}

/** Human-readable log line describing why we're rebuilding (or not). */
export function describe_rebuild_decision(reason: RebuildReason): string {
  switch (reason.kind) {
    case "force":
      return "Rebuilding (forced via --force)...";
    case "pulled":
      return "Rebuilding (pulled new commits)...";
    case "stale":
      return `Rebuilding (dist stale: ${reason.detail})...`;
    case "fresh":
      return "Already up to date.";
  }
}

/** Read HEAD's commit time as unix epoch seconds. */
function get_head_commit_time(repo_dir: string): number {
  const raw = git(repo_dir, ["log", "-1", "--format=%ct", "HEAD"]);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse HEAD commit time from git output: ${raw}`);
  }
  return parsed;
}

/** Stamp the SHA we just built so future runs can compare against HEAD. */
function stamp_dist_sha(repo_dir: string, sha: string): void {
  writeFileSync(join(repo_dir, DIST_SHA_STAMP_REL), `${sha}\n`, "utf-8");
}

export const update_command = new Command("update")
  .description("Pull latest code and rebuild")
  .option(
    "--force",
    "Force rebuild even when source and compiled output appear in sync " +
      "(useful after a manual git operation that left dist/ out of sync)",
  )
  .action((options: { force?: boolean }) => {
    const force = options.force === true;

    let repo_dir: string;
    try {
      repo_dir = resolve_repo_root();
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to resolve repo root.");
      process.exit(1);
    }

    console.log("Checking for updates...");

    // Fetch latest from origin
    try {
      execFileSync("git", ["fetch", "origin"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
    } catch {
      console.error("Failed to fetch from origin. Check your network connection.");
      process.exit(1);
    }

    // Pull if behind. We must check before deciding rebuild, because the
    // pull itself advances HEAD and changes the staleness computation.
    const status = git(repo_dir, ["status", "-uno"]);
    const up_to_date = status.includes("Your branch is up to date");
    let pulled = false;

    if (!up_to_date) {
      console.log("Pulling latest from origin/main...");
      try {
        execFileSync("git", ["pull", "origin", "main"], {
          cwd: repo_dir,
          stdio: "inherit",
        });
        pulled = true;
      } catch {
        console.error(
          "Pull failed. You may have local changes that conflict.\n" +
            "Resolve conflicts manually, then re-run: lf update",
        );
        process.exit(1);
      }
    }

    // Now compute staleness against the (possibly newly-pulled) HEAD.
    let head_sha: string;
    let head_time_s: number;
    try {
      head_sha = git(repo_dir, ["rev-parse", "HEAD"]);
      head_time_s = get_head_commit_time(repo_dir);
    } catch (err) {
      console.error(
        `Failed to read HEAD state: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    const staleness = check_dist_staleness(repo_dir, head_sha, head_time_s);
    const reason = decide_rebuild({ pulled, force, staleness });

    if (reason.kind === "fresh") {
      console.log(describe_rebuild_decision(reason));
      return;
    }

    console.log(describe_rebuild_decision(reason));

    // Rebuild
    try {
      execFileSync("pnpm", ["install"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
      execFileSync("pnpm", ["build"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
    } catch {
      console.error(
        `Build failed. Check the output above for errors.\nYou can retry the build manually: cd ${repo_dir} && pnpm install && pnpm build`,
      );
      process.exit(1);
    }

    // Stamp the SHA so the next run can detect a clean state precisely
    // (instead of falling back to mtime). Best-effort — a stamp failure
    // doesn't fail the update; it just means the next run will use mtime.
    try {
      stamp_dist_sha(repo_dir, head_sha);
    } catch (err) {
      console.warn(
        `Built successfully, but failed to write dist SHA stamp: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Report success with the new commit hash
    const short = head_sha.slice(0, 7);
    console.log(`\nLobsterFarm updated to commit ${short}`);
    console.log("Restart the daemon to apply: lf restart");
  });
