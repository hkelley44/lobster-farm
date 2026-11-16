import { type Mock, describe, expect, it, vi } from "vitest";

// is_tmux_session_idle shells out to `tmux capture-pane` — mock the exec so the
// pane-text heuristic can be driven with realistic content, no tmux required.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "node:child_process";
import {
  PLUGIN_DEAF_THRESHOLD_MS,
  classify_blocking_pane,
  evaluate_plugin_liveness,
  is_tmux_session_idle,
  pane_ready_for_input,
  pane_shows_working,
} from "../plugin-liveness.js";

function set_pane_content(content: string): void {
  (execFileSync as Mock).mockReturnValue(content);
}

/**
 * Unit tests for the shared probe decision logic (issues #73, #77). Pool and
 * commander probes both delegate their verdict here, so the branch coverage
 * lives in one place.
 */
describe("evaluate_plugin_liveness", () => {
  const now = 1_000_000_000_000;

  it("returns no_inbound when nothing was delivered", () => {
    expect(
      evaluate_plugin_liveness(
        { last_inbound_at: null, last_processing_at: null, is_idle: true },
        now,
      ),
    ).toBe("no_inbound");
  });

  it("returns healthy_working when the pane is non-idle", () => {
    expect(
      evaluate_plugin_liveness(
        {
          last_inbound_at: new Date(now - PLUGIN_DEAF_THRESHOLD_MS - 10_000),
          last_processing_at: null,
          is_idle: false,
        },
        now,
      ),
    ).toBe("healthy_working");
  });

  it("returns healthy_processed when processing was observed at/after the inbound", () => {
    const inbound = new Date(now - PLUGIN_DEAF_THRESHOLD_MS - 10_000);
    expect(
      evaluate_plugin_liveness(
        {
          last_inbound_at: inbound,
          last_processing_at: new Date(inbound.getTime() + 1_000),
          is_idle: true,
        },
        now,
      ),
    ).toBe("healthy_processed");
  });

  it("returns grace while still within the threshold window", () => {
    expect(
      evaluate_plugin_liveness(
        {
          last_inbound_at: new Date(now - 5_000),
          last_processing_at: null,
          is_idle: true,
        },
        now,
      ),
    ).toBe("grace");
  });

  it("returns deaf when idle past the threshold with no processing since inbound", () => {
    expect(
      evaluate_plugin_liveness(
        {
          last_inbound_at: new Date(now - PLUGIN_DEAF_THRESHOLD_MS - 1),
          last_processing_at: null,
          is_idle: true,
        },
        now,
      ),
    ).toBe("deaf");
  });

  it("treats stale processing (before the inbound) as not-yet-handled (deaf-eligible)", () => {
    const inbound = new Date(now - PLUGIN_DEAF_THRESHOLD_MS - 5_000);
    expect(
      evaluate_plugin_liveness(
        {
          last_inbound_at: inbound,
          // Processed BEFORE this inbound — does not count as handling it.
          last_processing_at: new Date(inbound.getTime() - 1_000),
          is_idle: true,
        },
        now,
      ),
    ).toBe("deaf");
  });

  it("honors a custom threshold", () => {
    const signal = {
      last_inbound_at: new Date(now - 10_000),
      last_processing_at: null,
      is_idle: true,
    };
    expect(evaluate_plugin_liveness(signal, now, 5_000)).toBe("deaf");
    expect(evaluate_plugin_liveness(signal, now, 30_000)).toBe("grace");
  });
});

/**
 * Pane-text heuristic coverage (#106 review). The blocker that motivated
 * these: startup-transient pane content used to read as "not idle", which
 * `evaluate_plugin_liveness` short-circuits into `healthy_working` — falsely
 * clearing a spawn-armed inbound marker and silencing both deaf detectors.
 * "Not idle" must be reserved for explicitly-recognized working markers.
 */
describe("is_tmux_session_idle pane-text heuristic", () => {
  const claude_startup_banner = [
    "╭──────────────────────────────────────────────────╮",
    "│ ✻ Welcome to Claude Code!                        │",
    "│                                                  │",
    "│   /help for help, /status for your current setup │",
    "│                                                  │",
    "│   cwd: /Users/tidus/.lobsterfarm/entities/e1     │",
    "╰──────────────────────────────────────────────────╯",
    "",
    " ※ Tip: Loading MCP servers…",
  ].join("\n");

  it("classifies a realistic Claude Code startup banner as IDLE, not working (the #106 blocker)", () => {
    set_pane_content(claude_startup_banner);
    expect(is_tmux_session_idle("pool-3")).toBe(true);
  });

  it("startup banner content can never produce a false healthy_working verdict", () => {
    set_pane_content(claude_startup_banner);
    const verdict = evaluate_plugin_liveness(
      {
        // Armed at spawn (resume nudge / recycle recovery message), probed
        // seconds later while the pane still shows boot output.
        last_inbound_at: new Date(Date.now() - 5_000),
        last_processing_at: null,
        is_idle: is_tmux_session_idle("pool-3"),
      },
      Date.now(),
    );
    expect(verdict).not.toBe("healthy_working");
    expect(verdict).toBe("grace"); // marker preserved for a later, settled read
  });

  it("classifies unrecognized transient text as IDLE (working requires explicit markers)", () => {
    for (const last_line of [
      "Initializing…",
      "MCP server discord: connecting",
      "Do you trust the files in this folder?",
      "", // blank pane
    ]) {
      set_pane_content(`some earlier output\n${last_line}`);
      expect(is_tmux_session_idle("pool-3"), `last line: ${JSON.stringify(last_line)}`).toBe(true);
    }
  });

  it("classifies active generation as NOT idle (esc-to-interrupt status bar)", () => {
    set_pane_content("thinking…\n✻ Churning… (esc to interrupt · 12s)");
    expect(is_tmux_session_idle("pool-3")).toBe(false);
  });

  it("classifies running background subagents as NOT idle", () => {
    set_pane_content("❯\n2 local agents running");
    expect(is_tmux_session_idle("pool-3")).toBe(false);
  });

  it("classifies the settled prompt as idle", () => {
    set_pane_content("some reply text\n❯ ");
    expect(is_tmux_session_idle("pool-3")).toBe(true);
    set_pane_content("some reply text\n  bypass permissions on (shift+tab to cycle)");
    expect(is_tmux_session_idle("pool-3")).toBe(true);
  });

  it("fails open to idle when the pane can't be read", () => {
    (execFileSync as Mock).mockImplementation(() => {
      throw new Error("no such session");
    });
    expect(is_tmux_session_idle("pool-gone")).toBe(true);
  });
});

/**
 * The last line of a Claude Code pane is whatever the CLI renders last — a
 * hint, a notice, an MCP footer. The working markers routinely sit above it,
 * and a last-line-only read turned real work into an "idle" reading that the
 * deaf probe then acted on.
 */
describe("idle reading scans the pane tail, not only the last line", () => {
  const working_pane = [
    "● Running the migration now.",
    "",
    "✻ Thinking… (42s · ↓ 1.2k tokens · esc to interrupt)",
    "",
    "╭──────────────────────────────────────────────╮",
    "│ ❯                                            │",
    "╰──────────────────────────────────────────────╯",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  it("finds 'esc to interrupt' several lines above the status bar", () => {
    expect(pane_shows_working(working_pane)).toBe(true);
    set_pane_content(working_pane);
    expect(is_tmux_session_idle("pool-3")).toBe(false);
  });

  it("finds a background-agent marker above the last line", () => {
    const pane = ["❯ ", "  2 local agents running", "  ⏵⏵ bypass permissions on"].join("\n");
    expect(pane_shows_working(pane)).toBe(true);
  });

  it("ignores blank padding below the status area", () => {
    expect(pane_shows_working(`${working_pane}\n\n\n\n\n\n\n\n\n\n`)).toBe(true);
  });

  it("does not treat a marker far up in scrollback as current work", () => {
    const pane = [
      "press esc to interrupt a running turn", // old output, long scrolled past
      ...Array.from({ length: 12 }, (_, i) => `line ${String(i)}`),
      "❯ ",
    ].join("\n");
    expect(pane_shows_working(pane)).toBe(false);
  });
});

describe("classify_blocking_pane", () => {
  // Dialog copy as rendered by Claude Code v2.1.325.
  const trust_dialog = [
    " Accessing workspace:",
    " /Users/farm/.lobsterfarm/entities/acme",
    "",
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
    " well-known open source project, or work from your team). If not, take a moment to review what's",
    " in this folder first.",
    "",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  const dev_channels_dialog = [
    " WARNING: Loading development channels",
    "",
    " --dangerously-load-development-channels is for local channel development only.",
    " Channels: server:lf-discord",
    "",
    " ❯ 1. I am using this for local development",
    "   2. Exit",
  ].join("\n");

  const permission_prompt = [
    "● Bash(rm -rf build)",
    "",
    " Bash command",
    "   rm -rf build",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for rm commands in this project",
    "   3. No, and tell Claude what to do differently (esc)",
  ].join("\n");

  const rate_limit_modal = [
    " You've exceeded your usage limit.",
    " ❯ 1. Switch to extra usage",
    "   2. Wait for the limit to reset",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  const login_required = [
    "> hello",
    "  ⎿  Not logged in · Please run /login",
    "",
    "╭───────────────╮",
    "│ ❯             │",
    "╰───────────────╯",
  ].join("\n");

  it.each([
    ["trust_dialog", trust_dialog],
    ["dev_channels_dialog", dev_channels_dialog],
    ["permission_prompt", permission_prompt],
    ["rate_limit_modal", rate_limit_modal],
    ["login_required", login_required],
  ] as const)("recognises %s", (state, pane) => {
    expect(classify_blocking_pane(pane)).toBe(state);
  });

  it("returns null for an ordinary idle prompt", () => {
    const idle = ["● Done.", "", "│ ❯ │", "  ⏵⏵ bypass permissions on"].join("\n");
    expect(classify_blocking_pane(idle)).toBeNull();
  });

  it("does not mistake an agent ending its turn with the same question for a prompt", () => {
    const pane = [
      "● I can drop the old table and re-run the migration.",
      "  Do you want to proceed?",
      "",
      "│ ❯ │",
      "  ⏵⏵ bypass permissions on",
    ].join("\n");
    expect(classify_blocking_pane(pane)).toBeNull();
    expect(pane_ready_for_input(pane)).toBe(true);
  });

  it("ignores a stale 'Not logged in' line far up in scrollback (the remedy restarts the session)", () => {
    const pane = [
      "  ⎿  Not logged in · Please run /login",
      ...Array.from({ length: 40 }, (_, i) => `● later output ${String(i)}`),
      "│ ❯ │",
    ].join("\n");
    expect(classify_blocking_pane(pane)).toBeNull();
  });

  it("ignores dialog wording that has scrolled into history", () => {
    const pane = [
      "The CLI asked: Do you want to proceed? — I answered yes.",
      ...Array.from({ length: 20 }, (_, i) => `output ${String(i)}`),
      "│ ❯ │",
    ].join("\n");
    expect(classify_blocking_pane(pane)).toBeNull();
  });

  it("a session on any blocking state reads idle — which is why callers must classify first", () => {
    for (const pane of [trust_dialog, permission_prompt, rate_limit_modal]) {
      expect(pane_shows_working(pane)).toBe(false);
    }
  });

  describe("pane_ready_for_input", () => {
    it("is true at an idle prompt", () => {
      expect(
        pane_ready_for_input(["● Done.", "│ ❯ │", "  ⏵⏵ bypass permissions on"].join("\n")),
      ).toBe(true);
    });

    it("is false while a turn is running", () => {
      expect(pane_ready_for_input(["✻ Working… (esc to interrupt)", "│ ❯ │"].join("\n"))).toBe(
        false,
      );
    });

    it("is false on a dialog even though its cursor is a ❯", () => {
      expect(pane_ready_for_input(trust_dialog)).toBe(false);
      expect(pane_ready_for_input(permission_prompt)).toBe(false);
    });

    it("is false with no prompt on screen (boot banner)", () => {
      expect(pane_ready_for_input("Welcome to Claude Code\nLoading MCP servers…")).toBe(false);
    });
  });
});
