import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not mocked");
    }),
    spawn: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { input_box_text, message_still_in_input, send_keys_with_submit_retry } from "../pool.js";

/**
 * Build an execFileSync mock that:
 *  - records every send-keys invocation (so we can count Enter re-sends)
 *  - returns a scripted sequence of capture-pane outputs (one per poll)
 *
 * Once the scripted outputs are exhausted, the last value repeats — this lets a
 * test simulate "input box stays stuck forever" with a single trailing value.
 */
function mock_pane(pane_outputs: string[], message: string) {
  const send_keys_calls: string[][] = [];
  let poll = 0;

  (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "send-keys") {
      send_keys_calls.push(args);
      return "";
    }
    if (cmd === "tmux" && args[0] === "capture-pane") {
      const idx = Math.min(poll, pane_outputs.length - 1);
      poll++;
      return pane_outputs[idx] ?? `❯ ${message}`;
    }
    return "";
  });

  return {
    send_keys_calls,
    /** Bare-Enter sends: ["send-keys", "-t", <session>, "Enter"]. The text goes
     * in as its own ["send-keys", "-t", <session>, "-l", <message>] call. */
    enter_count: () => send_keys_calls.filter((a) => a.length === 4 && a[3] === "Enter").length,
    /** Enter RE-sends — every bare Enter after the first, which is the submit. */
    retry_count: () =>
      Math.max(0, send_keys_calls.filter((a) => a.length === 4 && a[3] === "Enter").length - 1),
  };
}

/**
 * Build an execFileSync mock where `send-keys` succeeds but every `capture-pane`
 * THROWS — simulating a dead/killed session whose pane can't be read. The
 * retry loop must treat this as indeterminate (never a confirmed submit).
 */
function mock_pane_capture_fails() {
  const send_keys_calls: string[][] = [];

  (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "send-keys") {
      send_keys_calls.push(args);
      return "";
    }
    if (cmd === "tmux" && args[0] === "capture-pane") {
      throw new Error("can't find pane: session not found");
    }
    return "";
  });

  return {
    send_keys_calls,
    retry_count: () =>
      Math.max(0, send_keys_calls.filter((a) => a.length === 4 && a[3] === "Enter").length - 1),
  };
}

// ── Tests ──

describe("send_keys_with_submit_retry", () => {
  const MSG = "hold until I delete the repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms immediately when the turn starts (esc to interrupt)", async () => {
    // Pane shows the active-generation indicator on the first poll.
    const m = mock_pane(["✶ Thinking… (esc to interrupt)"], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(true);

    // One send (text + Enter), no retries.
    expect(m.retry_count()).toBe(0);
  });

  it("confirms when the input box clears (text no longer present)", async () => {
    // Pane no longer echoes the typed text → submit landed.
    const m = mock_pane(["❯ "], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(true);
    expect(m.retry_count()).toBe(0);
  });

  it("re-sends Enter when text sits unsubmitted, then succeeds", async () => {
    // First confirm window: text still in the box. After the retry Enter, the
    // turn starts → confirmed.
    const m = mock_pane(
      [
        `❯ ${MSG}`, // poll 1 — still unsubmitted
        `❯ ${MSG}`, // poll 2 — still unsubmitted (window expires → retry Enter)
        "✶ Working… (esc to interrupt)", // poll 3 — turn started
      ],
      MSG,
    );

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 3,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(true);

    // Exactly one bare-Enter retry was needed.
    expect(m.retry_count()).toBe(1);
  });

  it("logs a warning when a retry was needed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = mock_pane([`❯ ${MSG}`, `❯ ${MSG}`, "esc to interrupt"], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 3,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(true);

    expect(m.retry_count()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("re-sending Enter"));
    warn.mockRestore();
  });

  it("gives up after bounded retries when text never submits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Input box stays stuck forever (single trailing value repeats).
    const m = mock_pane([`❯ ${MSG}`], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 2,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe(false);

    // Bounded: exactly max_retries bare-Enter re-sends, no infinite loop.
    expect(m.retry_count()).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Submit never confirmed"));
    warn.mockRestore();
  });

  it("does not warn on the happy path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock_pane(["esc to interrupt"], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(true);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not false-positive confirm when the pane read fails — retries then gives up", async () => {
    // Capture-pane throws on every poll (dead/killed session). A failed read is
    // indeterminate, NOT "input box empty → submitted": the loop must keep
    // retrying and then give up rather than reporting a phantom success (#65).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = mock_pane_capture_fails();

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 2,
    });
    await vi.advanceTimersByTimeAsync(3000);

    // Must NOT report a false-positive confirmation.
    expect(await p).toBe(false);
    // Bounded: exactly max_retries bare-Enter re-sends, no infinite loop.
    expect(m.retry_count()).toBe(2);
    // The pane-unreadable failure is surfaced, and the give-up is logged.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Pane read failed"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not confirm submit"));
    warn.mockRestore();
  });
});

// ── #149: wrapped input, and text + Enter as separate calls ──

const RULE = "─".repeat(120);
const LONG =
  "A Discord message reached the daemon but not this session — answer it with the Discord reply tool: [Discord · #general · from Hunter · chat_id=1488009160628109412 · message_id 1571718356141219881] active?";

/** The pane as CLI 2.1.325 draws it with LONG typed but not submitted: the
 * input box wraps the line, so the literal message is not in the capture. */
const STUCK_WRAPPED = [
  " ▐▛███▛█   Claude Code v2.1.325",
  `${RULE} tidus ─`,
  `❯ ${LONG.slice(0, 110)}`,
  `  ${LONG.slice(110)}`,
  RULE,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

/** After a successful submit: the turn is echoed above an empty box. */
const SUBMITTED_ECHO = [
  `❯ ${LONG.slice(0, 110)}`,
  `  ${LONG.slice(110)}`,
  "⏺ Done.",
  `${RULE} tidus ─`,
  "❯ ",
  RULE,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

describe("message_still_in_input (#149)", () => {
  it("sees wrapped text that a literal search misses", () => {
    expect(STUCK_WRAPPED.includes(LONG)).toBe(false); // the old check's blind spot
    expect(message_still_in_input(STUCK_WRAPPED, LONG)).toBe(true);
  });

  it("does not mistake the submitted turn's echo for stuck input", () => {
    expect(message_still_in_input(SUBMITTED_ECHO, LONG)).toBe(false);
  });

  it("falls back to the whole pane when the box cannot be located", () => {
    expect(input_box_text("❯ hello")).toBeNull();
    expect(message_still_in_input("❯ hello there", "hello there")).toBe(true);
    expect(message_still_in_input("❯ ", "hello there")).toBe(false);
  });

  it("sees a message taller than the pane, whose head has scrolled off", () => {
    // Visible pane only: the top rule and the first rows are gone, the tail
    // and the cursor are still on screen.
    const tall = `${LONG} ${"padding words to make this very long ".repeat(40)}the end of it`;
    const rows = tall.match(/.{1,110}/g) ?? [];
    const visible = [
      ...rows.slice(-6).map((r) => `  ${r}`),
      RULE,
      "  ⏵⏵ bypass permissions on",
    ].join("\n");
    expect(input_box_text(visible)).toBeNull(); // only the bottom rule is visible
    expect(visible.includes("A Discord message reached")).toBe(false); // head is gone
    expect(message_still_in_input(visible, tall)).toBe(true);
  });

  it("reads only the region between the last two rules", () => {
    expect(input_box_text(SUBMITTED_ECHO)).toBe("❯ ");
  });
});

describe("send_keys_with_submit_retry — submit mechanics (#149)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("types the text literally, then sends Enter as a separate call", async () => {
    const m = mock_pane(["esc to interrupt"], LONG);

    const p = send_keys_with_submit_retry("pool-2", LONG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(true);

    expect(m.send_keys_calls).toEqual([
      ["send-keys", "-t", "pool-2", "-l", LONG],
      ["send-keys", "-t", "pool-2", "Enter"],
    ]);
  });

  it("re-sends Enter for wrapped text left in the box, instead of reporting it submitted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = mock_pane([STUCK_WRAPPED, STUCK_WRAPPED, SUBMITTED_ECHO], LONG);

    const p = send_keys_with_submit_retry("pool-2", LONG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 3,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe(true);

    expect(m.retry_count()).toBe(1);
    warn.mockRestore();
  });

  it("reports failure when wrapped text never leaves the box", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = mock_pane([STUCK_WRAPPED], LONG);

    const p = send_keys_with_submit_retry("pool-2", LONG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 2,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toBe(false);
    expect(m.retry_count()).toBe(2);
    warn.mockRestore();
  });
});
