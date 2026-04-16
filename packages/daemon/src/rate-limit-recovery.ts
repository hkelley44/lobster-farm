/**
 * Auto-recovery for pool bots stuck on Claude Code's usage-limit modal.
 *
 * When a pool bot hits the rate limit, Claude Code shows a modal that freezes
 * the session waiting for user input (Enter to confirm, Esc to cancel). Since
 * pool bots are unattended, nobody presses a key. This module detects the modal
 * by scraping the tmux pane output and sends Escape to dismiss it.
 *
 * Detection patterns (spec: issue #270):
 *   - "Switch to extra usage" anywhere in the last 10 lines
 *   - "exceeded" + "Esc to cancel" both present in the last 10 lines
 *
 * Pool-only. Commander (Pat) and failsafe sessions are interactive and
 * handled by the user.
 */
import { execFileSync } from "node:child_process";
import type { PoolBot } from "./pool.js";

// ── Pure detection ──

/**
 * Check whether the given pane output contains the rate-limit modal.
 *
 * Examines the last 10 lines for two independent patterns (either triggers):
 * 1. "Switch to extra usage" (the modal's option text)
 * 2. "exceeded" AND "Esc to cancel" (the header + dismiss instruction)
 *
 * Pure function — no side effects, easy to test.
 */
export function detect_rate_limit_modal(pane_output: string): boolean {
  const lines = pane_output.split("\n");
  const tail = lines.slice(-10).join("\n").toLowerCase();

  // Pattern 1: modal option text
  if (tail.includes("switch to extra usage")) return true;

  // Pattern 2: exceeded + dismiss instruction
  if (tail.includes("exceeded") && tail.includes("esc to cancel")) return true;

  return false;
}

// ── Tmux interaction ──

/**
 * Capture the full content of a tmux pane.
 *
 * Uses `tmux capture-pane -p` which prints the visible pane content to stdout.
 * Returns null if the pane can't be read (session dead, timeout, etc.).
 */
export function capture_tmux_pane(tmux_session: string): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", tmux_session, "-p"], {
      encoding: "utf-8",
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

/**
 * Send Escape to a tmux session to dismiss the rate-limit modal.
 *
 * Uses the literal key name "Escape" which tmux interprets as the Esc keystroke.
 */
export function send_escape(tmux_session: string): void {
  execFileSync("tmux", ["send-keys", "-t", tmux_session, "Escape"], {
    stdio: "ignore",
    timeout: 2000,
  });
}

// ── Scan result ──

export interface RateLimitRecoveryResult {
  bot_id: number;
  tmux_session: string;
  entity_id: string | null;
}

// ── Scan and recover ──

/**
 * Scan all assigned pool bots for the rate-limit modal and dismiss it.
 *
 * Returns the list of bots that were recovered. Callers use this to
 * post alerts and log the events.
 *
 * @param bots - assigned pool bots to scan
 * @param capture_fn - tmux capture function (injectable for testing)
 * @param escape_fn - tmux escape function (injectable for testing)
 */
export function scan_and_recover(
  bots: readonly PoolBot[],
  capture_fn: (session: string) => string | null = capture_tmux_pane,
  escape_fn: (session: string) => void = send_escape,
): RateLimitRecoveryResult[] {
  const recovered: RateLimitRecoveryResult[] = [];

  for (const bot of bots) {
    if (bot.state !== "assigned") continue;

    const output = capture_fn(bot.tmux_session);
    if (!output) continue;

    if (detect_rate_limit_modal(output)) {
      try {
        escape_fn(bot.tmux_session);
        recovered.push({
          bot_id: bot.id,
          tmux_session: bot.tmux_session,
          entity_id: bot.entity_id,
        });
        console.log(
          `[rate-limit-recovery] Dismissed rate-limit modal for ${bot.tmux_session} ` +
            `(entity: ${bot.entity_id ?? "unknown"})`,
        );
      } catch (err) {
        console.warn(
          `[rate-limit-recovery] Failed to send Escape to ${bot.tmux_session}: ${String(err)}`,
        );
      }
    }
  }

  return recovered;
}
