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
 * the pane and confirms exactly once per dialog it actually sees.
 *
 * It also reads WHICH option the cursor is on before confirming (#144). CLI
 * 2.1.325 started rendering the trust dialog with "No, exit" preselected, so a
 * bare Enter told the CLI to quit: every session the daemon spawned in an
 * untrusted directory exited within seconds and the commander crash-looped.
 * Enter is now only ever sent while the cursor is observed on the accept
 * option; otherwise one arrow key is sent and the next poll re-reads the pane.
 *
 * Fail-open: never throws, never kills the session. A dialog still open at the
 * timeout is reported through `on_stuck` and left for a human.
 */

import { execFileSync } from "node:child_process";
import {
  type BlockingPaneState,
  DEV_CHANNELS_DIALOG_MARKERS,
  TRUST_DIALOG_MARKERS,
  capture_tmux_pane_text,
  classify_blocking_pane,
  pane_shows_input_prompt,
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
  /** Called once if the timeout passes with no dialog recognised AND no prompt
   * ever seen. That is what a reworded dialog looks like from here: the old
   * blind keypress would have got past it, this cannot. */
  on_no_prompt?: () => void;
}

export interface StartupDialogDeps {
  capture?: (tmux_session: string) => string | null;
  /** Send one named tmux key ("Enter", "Up", "Down") to the session. */
  send_key?: (tmux_session: string, key: StartupDialogKey) => void;
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

export type StartupDialogKey = "Enter" | "Up" | "Down";

function default_send_key(tmux_session: string, key: StartupDialogKey): void {
  execFileSync("tmux", ["send-keys", "-t", tmux_session, key], {
    stdio: "ignore",
    timeout: 5000,
  });
}

/** The option that lets startup continue, per dialog. Index 1 of each marker
 * pair is that option's label (index 0 is the dialog's title line). */
const ACCEPT_OPTION: Record<StartupDialog, string> = {
  trust_dialog: TRUST_DIALOG_MARKERS[1],
  dev_channels_dialog: DEV_CHANNELS_DIALOG_MARKERS[1],
};

/** Every dialog option the CLI is known to render, accept or decline. The
 * cursor is only trusted when it sits on one of these — a `❯` anywhere else in
 * the tail (scrollback, a quoted prompt) is not the selection cursor. */
const DECLINE_OPTIONS: Record<StartupDialog, readonly string[]> = {
  trust_dialog: ["No, exit"],
  dev_channels_dialog: ["Exit"],
};

/**
 * The single key that moves a startup dialog one step closer to accepted, or
 * null when the pane does not show enough to decide.
 *
 * "Enter" only when the selection cursor (❯) is on the accept option. When it
 * is on a decline option, the arrow key that moves it toward the accept option.
 * Null when the accept option or the cursor cannot be located: pressing a key
 * we cannot justify is how #144 happened, so the caller presses nothing and
 * the dialog surfaces through `on_stuck` instead.
 *
 * Which option is preselected, and the order they are listed in, are CLI UI
 * details that have already changed once — neither is assumed here.
 *
 * Pure: no I/O.
 */
export function next_key_for_dialog(dialog: StartupDialog, pane: string): StartupDialogKey | null {
  const lines = pane_tail(pane, 14);
  const accept = ACCEPT_OPTION[dialog];
  const accept_index = lines.findIndex((line) => line.includes(accept));
  if (accept_index === -1) return null;
  if (lines[accept_index]?.includes("❯")) return "Enter";

  const cursor_index = lines.findIndex(
    (line) => line.includes("❯") && DECLINE_OPTIONS[dialog].some((opt) => line.includes(opt)),
  );
  if (cursor_index === -1) return null;
  return cursor_index < accept_index ? "Down" : "Up";
}

function as_startup_dialog(pane: string): StartupDialog | null {
  const state = classify_blocking_pane(pane);
  return state === "trust_dialog" || state === "dev_channels_dialog" ? state : null;
}

/** The CLI is past its startup dialogs: the input prompt (or the status bar
 * that accompanies it) is on screen. */
function shows_prompt(pane: string): boolean {
  return (
    pane_shows_input_prompt(pane) ||
    pane_tail(pane).some((line) => line.includes("bypass permissions"))
  );
}

export async function answer_startup_dialogs(
  tmux_session: string,
  opts: StartupDialogOptions = {},
  deps: StartupDialogDeps = {},
): Promise<StartupDialogResult> {
  const timeout_ms = opts.timeout_ms ?? 45_000;
  const poll_ms = opts.poll_ms ?? 500;
  const capture = deps.capture ?? capture_tmux_pane_text;
  const send_key = deps.send_key ?? default_send_key;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const answered: StartupDialog[] = [];
  const started = now();
  let capture_failures = 0;
  let last_dialog: StartupDialog | null = null;
  let last_pressed: { dialog: StartupDialog; at: number } | null = null;
  let prompt_seen = false;

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
      const key = next_key_for_dialog(dialog, pane);
      if (key === null) continue; // cannot tell where the cursor is — do not guess
      try {
        send_key(tmux_session, key);
      } catch {
        continue; // session may be mid-teardown; the next poll decides
      }
      // An arrow key only moves the cursor. The next poll re-reads the pane and
      // confirms only if the cursor really landed on the accept option, so a
      // dropped or doubled keypress corrects itself instead of confirming the
      // wrong choice.
      if (key !== "Enter") continue;
      if (!same_as_pressed) answered.push(dialog);
      last_pressed = { dialog, at: now() };
      continue;
    }

    if (shows_prompt(pane)) {
      prompt_seen = true;
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
  if (!last_dialog && !prompt_seen) {
    try {
      opts.on_no_prompt?.();
    } catch {
      /* reporting must not throw into the caller */
    }
  }
  // A broker session whose confirmation never appeared (already accepted, or
  // the CLI no longer shows it) ends here with the prompt seen and nothing
  // stuck — that is fine.
  return { answered, ended: "timeout", stuck: last_dialog };
}
