import { describe, expect, it, vi } from "vitest";
import { answer_startup_dialogs } from "../startup-dialogs.js";

const TRUST = [
  " Quick safety check: Is this a project you created or one you trust?",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
].join("\n");
const DEV = [
  " WARNING: Loading development channels",
  " ❯ 1. I am using this for local development",
  "   2. Exit",
].join("\n");
const PROMPT = ["╭────╮", "│ ❯  │", "╰────╯", "  ⏵⏵ bypass permissions on"].join("\n");
const BANNER = "Welcome to Claude Code\nLoading MCP servers…";

/**
 * Drive the responder with a scripted sequence of pane captures and a virtual
 * clock (each sleep advances it), so no real time passes. The last frame
 * repeats forever.
 */
function harness(frames: Array<string | null>) {
  let clock = 0;
  let index = 0;
  const send_enter = vi.fn();
  const deps = {
    capture: () => frames[Math.min(index++, frames.length - 1)] ?? null,
    send_enter,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, send_enter };
}

describe("answer_startup_dialogs", () => {
  it("presses nothing when no dialog appears", async () => {
    const { deps, send_enter } = harness([BANNER, BANNER, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", {}, deps);
    expect(send_enter).not.toHaveBeenCalled();
    expect(result).toEqual({ answered: [], ended: "ready", stuck: null });
  });

  it("presses Enter exactly once for the trust dialog", async () => {
    // The dialog lingers for two polls after the keypress while the CLI redraws.
    const { deps, send_enter } = harness([BANNER, TRUST, TRUST, TRUST, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", {}, deps);
    expect(send_enter).toHaveBeenCalledTimes(1);
    expect(send_enter).toHaveBeenCalledWith("pool-1");
    expect(result.answered).toEqual(["trust_dialog"]);
    expect(result.ended).toBe("ready");
  });

  it("answers trust then dev-channels with one Enter each", async () => {
    const { deps, send_enter } = harness([TRUST, TRUST, DEV, DEV, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", { expect_dev_channels: true }, deps);
    expect(send_enter).toHaveBeenCalledTimes(2);
    expect(result.answered).toEqual(["trust_dialog", "dev_channels_dialog"]);
    expect(result.ended).toBe("ready");
  });

  it("keeps watching for the dev-channels dialog when the prompt flashes first", async () => {
    const { deps, send_enter } = harness([TRUST, PROMPT, PROMPT, DEV, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", { expect_dev_channels: true }, deps);
    expect(send_enter).toHaveBeenCalledTimes(2);
    expect(result.answered).toEqual(["trust_dialog", "dev_channels_dialog"]);
  });

  it("does not wait for a dev-channels dialog on a plugin session", async () => {
    const { deps } = harness([PROMPT]);
    const result = await answer_startup_dialogs("pool-1", { timeout_ms: 10_000 }, deps);
    expect(result.ended).toBe("ready");
  });

  it("re-presses a dialog that is still up well after the first Enter", async () => {
    const { deps, send_enter } = harness([TRUST]); // never goes away
    const on_stuck = vi.fn();
    const result = await answer_startup_dialogs(
      "pool-1",
      { timeout_ms: 10_000, poll_ms: 500, on_stuck },
      deps,
    );
    // One press, then one more every 3s — never one per poll (20 polls here).
    expect(send_enter.mock.calls.length).toBeGreaterThan(1);
    expect(send_enter.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.answered).toEqual(["trust_dialog"]);
    expect(result).toMatchObject({ ended: "timeout", stuck: "trust_dialog" });
    expect(on_stuck).toHaveBeenCalledTimes(1);
    expect(on_stuck).toHaveBeenCalledWith("trust_dialog");
  });

  it("times out quietly when nothing is stuck", async () => {
    const { deps, send_enter } = harness([BANNER]);
    const on_stuck = vi.fn();
    const result = await answer_startup_dialogs("pool-1", { timeout_ms: 5_000, on_stuck }, deps);
    expect(send_enter).not.toHaveBeenCalled();
    expect(on_stuck).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ended: "timeout", stuck: null });
  });

  it("stops when the session disappears", async () => {
    const { deps, send_enter } = harness([null]);
    const result = await answer_startup_dialogs("pool-1", {}, deps);
    expect(send_enter).not.toHaveBeenCalled();
    expect(result.ended).toBe("session_gone");
  });

  it("never throws when the keypress or the stuck callback fails", async () => {
    const { deps } = harness([TRUST]);
    deps.send_enter.mockImplementation(() => {
      throw new Error("no such session");
    });
    const result = await answer_startup_dialogs(
      "pool-1",
      {
        timeout_ms: 3_000,
        on_stuck: () => {
          throw new Error("alert sink down");
        },
      },
      deps,
    );
    expect(result).toMatchObject({ ended: "timeout", stuck: "trust_dialog", answered: [] });
  });
});
