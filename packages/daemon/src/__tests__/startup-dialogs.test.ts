import { describe, expect, it, vi } from "vitest";
import { answer_startup_dialogs, next_key_for_dialog } from "../startup-dialogs.js";

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
/** CLI 2.1.325: unnumbered options, decline listed first and preselected. */
const TRUST_DECLINE_SELECTED = [
  " Quick safety check: Is this a project you created or one you trust?",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
].join("\n");
const TRUST_ACCEPT_SELECTED = [
  " Quick safety check: Is this a project you created or one you trust?",
  "   No, exit",
  " ❯ Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
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
  const send_key = vi.fn();
  const deps = {
    capture: () => frames[Math.min(index++, frames.length - 1)] ?? null,
    send_key,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, send_key };
}

describe("answer_startup_dialogs", () => {
  it("presses nothing when no dialog appears", async () => {
    const { deps, send_key } = harness([BANNER, BANNER, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", {}, deps);
    expect(send_key).not.toHaveBeenCalled();
    expect(result).toEqual({ answered: [], ended: "ready", stuck: null });
  });

  it("presses Enter exactly once for the trust dialog", async () => {
    // The dialog lingers for two polls after the keypress while the CLI redraws.
    const { deps, send_key } = harness([BANNER, TRUST, TRUST, TRUST, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", {}, deps);
    expect(send_key).toHaveBeenCalledTimes(1);
    expect(send_key).toHaveBeenCalledWith("pool-1", "Enter");
    expect(result.answered).toEqual(["trust_dialog"]);
    expect(result.ended).toBe("ready");
  });

  it("answers trust then dev-channels with one Enter each", async () => {
    const { deps, send_key } = harness([TRUST, TRUST, DEV, DEV, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", { expect_dev_channels: true }, deps);
    expect(send_key).toHaveBeenCalledTimes(2);
    expect(result.answered).toEqual(["trust_dialog", "dev_channels_dialog"]);
    expect(result.ended).toBe("ready");
  });

  it("keeps watching for the dev-channels dialog when the prompt flashes first", async () => {
    const { deps, send_key } = harness([TRUST, PROMPT, PROMPT, DEV, PROMPT]);
    const result = await answer_startup_dialogs("pool-1", { expect_dev_channels: true }, deps);
    expect(send_key).toHaveBeenCalledTimes(2);
    expect(result.answered).toEqual(["trust_dialog", "dev_channels_dialog"]);
  });

  it("does not wait for a dev-channels dialog on a plugin session", async () => {
    const { deps } = harness([PROMPT]);
    const result = await answer_startup_dialogs("pool-1", { timeout_ms: 10_000 }, deps);
    expect(result.ended).toBe("ready");
  });

  it("re-presses a dialog that is still up well after the first Enter", async () => {
    const { deps, send_key } = harness([TRUST]); // never goes away
    const on_stuck = vi.fn();
    const result = await answer_startup_dialogs(
      "pool-1",
      { timeout_ms: 10_000, poll_ms: 500, on_stuck },
      deps,
    );
    // One press, then one more every 3s — never one per poll (20 polls here).
    expect(send_key.mock.calls.length).toBeGreaterThan(1);
    expect(send_key.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.answered).toEqual(["trust_dialog"]);
    expect(result).toMatchObject({ ended: "timeout", stuck: "trust_dialog" });
    expect(on_stuck).toHaveBeenCalledTimes(1);
    expect(on_stuck).toHaveBeenCalledWith("trust_dialog");
  });

  it("times out quietly when nothing is stuck", async () => {
    const { deps, send_key } = harness([BANNER]);
    const on_stuck = vi.fn();
    const result = await answer_startup_dialogs("pool-1", { timeout_ms: 5_000, on_stuck }, deps);
    expect(send_key).not.toHaveBeenCalled();
    expect(on_stuck).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ended: "timeout", stuck: null });
  });

  it("stops when the session disappears", async () => {
    const { deps, send_key } = harness([null]);
    const result = await answer_startup_dialogs("pool-1", {}, deps);
    expect(send_key).not.toHaveBeenCalled();
    expect(result.ended).toBe("session_gone");
  });

  it("never throws when the keypress or the stuck callback fails", async () => {
    const { deps } = harness([TRUST]);
    deps.send_key.mockImplementation(() => {
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

  it("reports a boot that shows neither a known dialog nor the prompt (reworded dialog)", async () => {
    const reworded = " Before we begin: do you trust this workspace?\n ❯ 1. Trust it\n   2. Leave";
    const { deps, send_key } = harness([reworded]);
    const on_no_prompt = vi.fn();
    const on_stuck = vi.fn();
    const result = await answer_startup_dialogs(
      "pool-1",
      { timeout_ms: 5_000, on_no_prompt, on_stuck },
      deps,
    );
    expect(send_key).not.toHaveBeenCalled();
    expect(result.ended).toBe("timeout");
    expect(on_stuck).not.toHaveBeenCalled();
    expect(on_no_prompt).toHaveBeenCalledTimes(1);
  });

  it("does not report no-prompt for a broker session that reached the prompt and saw no dev dialog", async () => {
    const { deps } = harness([PROMPT]);
    const on_no_prompt = vi.fn();
    const result = await answer_startup_dialogs(
      "pool-1",
      { timeout_ms: 5_000, expect_dev_channels: true, on_no_prompt },
      deps,
    );
    expect(result).toMatchObject({ ended: "timeout", stuck: null });
    expect(on_no_prompt).not.toHaveBeenCalled();
  });

  // #144 — CLI 2.1.325 preselects "No, exit"; a bare Enter quit the session.
  it("moves the cursor to the accept option before confirming the trust dialog", async () => {
    const { deps, send_key } = harness([
      TRUST_DECLINE_SELECTED,
      TRUST_ACCEPT_SELECTED,
      TRUST_ACCEPT_SELECTED,
      PROMPT,
    ]);
    const result = await answer_startup_dialogs("pat", {}, deps);
    expect(send_key.mock.calls).toEqual([
      ["pat", "Down"],
      ["pat", "Enter"],
    ]);
    expect(result).toEqual({ answered: ["trust_dialog"], ended: "ready", stuck: null });
  });

  it("never confirms while the cursor is still on the decline option", async () => {
    // The arrow key is not taking effect: keep nudging, never press Enter.
    const { deps, send_key } = harness([TRUST_DECLINE_SELECTED]);
    const on_stuck = vi.fn();
    const result = await answer_startup_dialogs("pat", { timeout_ms: 5_000, on_stuck }, deps);
    expect(send_key).toHaveBeenCalled();
    expect(send_key.mock.calls.every(([, key]) => key === "Down")).toBe(true);
    expect(result).toMatchObject({ answered: [], ended: "timeout", stuck: "trust_dialog" });
    expect(on_stuck).toHaveBeenCalledWith("trust_dialog");
  });

  it("presses nothing when the cursor cannot be located", async () => {
    const no_cursor = [
      " Quick safety check: Is this a project you created or one you trust?",
      "   No, exit",
      "   Yes, I trust this folder",
    ].join("\n");
    const { deps, send_key } = harness([no_cursor]);
    const on_stuck = vi.fn();
    await answer_startup_dialogs("pat", { timeout_ms: 5_000, on_stuck }, deps);
    expect(send_key).not.toHaveBeenCalled();
    expect(on_stuck).toHaveBeenCalledWith("trust_dialog");
  });
});

describe("next_key_for_dialog", () => {
  it("confirms when the cursor is on the accept option, in either layout", () => {
    expect(next_key_for_dialog("trust_dialog", TRUST)).toBe("Enter");
    expect(next_key_for_dialog("trust_dialog", TRUST_ACCEPT_SELECTED)).toBe("Enter");
    expect(next_key_for_dialog("dev_channels_dialog", DEV)).toBe("Enter");
  });

  it("navigates toward the accept option from a decline option", () => {
    expect(next_key_for_dialog("trust_dialog", TRUST_DECLINE_SELECTED)).toBe("Down");
    const accept_listed_first = [
      " Quick safety check: Is this a project you created or one you trust?",
      "   1. Yes, I trust this folder",
      " ❯ 2. No, exit",
    ].join("\n");
    expect(next_key_for_dialog("trust_dialog", accept_listed_first)).toBe("Up");
  });

  it("returns null when the accept option is not on screen", () => {
    const title_only = " Quick safety check: Is this a project you created or one you trust?";
    expect(next_key_for_dialog("trust_dialog", title_only)).toBeNull();
  });

  it("ignores a ❯ that is not on a known option", () => {
    const stray = [
      "❯ an earlier prompt line in scrollback",
      " Quick safety check: Is this a project you created or one you trust?",
      "   No, exit",
      "   Yes, I trust this folder",
    ].join("\n");
    expect(next_key_for_dialog("trust_dialog", stray)).toBeNull();
  });
});
