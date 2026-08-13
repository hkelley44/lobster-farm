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
  evaluate_plugin_liveness,
  is_tmux_session_idle,
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
