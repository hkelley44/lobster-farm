/**
 * Dead-letter handling for the Discord broker (#107) — alert + session heal.
 *
 * A dead-letter means the shim never acked an inbound across the full
 * redelivery horizon (30s × 5 ≈ 2.5 min): the owning session's delivery path
 * is broken, and every subsequent message would dead-letter too. Phase 1
 * stopped at alerting; this module adds the heal — release the owning bot to
 * dark so the NEXT inbound cold-recreates the session with a fresh shim.
 *
 * Ordering is load-bearing: the alert body (including the quoted message) is
 * composed BEFORE the heal runs, because the queue entry is the only copy of
 * the dropped content. The dead-lettered message is deliberately NOT
 * re-enqueued — if the message itself is poison, re-feeding it defeats the
 * loop-breaker dead-lettering exists to be. The human retries from the quote.
 *
 * Heal-loop guard: BotPool.heal_dead_letter enforces a per-channel cool-down
 * (default 10 min); a repeat dead-letter inside the window escalates at
 * failure severity (incident_open) with no further automatic action.
 *
 * Extracted from the index.ts wiring closure so the alert/heal composition is
 * unit-testable without booting the daemon.
 */

import type { AlertPayload } from "../alert-router.js";
import type { QueueEntry } from "./queue.js";

/** The subset of BotPool.heal_dead_letter's result this module consumes. */
export type DeadLetterHealResult =
  | { outcome: "healed"; bot_id: number; session_id: string | null }
  | { outcome: "cooldown"; last_heal_ms: number }
  | { outcome: "no_session" };

export interface DeadLetterDeps {
  /** BotPool.heal_dead_letter — releases the owning bot to dark (cool-down guarded). */
  heal: (channel_id: string) => Promise<DeadLetterHealResult>;
  /** AlertRouter.post_alert (or a stand-in). Must not throw into the caller. */
  post_alert: (payload: AlertPayload) => Promise<unknown>;
  /** Entity whose #alerts channel receives the alert. */
  entity_id?: string;
}

/**
 * Handle one dead-lettered broker inbound: capture the alert content, run the
 * session heal, then post ONE alert describing both the drop and the heal
 * outcome. Never throws — failures are logged by the caller's catch.
 */
export async function handle_dead_letter(entry: QueueEntry, deps: DeadLetterDeps): Promise<void> {
  // Capture the quoted content FIRST — the entry is the only copy of the
  // message, and everything after this line is allowed to mutate pool state.
  const base_body =
    `A broker inbound for channel \`${entry.channel_id}\` (pool-${String(entry.bot_id)}) ` +
    `exhausted redelivery after ${String(entry.deliveries)} attempt(s) and was dropped.\n\n` +
    `> ${entry.content.slice(0, 500)}`;

  const heal = await deps.heal(entry.channel_id);
  const entity_id = deps.entity_id ?? "lobster-farm";

  switch (heal.outcome) {
    case "healed":
      await deps.post_alert({
        entity_id,
        tier: "action_required",
        title: "Discord broker dead-lettered a message — session auto-healed",
        body: `${base_body}\n\n**Auto-heal:** the owning session (pool-${String(heal.bot_id)}${heal.session_id ? `, session ${heal.session_id.slice(0, 8)}` : ""}) stopped acking and was recycled — released to dark; the next message in the channel recreates it with a fresh shim (continuity preserved). The dead-lettered message itself was NOT re-enqueued — retry it from the quote above.`,
      });
      return;
    case "cooldown":
      // Repeat dead-letter inside the heal cool-down: the heal is not fixing
      // the delivery path. Escalate at failure severity, take no action.
      await deps.post_alert({
        entity_id,
        tier: "incident_open",
        title: "Discord broker dead-letter REPEATED within heal cool-down",
        body: `${base_body}\n\n**Heal suppressed:** this channel already dead-lettered and was auto-healed within the cool-down window (last heal ${new Date(heal.last_heal_ms).toISOString()}). Re-healing would loop, so no automatic action was taken — the channel is left dark. The broker delivery path for this channel needs manual investigation.`,
      });
      return;
    case "no_session":
      await deps.post_alert({
        entity_id,
        tier: "action_required",
        title: "Discord broker dead-lettered a message",
        body: `${base_body}\n\nNo live session was assigned to the channel (already dark) — nothing to heal; the next message cold-recreates the session. Retry the dropped message from the quote above.`,
      });
      return;
  }
}
