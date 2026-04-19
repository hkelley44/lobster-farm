/**
 * Daemon environment validation and tmux propagation.
 *
 * Ensures the daemon's PATH contains all required tools and pushes
 * critical env vars into the tmux global environment so pool bots
 * inherit them even if the tmux server predates the daemon.
 */

import { execFileSync } from "node:child_process";

// Binaries required for daemon operation. Missing any of these is fatal.
const REQUIRED_BINARIES = ["node", "claude", "git", "gh", "tmux", "bun"] as const;

// Binaries that are useful but not strictly required. Missing triggers a warning.
const RECOMMENDED_BINARIES = ["op"] as const;

// Env vars that must be available in tmux sessions spawned by the pool.
//
// OP_SERVICE_ACCOUNT_TOKEN is intentionally NOT propagated globally. It is
// injected per-session by pool.ts with the entity-specific token (see
// resolve_entity_op_token in pool.ts). Propagating it here would leak the
// platform token into every entity session and break least-privilege.
export const TMUX_PROPAGATED_VARS = ["PATH", "HOME", "BUN_INSTALL"] as const;

// Env vars that must be actively REMOVED from the tmux global environment on
// daemon startup. `lf restart` hot-bounces the daemon (launchctl kickstart -k)
// but leaves the tmux server running, so vars propagated by a prior version
// linger in the global scope even after being dropped from the whitelist
// above. Listing a var here causes `propagate_tmux_env` to issue
// `tmux set-environment -g -r <var>` before the propagation loop runs.
//
// Maintenance: when a var is removed from TMUX_PROPAGATED_VARS, add it here
// for at least one release cycle to scrub existing tmux servers. A var may
// safely appear in both lists — the propagate step runs after and wins,
// which is the defensive intent.
export const TMUX_DEPROPAGATE_VARS = ["OP_SERVICE_ACCOUNT_TOKEN"] as const;

/**
 * Resolve a binary via `which`. Returns true if found, false otherwise.
 * Extracted for testability — tests can provide a mock resolver.
 */
type BinaryChecker = (name: string) => boolean;

function default_binary_checker(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary name to its absolute path via `which`.
 * Returns the absolute path if found, or the bare name as fallback
 * so callers still work (relying on PATH at exec time).
 *
 * Useful for launchd environments where PATH in the parent process
 * may not propagate correctly to child processes in all cases.
 */
export function resolve_binary(name: string): string {
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim();
  } catch {
    return name;
  }
}

/**
 * Set a tmux global environment variable. Returns true on success.
 * Extracted for testability.
 */
type TmuxSetter = (key: string, value: string) => boolean;

function default_tmux_setter(key: string, value: string): boolean {
  try {
    execFileSync("tmux", ["set-environment", "-g", key, value], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a tmux global environment variable. Returns true if the call
 * succeeded against a running tmux server (regardless of whether the var
 * was actually set — tmux exits non-zero on "unknown variable", which we
 * treat as a no-op success for idempotency).
 *
 * Returns false only when the tmux server itself is unreachable (not
 * running), matching the semantics of the setter.
 */
type TmuxRemover = (key: string) => boolean;

function default_tmux_remover(key: string): boolean {
  try {
    execFileSync("tmux", ["set-environment", "-g", "-r", key], { stdio: "ignore" });
    return true;
  } catch {
    // tmux returns non-zero both for "server not running" and "unknown
    // variable". We can't easily distinguish without parsing stderr, so
    // treat all failures as non-fatal — the caller logs at the batch level.
    return false;
  }
}

/**
 * Verify that all required binaries are reachable in the current PATH.
 * Exits the process with a clear error message if any are missing.
 * Logs a warning for missing recommended binaries.
 */
export function check_required_binaries(checker: BinaryChecker = default_binary_checker): void {
  const missing_required: string[] = [];
  const missing_recommended: string[] = [];

  for (const bin of REQUIRED_BINARIES) {
    if (!checker(bin)) {
      missing_required.push(bin);
    }
  }

  for (const bin of RECOMMENDED_BINARIES) {
    if (!checker(bin)) {
      missing_recommended.push(bin);
    }
  }

  if (missing_required.length > 0) {
    console.error(
      `[env] FATAL: Required binaries not found in PATH: ${missing_required.join(", ")}`,
    );
    console.error(`[env] Current PATH: ${process.env.PATH ?? "(unset)"}`);
    console.error("[env] Fix ~/.lobsterfarm/env.sh and restart.");
    process.exit(1);
  }

  if (missing_recommended.length > 0) {
    console.warn(
      `[env] Warning: Recommended binaries not found: ${missing_recommended.join(", ")}`,
    );
  }

  console.log(`[env] All required binaries found: ${REQUIRED_BINARIES.join(", ")}`);
  if (missing_recommended.length === 0) {
    console.log(`[env] Recommended binaries also present: ${RECOMMENDED_BINARIES.join(", ")}`);
  }
}

/**
 * Propagate critical environment variables to the tmux global environment.
 * This ensures new tmux sessions inherit the daemon's env even if the
 * tmux server predates the daemon (started from a different context).
 *
 * Before propagating, actively removes any vars listed in
 * TMUX_DEPROPAGATE_VARS — these are legacy vars that prior daemon versions
 * propagated but the current version no longer wants on the tmux server
 * (see comment on TMUX_DEPROPAGATE_VARS for rationale).
 *
 * Depropagate runs BEFORE propagate, so if a var appears in both lists
 * (defensive only; shouldn't happen) the propagate step wins.
 *
 * Failures are non-fatal — if tmux isn't running yet, it'll inherit
 * from the daemon's process env when first created.
 */
export function propagate_tmux_env(
  env: Record<string, string | undefined> = process.env,
  setter: TmuxSetter = default_tmux_setter,
  remover: TmuxRemover = default_tmux_remover,
): void {
  // Depropagate first: scrub legacy vars from the tmux global env. Variable
  // NAMES are logged (they are not secrets); values are never touched here.
  for (const key of TMUX_DEPROPAGATE_VARS) {
    remover(key);
  }
  if (TMUX_DEPROPAGATE_VARS.length > 0) {
    console.log(
      `[env] tmux global cleanup: depropagated ${TMUX_DEPROPAGATE_VARS.length} legacy var(s): ${TMUX_DEPROPAGATE_VARS.join(", ")}`,
    );
  }

  let any_succeeded = false;

  for (const key of TMUX_PROPAGATED_VARS) {
    const value = env[key];
    if (!value) continue;

    if (setter(key, value)) {
      any_succeeded = true;
    }
  }

  if (any_succeeded) {
    console.log("[env] Propagated environment to tmux server");
  } else {
    console.log("[env] tmux server not running, will inherit daemon env");
  }
}
