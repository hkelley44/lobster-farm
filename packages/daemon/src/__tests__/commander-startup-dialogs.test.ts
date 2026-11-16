import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupDialogOptions } from "../startup-dialogs.js";

// Capture the options the commander hands the responder, so each callback can
// be fired as the responder would — no tmux, no real dialog.
const { answer_mock, capture_message_mock } = vi.hoisted(() => ({
  answer_mock: vi.fn(),
  capture_message_mock: vi.fn(),
}));
vi.mock("../startup-dialogs.js", () => ({ answer_startup_dialogs: answer_mock }));
vi.mock("../sentry.js", () => ({
  captureMessage: capture_message_mock,
  captureException: vi.fn(),
}));

import { CommanderProcess, PAT_TMUX_SESSION } from "../commander-process.js";

class TestCommander extends CommanderProcess {
  run_watch(): void {
    this.watch_startup_dialogs();
  }
}

function make_commander(): TestCommander {
  return new TestCommander(
    LobsterFarmConfigSchema.parse({ user: { name: "Test" }, paths: { lobsterfarm_dir: tmpdir() } }),
  );
}

/** The options object the commander passed on its most recent call. */
function passed_options(): StartupDialogOptions {
  const call = answer_mock.mock.calls.at(-1) as [string, StartupDialogOptions];
  return call[1];
}

/** Let the fire-and-forget alert / catch chains settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("commander startup-dialog wiring (#144)", () => {
  let commander: TestCommander;
  let alert_mock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    answer_mock.mockReset();
    answer_mock.mockResolvedValue({ answered: [], ended: "ready", stuck: null });
    capture_message_mock.mockReset();
    commander = make_commander();
    alert_mock = vi.fn(async () => {});
    commander.set_alert_notifier(alert_mock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("watches the commander's own tmux session", () => {
    commander.run_watch();
    expect(answer_mock).toHaveBeenCalledTimes(1);
    expect(answer_mock.mock.calls[0]?.[0]).toBe(PAT_TMUX_SESSION);
  });

  it("alerts and reports to Sentry when a dialog is still open after startup", async () => {
    commander.run_watch();
    passed_options().on_stuck?.("trust_dialog");
    await settle();

    expect(alert_mock).toHaveBeenCalledTimes(1);
    const message = alert_mock.mock.calls[0]?.[0] as string;
    expect(message).toContain("stopped at the workspace-trust dialog");
    expect(message).toContain("#command-center is dark");
    expect(message).toContain(PAT_TMUX_SESSION);
    expect(capture_message_mock).toHaveBeenCalledWith(
      "Commander stuck at a startup dialog",
      "warning",
      { tags: { module: "commander", dialog: "trust_dialog" } },
    );
  });

  it("a failing alert sink does not escape the stuck callback", async () => {
    alert_mock.mockRejectedValue(new Error("discord down"));
    commander.run_watch();
    expect(() => passed_options().on_stuck?.("trust_dialog")).not.toThrow();
    await settle();
    expect(capture_message_mock).toHaveBeenCalledTimes(1);
  });

  it("logs, but does not alert, when no prompt and no recognised dialog appeared", async () => {
    commander.run_watch();
    passed_options().on_no_prompt?.();
    await settle();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("reworded startup dialog"));
    expect(alert_mock).not.toHaveBeenCalled();
    expect(capture_message_mock).toHaveBeenCalledWith(
      "Commander did not reach the prompt after startup",
      "warning",
      { tags: { module: "commander" } },
    );
  });

  it("swallows a responder that rejects", async () => {
    answer_mock.mockRejectedValue(new Error("tmux exploded"));
    expect(() => commander.run_watch()).not.toThrow();
    await settle();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Startup-dialog watcher failed"),
    );
  });
});
