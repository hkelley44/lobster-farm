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

/** How many trailing non-empty pane lines the idle/blocking readers scan. */
export const PANE_TAIL_LINES = 8;

/** The last `count` non-empty lines of a pane capture, in order. */
export function pane_tail(pane_text: string, count: number = PANE_TAIL_LINES): string[] {
  return pane_text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

/**
 * Does this pane capture show an explicit "working" marker?
 *
 * Scans the last PANE_TAIL_LINES non-empty lines rather than only the final
 * one. The final line of a Claude Code pane is whatever the CLI happens to
 * render last — a status-bar hint, a notice, an MCP footer — and the working
 * markers routinely sit one or two rows above it. Reading only the last line
 * therefore mis-read real work as idle, and the deaf probe turns a single such
 * mis-read into a recycled session.
 *
 * Markers:
 * 1. "esc to interrupt" → actively generating
 * 2. "local agent"      → background subagent(s) running
 *
 * Pure: no I/O.
 */
export function pane_shows_working(pane_text: string): boolean {
  return pane_tail(pane_text).some(
    (line) => line.includes("esc to interrupt") || line.includes("local agent"),
  );
}

/**
 * A pane state in which the session is alive and its plugin may be perfectly
 * healthy, but nothing can happen until a human (or a targeted remedy) acts.
 * Recycling such a session cures nothing — the replacement walks into the same
 * wall — and throws away the context that explains why it stopped.
 */
export type BlockingPaneState =
  | "permission_prompt"
  | "rate_limit_modal"
  | "trust_dialog"
  | "dev_channels_dialog"
  | "login_required";

/*
 * Dialog strings, taken from the Claude Code CLI bundle (v2.1.325). They are
 * UI copy, not an API: when the CLI rewords a dialog the matching state simply
 * stops being recognised and the callers fall back to their pre-existing
 * behaviour. Keep them as narrow as the copy allows — a false match here
 * suppresses a recycle that may have been warranted.
 */
/** Workspace-trust dialog: its title line and its accept option. */
export const TRUST_DIALOG_MARKERS = ["Quick safety check", "Yes, I trust this folder"] as const;
/** `--dangerously-load-development-channels` confirmation (#114). */
export const DEV_CHANNELS_DIALOG_MARKERS = [
  "WARNING: Loading development channels",
  "I am using this for local development",
] as const;
/** Tool/network permission prompts. */
export const PERMISSION_PROMPT_MARKERS = [
  "Do you want to proceed?",
  "Do you want to allow this connection?",
] as const;
/** Expired/absent auth. The first is what `is_pane_stale_oauth` matches. */
export const LOGIN_REQUIRED_MARKERS = [
  "Not logged in · Please run /login",
  "Not logged in · Run /login",
  "Authentication required · Sign in again",
] as const;

/**
 * Classify a pane capture as one of the known blocking states, or null.
 *
 * Dialogs are matched against the tail of the pane (a dialog owns the bottom of
 * the screen while it is open; the same words further up are scrollback — e.g.
 * an agent quoting a prompt it saw). Login failure is matched against the whole
 * pane, mirroring `is_pane_stale_oauth`: the CLI prints it as a turn result and
 * then returns to an ordinary-looking prompt beneath it.
 *
 * Rate-limit detection mirrors `detect_rate_limit_modal` (rate-limit-recovery.ts)
 * rather than importing it, so this module stays free of pool imports.
 *
 * Pure: no I/O.
 */
export function classify_blocking_pane(pane_text: string): BlockingPaneState | null {
  const tail = pane_tail(pane_text, 14).join("\n");
  const has = (markers: readonly string[]) => markers.some((m) => tail.includes(m));

  if (has(DEV_CHANNELS_DIALOG_MARKERS)) return "dev_channels_dialog";
  if (has(TRUST_DIALOG_MARKERS)) return "trust_dialog";

  const lower = tail.toLowerCase();
  if (
    lower.includes("switch to extra usage") ||
    (lower.includes("exceeded") && lower.includes("esc to cancel"))
  ) {
    return "rate_limit_modal";
  }

  // The question alone is ordinary English an agent might end a turn with;
  // a real prompt also renders its numbered options beneath it.
  if (has(PERMISSION_PROMPT_MARKERS) && /^\s*(?:❯\s*)?1\.\s/m.test(tail)) {
    return "permission_prompt";
  }
  if (LOGIN_REQUIRED_MARKERS.some((m) => pane_text.includes(m))) return "login_required";
  return null;
}

/** Operator-facing description of a blocking state, for #alerts. */
export function describe_blocking_state(state: BlockingPaneState): string {
  switch (state) {
    case "permission_prompt":
      return "waiting on a permission prompt";
    case "rate_limit_modal":
      return "stopped at the usage-limit modal";
    case "trust_dialog":
      return "stopped at the workspace-trust dialog";
    case "dev_channels_dialog":
      return "stopped at the development-channels confirmation";
    case "login_required":
      return "not logged in (the CLI's auth has expired)";
  }
}

/**
 * Can text typed into this pane right now be expected to start a turn?
 *
 * True when the input prompt (❯) is visible in the pane tail, nothing is
 * running, and no dialog owns the keyboard. The dialog checks matter because
 * selection menus render their cursor as ❯ too — "is ❯ on screen" alone would
 * type a queued message into a trust dialog.
 *
 * Pure: no I/O.
 */
export function pane_ready_for_input(pane_text: string): boolean {
  if (pane_shows_working(pane_text)) return false;
  if (classify_blocking_pane(pane_text) !== null) return false;
  return pane_shows_input_prompt(pane_text);
}

/**
 * Is the CLI's text-input prompt (❯) in the pane tail?
 *
 * A ❯ followed by a numbered option ("❯ 1. Yes") is a selection menu's cursor,
 * not the input prompt. Excluding it here means a dialog this module does not
 * recognise by its wording — a reworded one, or a new one — is still not
 * mistaken for a prompt that text can be typed into.
 *
 * Pure: no I/O.
 */
export function pane_shows_input_prompt(pane_text: string): boolean {
  return pane_tail(pane_text).some((line) => line.includes("❯") && !/❯\s*\d+\./.test(line));
}

/**
 * Check whether a tmux session is idle (showing a prompt, not actively processing).
 * Captures the pane and looks for explicit working indicators in its last
 * PANE_TAIL_LINES non-empty lines (see `pane_shows_working`).
 *
 * Classification:
 * 1. A working marker ("esc to interrupt" / "local agent") in the tail → NOT idle.
 * 2. Anything else → idle. This covers the explicit prompt indicators ("❯",
 *    "bypass permissions" in the status bar) AND every unrecognized state:
 *    startup banners, MCP-init lines, dialogs, partial redraws. "Not idle" is
 *    reserved for explicitly-recognized working markers only — Claude Code's
 *    status bar shows "esc to interrupt" for the whole duration of a turn, so
 *    real work is never missing its marker, while transient boot text carries
 *    no marker at all. Treating unknown text as "working" was how a freshly
 *    spawned session's banner could read as `healthy_working` and falsely
 *    clear the deaf-probe's armed inbound marker (#106 review blocker).
 *
 * "Idle" is therefore NOT "ready for a message": a session parked on a
 * permission prompt reads idle. Callers that are about to act destructively on
 * an idle reading must consult `classify_blocking_pane` first.
 *
 * Fails open (returns true) when the pane can't be read — symmetric with the
 * unknown-text rule, and the safe default for eviction and typing-loop
 * termination.
 *
 * Lives here because the live pane-idle reading is the second observable the
 * plugin-liveness probe compares against `last_inbound_at`; both the pool and
 * commander probes consume it. Re-exported from pool.ts for existing importers.
 */
export function is_tmux_session_idle(tmux_session: string): boolean {
  const pane = capture_tmux_pane_text(tmux_session);
  if (pane === null) return true; // Can't check — assume idle (fail-open)
  return !pane_shows_working(pane);
}

/**
 * Visible content of a tmux pane, or null when it can't be read (dead session,
 * timeout). Null is "indeterminate" — never treat it as an empty pane.
 */
export function capture_tmux_pane_text(tmux_session: string): string | null {
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

/**
 * How long after a session (re)spawn before ANY liveness reading is trusted
 * (#106 review). During boot the pane cycles through banners and init lines
 * that no heuristic can classify reliably, and a single mis-read in the
 * "working" direction is destructive: it stamps `last_processing_at` and
 * clears the armed `last_inbound_at`, silencing both the steady-state probe
 * and the post-restart heal for a genuinely-deaf session. So probes take no
 * reading — neither healthy nor deaf — until the session is this old.
 *
 * Equal to PLUGIN_DEAF_THRESHOLD_MS deliberately: no verdict can be *needed*
 * earlier (the grace window already spans 0–90s after an inbound), so gating
 * reads for the same span costs nothing while guaranteeing boot noise is
 * never read at all. Healthy pool sessions are still cleared promptly after
 * warm-up via the Stop-hook `mark_processed` stamp (`healthy_processed`),
 * which is immune to pane noise.
 *
 * That last mitigation is pool-only: the commander has no `mark_processed`
 * (`commander-process.ts` writes `last_processing_at` solely from its own
 * verdict switch), so its probe depends entirely on post-warm-up pane reads.
 * The "provably identical decisions" the three call sites share is a property
 * of `evaluate_plugin_liveness` below — the surrounding mitigations are not
 * symmetric, and the commander's are thinner.
 */
export const LIVENESS_WARMUP_MS = 90_000;

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
