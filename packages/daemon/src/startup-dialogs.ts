/**
 * Answer the Claude CLI's startup dialogs by reading the pane, not by guessing
 * when they appear.
 *
 * A pool session can stop at up to two dialogs before it reaches the prompt:
 * the workspace-trust dialog, and — on the broker transport — the
 * `--dangerously-load-development-channels` confirmation (#114). Both block the
 * whole startup (MCP servers do not spawn until they are answered), so an
 * unanswered dialog is a dark channel.
 *
 * The daemon used to press Enter at fixed 3s and 6s delays. A slow boot left
 * the dialog open; a fast one sent a stray Enter into the prompt. This polls
 * the pane and presses Enter exactly once per dialog it actually sees.
 *
 * Fail-open: never throws, never kills the session. A dialog still open at the
 * timeout is reported through `on_stuck` and left for a human.
 */

import { execFileSync } from "node:child_process";
import {
  type BlockingPaneState,
  capture_tmux_pane_text,
  classify_blocking_pane,
  pane_tail,
} from "./plugin-liveness.js";

export type StartupDialog = Extract<BlockingPaneState, "trust_dialog" | "dev_channels_dialog">;

export interface StartupDialogOptions {
  /** Give up after this long. Default 45s. */
  timeout_ms?: number;
  /** Pane poll interval. Default 500ms. */
  poll_ms?: number;
  /** Whether the dev-channels confirmation is expected (broker sessions). When
   * false it is still answered if it appears — the flag only gates how long we
   * keep waiting for it after the prompt is up. */
  expect_dev_channels?: boolean;
  /** Called once if a dialog is still on screen at the timeout. */
  on_stuck?: (dialog: StartupDialog) => void;
}

export interface StartupDialogDeps {
  capture?: (tmux_session: string) => string | null;
  send_enter?: (tmux_session: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface StartupDialogResult {
  /** Dialogs answered, in order. */
  answered: StartupDialog[];
  /** Why the loop ended. */
  ended: "ready" | "timeout" | "session_gone";
  /** The dialog left on screen at the timeout, if any. */
  stuck: StartupDialog | null;
}

/** How many consecutive unreadable captures mean the session is gone. */
const MAX_CAPTURE_FAILURES = 6;

/** How long after pressing Enter the same dialog may stay on screen before we
 * press again. The CLI needs a moment to redraw; pressing on every poll would
 * leak the extra Enters into whatever comes next. */
const REPRESS_AFTER_MS = 3_000;

function default_send_enter(tmux_session: string): void {
  execFileSync("tmux", ["send-keys", "-t", tmux_session, "Enter"], {
    stdio: "ignore",
    timeout: 5000,
  });
}

function as_startup_dialog(pane: string): StartupDialog | null {
  const state = classify_blocking_pane(pane);
  return state === "trust_dialog" || state === "dev_channels_dialog" ? state : null;
}

/** The CLI is past its startup dialogs: the input prompt (or the status bar
 * that accompanies it) is on screen. */
function shows_prompt(pane: string): boolean {
  return pane_tail(pane).some((line) => line.includes("❯") || line.includes("bypass permissions"));
}

export async function answer_startup_dialogs(
  tmux_session: string,
  opts: StartupDialogOptions = {},
  deps: StartupDialogDeps = {},
): Promise<StartupDialogResult> {
  const timeout_ms = opts.timeout_ms ?? 45_000;
  const poll_ms = opts.poll_ms ?? 500;
  const capture = deps.capture ?? capture_tmux_pane_text;
  const send_enter = deps.send_enter ?? default_send_enter;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const answered: StartupDialog[] = [];
  const started = now();
  let capture_failures = 0;
  let last_dialog: StartupDialog | null = null;
  let last_pressed: { dialog: StartupDialog; at: number } | null = null;

  while (now() - started < timeout_ms) {
    await sleep(poll_ms);

    let pane: string | null;
    try {
      pane = capture(tmux_session);
    } catch {
      pane = null;
    }
    if (pane === null) {
      if (++capture_failures >= MAX_CAPTURE_FAILURES) {
        return { answered, ended: "session_gone", stuck: null };
      }
      continue;
    }
    capture_failures = 0;

    const dialog = as_startup_dialog(pane);
    last_dialog = dialog;

    if (dialog) {
      const same_as_pressed = last_pressed !== null && last_pressed.dialog === dialog;
      if (same_as_pressed && now() - (last_pressed?.at ?? 0) < REPRESS_AFTER_MS) {
        continue; // already answered this one; give the CLI time to redraw
      }
      try {
        send_enter(tmux_session);
      } catch {
        continue; // session may be mid-teardown; the next poll decides
      }
      if (!same_as_pressed) answered.push(dialog);
      last_pressed = { dialog, at: now() };
      continue;
    }

    if (shows_prompt(pane)) {
      // Prompt is up with no dialog on screen. A broker session that has not
      // shown its dev-channels confirmation yet may still do so — the trust
      // dialog comes first and the prompt can flash between them — so keep
      // watching until it has been answered or the timeout ends the wait.
      if (opts.expect_dev_channels && !answered.includes("dev_channels_dialog")) continue;
      return { answered, ended: "ready", stuck: null };
    }
  }

  if (last_dialog) {
    try {
      opts.on_stuck?.(last_dialog);
    } catch {
      /* reporting must not throw into the caller */
    }
  }
  // A broker session whose confirmation never appeared (already accepted, or
  // the CLI no longer shows it) ends here with nothing stuck — that is fine.
  return { answered, ended: "timeout", stuck: last_dialog };
}
