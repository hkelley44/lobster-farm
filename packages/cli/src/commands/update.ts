import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

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

/** Run a git command in the repo directory, returning trimmed stdout. */
function git(repo_dir: string, args: string[]): string {
  return git_raw(repo_dir, args).trim();
}

/** Run a git command, returning stdout exactly as emitted (no trimming). */
function git_raw(repo_dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo_dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Exit codes for precondition failures. Distinct codes make it easier for
 * callers (shell scripts, CI) to react to specific failure modes.
 */
export const EXIT_BRANCH_NOT_MAIN = 1;
export const EXIT_TREE_DIRTY = 2;
export const EXIT_GIT_ERROR = 3;

export type PreconditionResult = { ok: true } | { ok: false; exit_code: number; message: string };

/**
 * Verify HEAD is on `main`.
 *
 * Uses `git symbolic-ref --short HEAD` — fails cleanly when HEAD is detached
 * (no symbolic ref), so we can report that as its own case rather than
 * letting a raw git error bubble up.
 */
export function check_on_main(repo_dir: string): PreconditionResult {
  let branch: string;
  try {
    branch = git(repo_dir, ["symbolic-ref", "--short", "HEAD"]);
  } catch (err) {
    // Most common cause: detached HEAD (no symbolic ref). Include git's
    // stderr so repo-level errors (not a git repo, etc.) are still visible.
    const stderr = extract_stderr(err);
    const detail = stderr ? ` (${stderr})` : "";
    return {
      ok: false,
      exit_code: EXIT_BRANCH_NOT_MAIN,
      message: `lf update must be run from main. You are on HEAD (detached)${detail}.\nSwitch to main: git checkout main && lf update`,
    };
  }

  if (branch !== "main") {
    return {
      ok: false,
      exit_code: EXIT_BRANCH_NOT_MAIN,
      message: `lf update must be run from main. You are on '${branch}'.\nSwitch to main: git checkout main && lf update`,
    };
  }

  return { ok: true };
}

/**
 * Verify the working tree has no uncommitted changes to tracked files.
 *
 * Untracked files (`??`) are ignored — worktrees, build artifacts, and other
 * local-only paths shouldn't block an update. Any other status code (modified,
 * added, deleted, renamed, copied, unmerged) blocks with the offending paths.
 */
export function check_working_tree_clean(repo_dir: string): PreconditionResult {
  let output: string;
  try {
    // Use raw (untrimmed) output — porcelain v1 starts each line with a
    // two-char status code, and the leading space of `_M path` must survive.
    output = git_raw(repo_dir, ["status", "--porcelain"]);
  } catch (err) {
    const stderr = extract_stderr(err);
    return {
      ok: false,
      exit_code: EXIT_GIT_ERROR,
      message: `Failed to check working tree status.${stderr ? ` ${stderr}` : ""}`,
    };
  }

  const dirty_paths = parse_dirty_paths(output);
  if (dirty_paths.length === 0) return { ok: true };

  const preview = dirty_paths.slice(0, 5).join(", ");
  const suffix = dirty_paths.length > 5 ? ` (+${dirty_paths.length - 5} more)` : "";
  return {
    ok: false,
    exit_code: EXIT_TREE_DIRTY,
    message: `lf update requires a clean working tree. You have uncommitted changes: ${preview}${suffix}.\nCommit or stash first, then re-run: lf update`,
  };
}

/**
 * Parse `git status --porcelain` output, returning paths that have
 * tracked-file changes. Untracked entries (status `??`) are excluded.
 *
 * Porcelain v1 format: `XY <path>` where X/Y are status codes. A line with
 * `??` is untracked; anything else counts as a change to a tracked file.
 */
function parse_dirty_paths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    if (status === "??") continue;
    // Rename/copy entries look like `R  old -> new`; keep the full payload so
    // the user sees exactly what git sees.
    paths.push(line.slice(3).trim());
  }
  return paths;
}

/** Pull stderr off a child_process error, trimming trailing newlines. */
function extract_stderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    if (stderr) return stderr.toString().trim();
  }
  return "";
}

export const update_command = new Command("update")
  .description("Pull latest code and rebuild")
  .action(() => {
    let repo_dir: string;
    try {
      repo_dir = resolve_repo_root();
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to resolve repo root.");
      process.exit(1);
    }

    // Preconditions: must be on main with a clean tree. Branch check runs
    // first — if both fail, the branch error is the actionable one.
    for (const check of [check_on_main, check_working_tree_clean]) {
      const result = check(repo_dir);
      if (!result.ok) {
        console.error(result.message);
        process.exit(result.exit_code);
      }
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

    // Check if the local main branch is behind origin/main
    const status = git(repo_dir, ["status", "-uno"]);
    if (status.includes("Your branch is up to date")) {
      console.log("Already up to date.");
      return;
    }

    // Pull from origin/main
    console.log("Pulling latest from origin/main...");
    try {
      execFileSync("git", ["pull", "origin", "main"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
    } catch {
      console.error(
        "Pull failed. You may have local changes that conflict.\n" +
          "Resolve conflicts manually, then re-run: lf update",
      );
      process.exit(1);
    }

    // Rebuild
    console.log("Rebuilding...");
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

    // Report success with the new commit hash
    const hash = git(repo_dir, ["rev-parse", "--short", "HEAD"]);
    console.log(`\nLobsterFarm updated to commit ${hash}`);
    console.log("Restart the daemon to apply: lf restart");
  });
