/**
 * Shared MCP plugin-liveness probe logic (issues #73, #77).
 *
 * The inbound Discord→session delivery path is pure MCP plugin — no daemon
 * send-keys — so a session can be perfectly alive in tmux yet silently stop
 * receiving messages if the plugin's channel listener dies. tmux-liveness
 * checks slip right past this "deaf but alive" failure mode.
 *
 * Detection is purely observational — no synthetic echo messages that would
 * pollute the channel. It compares two timestamps the daemon already owns
 * against the session's current pane-idle state:
 *   - `last_inbound_at`: set when the daemon routed a human message to the
 *     session (pool: discord.ts steady-state `touch`; commander: the
 *     command-center routing path).
 *   - `last_processing_at` + the live pane-idle reading: whether the session
 *     is currently/recently *working*.
 *
 * A healthy session starts working within seconds of the plugin delivering the
 * message. A deaf session stays at the idle prompt forever.
 *
 * This module owns only the *decision*. Each caller (pool bot, commander) keeps
 * its own recovery + alert side-effects — the recovery paths differ
 * (restart_crashed_session vs. tmux kill + session resume) but the signal model
 * is identical, so the verdict logic lives here once and is unit-tested in
 * isolation. Issue #77 extends the original pool-only probe (#73) to the
 * commander by sharing this evaluator.
 */

import { execFileSync } from "node:child_process";

/**
 * Check whether a tmux session is idle (showing a prompt, not actively processing).
 * Reads the last line of the tmux pane and looks for prompt or permission dialog indicators.
 *
 * Checks three things (in order):
 * 1. "esc to interrupt" → actively generating → NOT idle
 * 2. "local agent" → background subagent running → NOT idle
 * 3. "❯" or "bypass permissions" → at prompt with no active work → idle
 *
 * Fails open (returns true) when the pane can't be read — safe default for eviction
 * and typing-loop termination.
 *
 * Lives here because the live pane-idle reading is the second observable the
 * plugin-liveness probe compares against `last_inbound_at`; both the pool and
 * commander probes consume it. Re-exported from pool.ts for existing importers.
 */
export function is_tmux_session_idle(tmux_session: string): boolean {
  try {
    const output = execFileSync("tmux", ["capture-pane", "-t", tmux_session, "-p"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    const lines = output.trim().split("\n");
    const last_line = lines[lines.length - 1] ?? "";

    // Claude Code's status bar shows "esc to interrupt" only during active generation.
    if (last_line.includes("esc to interrupt")) return false;

    // Background subagents: status bar shows "N local agent(s)" when subagents are running.
    // The parent is at the prompt but work is still happening — NOT idle.
    if (last_line.includes("local agent")) return false;

    // If no active indicators, check for idle indicators:
    // - "❯" prompt visible (waiting for input)
    // - "bypass permissions" in status bar without active-work indicators (idle at prompt)
    return last_line.includes("❯") || last_line.includes("bypass permissions");
  } catch {
    return true; // Can't check — assume idle (fail-open)
  }
}

/**
 * How long an inbound-but-unprocessed session may stay idle before the MCP
 * plugin is judged deaf.
 *
 * A healthy session transitions to "working" (pane shows "esc to interrupt" /
 * "← discord" / "local agent") within a few seconds of the plugin delivering
 * the message. If the pane is *still* at the idle prompt this long after the
 * inbound — and the session showed no processing in between — the plugin has
 * stopped delivering and the session is silently deaf.
 *
 * 90s comfortably clears: MCP delivery latency (several seconds), the typing
 * loop's 15s grace window, and a brief Claude startup/tool-permission pause —
 * while still catching a genuinely deaf session within ~2 health-check cycles.
 */
export const PLUGIN_DEAF_THRESHOLD_MS = 90_000;

/** Observable inputs the probe compares to reach a verdict. */
export interface LivenessSignal {
  /** When the daemon last routed an inbound human message here. Null when
   * nothing is in flight to be deaf to. */
  last_inbound_at: Date | null;
  /** When the session was last observed processing (pane non-idle). Null when
   * never observed working. */
  last_processing_at: Date | null;
  /** Live reading: is the session's tmux pane idle at the prompt right now? */
  is_idle: boolean;
}

/**
 * Probe verdict.
 *
 * - `no_inbound`     — nothing was delivered; nothing to probe.
 * - `healthy_working`— session is processing now → plugin delivered. Record
 *                      processing, clear the inbound marker.
 * - `healthy_processed` — session processed after the inbound then returned to
 *                      idle (awaiting the next reply). Clear the inbound marker.
 * - `grace`          — still idle, but within the delivery/startup grace window.
 *                      Do nothing; a later pass re-checks.
 * - `deaf`           — idle past the threshold with no processing since the
 *                      inbound → plugin stopped delivering. Recover.
 */
export type LivenessVerdict =
  | "no_inbound"
  | "healthy_working"
  | "healthy_processed"
  | "grace"
  | "deaf";

/**
 * Evaluate plugin liveness from observable signals. Pure: no I/O, no clock
 * access beyond the injected `now`, no mutation — the caller applies the
 * marker changes implied by the verdict (clear `last_inbound_at` on every
 * non-`grace`/`no_inbound` outcome; stamp `last_processing_at` on
 * `healthy_working`). Centralizing this keeps the pool and commander probes
 * provably identical.
 *
 * @param signal Observable inputs (inbound/processing timestamps + idle state).
 * @param now    Current epoch ms — injected for deterministic tests.
 * @param threshold_ms Grace window before idleness counts as deafness.
 */
export function evaluate_plugin_liveness(
  signal: LivenessSignal,
  now: number,
  threshold_ms: number = PLUGIN_DEAF_THRESHOLD_MS,
): LivenessVerdict {
  const inbound = signal.last_inbound_at;
  if (!inbound) return "no_inbound";

  // Actively working → the plugin delivered and the session picked it up.
  if (!signal.is_idle) return "healthy_working";

  // Processed at some point after the inbound, then returned to idle — message
  // was received and handled. Not deaf.
  if (signal.last_processing_at && signal.last_processing_at.getTime() >= inbound.getTime()) {
    return "healthy_processed";
  }

  // Still idle and no processing since the inbound. Give the plugin its
  // delivery + startup grace before judging.
  if (now - inbound.getTime() < threshold_ms) return "grace";

  // Idle past the grace window with no processing → deaf.
  return "deaf";
}
