/**
 * Tests for the bounded drain timeout introduced in issue #75.
 *
 * The shutdown handler in index.ts uses Promise.race() to pit the drain
 * loop against a hard deadline (SHUTDOWN_DRAIN_TIMEOUT_MS, default 90s).
 * These tests exercise the logic extracted into helpers so we can verify
 * the correct resolution path without wiring up the full daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers that mirror the drain-timeout logic from index.ts.
// Extracted here so they're testable without the full daemon context.
// ---------------------------------------------------------------------------

const drain_done = Symbol("drain_done");
const deadline_hit = Symbol("deadline_hit");

/**
 * Run the drain loop: poll every `poll_ms` until `is_idle()` returns true,
 * then resolve with `drain_done`.
 */
async function run_drain_loop(is_idle: () => boolean, poll_ms = 5000): Promise<typeof drain_done> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, poll_ms));
    if (is_idle()) {
      return drain_done;
    }
  }
}

/**
 * Deadline timer: resolves with `deadline_hit` after `timeout_ms`.
 */
function run_deadline(timeout_ms: number): Promise<typeof deadline_hit> {
  return new Promise((resolve) => setTimeout(() => resolve(deadline_hit), timeout_ms));
}

/**
 * The core race used in the shutdown handler.
 */
async function race_drain_against_deadline(
  is_idle: () => boolean,
  timeout_ms: number,
  poll_ms = 5000,
): Promise<typeof drain_done | typeof deadline_hit> {
  return Promise.race([run_drain_loop(is_idle, poll_ms), run_deadline(timeout_ms)]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shutdown drain-timeout race", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves drain_done when agents finish before the deadline", async () => {
    let idle = false;
    // Agent finishes at 10s; deadline is 90s
    setTimeout(() => {
      idle = true;
    }, 10_000);

    const racePromise = race_drain_against_deadline(() => idle, 90_000, 5_000);

    // Advance past the 5s poll — not idle yet
    await vi.advanceTimersByTimeAsync(5_000);
    // Advance past the 10s finish + another poll
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await racePromise;
    expect(result).toBe(drain_done);
  });

  it("resolves deadline_hit when agents are still working at deadline", async () => {
    // Agent never becomes idle within the deadline
    const racePromise = race_drain_against_deadline(() => false, 90_000, 5_000);

    // Advance past the deadline
    await vi.advanceTimersByTimeAsync(90_000);

    const result = await racePromise;
    expect(result).toBe(deadline_hit);
  });

  it("resolves drain_done when no active work at first poll", async () => {
    // Agent already idle before shutdown started
    const racePromise = race_drain_against_deadline(() => true, 90_000, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);

    const result = await racePromise;
    expect(result).toBe(drain_done);
  });

  it("resolves deadline_hit when work finishes just after deadline", async () => {
    let idle = false;
    // Agent finishes at 95s — 5s after the 90s deadline
    setTimeout(() => {
      idle = true;
    }, 95_000);

    const racePromise = race_drain_against_deadline(() => idle, 90_000, 5_000);

    await vi.advanceTimersByTimeAsync(90_000);

    const result = await racePromise;
    expect(result).toBe(deadline_hit);
  });

  it("polls at the configured interval until agents finish", async () => {
    let poll_count = 0;
    const is_idle_spy = vi.fn(() => {
      poll_count++;
      // Become idle on 4th poll (at 20s with 5s interval)
      return poll_count >= 4;
    });

    const racePromise = race_drain_against_deadline(is_idle_spy, 90_000, 5_000);

    // Advance through 4 polling cycles
    await vi.advanceTimersByTimeAsync(5_000); // poll 1
    await vi.advanceTimersByTimeAsync(5_000); // poll 2
    await vi.advanceTimersByTimeAsync(5_000); // poll 3
    await vi.advanceTimersByTimeAsync(5_000); // poll 4 — idle

    const result = await racePromise;
    expect(result).toBe(drain_done);
    expect(is_idle_spy).toHaveBeenCalledTimes(4);
  });

  describe("SHUTDOWN_DRAIN_TIMEOUT_MS env override", () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    /**
     * Mirror the parsing logic from index.ts so tests stay in sync with the
     * implementation.  Any change to index.ts parsing must be reflected here.
     *
     * Rules:
     *   - Use Number() (not parseInt) — handles scientific notation like "1e5"
     *   - Minimum 1000ms — reject smaller values as operationally unsafe
     *   - Fall back to 90_000ms for anything invalid
     */
    function parse_timeout(raw: string | undefined): number {
      const MINIMUM_MS = 1_000;
      const DEFAULT_MS = 90_000;
      if (raw !== undefined) {
        const parsed = Number(raw);
        if (!Number.isNaN(parsed) && parsed >= MINIMUM_MS) return parsed;
      }
      return DEFAULT_MS;
    }

    it("parses a valid numeric override", () => {
      expect(parse_timeout("30000")).toBe(30_000);
    });

    it("parses scientific notation correctly — 1e5 → 100000, not 1", () => {
      // parseInt("1e5", 10) returns 1 (silent truncation after "e").
      // Number("1e5") returns 100000. This test guards against regression.
      expect(parse_timeout("1e5")).toBe(100_000);
    });

    it("parses scientific notation with decimal — 9e4 → 90000", () => {
      expect(parse_timeout("9e4")).toBe(90_000);
    });

    it("falls back to 90s for a non-numeric value", () => {
      expect(parse_timeout("not-a-number")).toBe(90_000);
    });

    it("falls back to 90s for zero", () => {
      expect(parse_timeout("0")).toBe(90_000);
    });

    it("falls back to 90s for a small-positive value below the 1000ms minimum", () => {
      // A value like "500" is not a parse error but is operationally dangerous
      // (daemon always force-exits before draining).  Reject it.
      expect(parse_timeout("500")).toBe(90_000);
    });

    it("falls back to 90s for value of exactly 999 (one below minimum)", () => {
      expect(parse_timeout("999")).toBe(90_000);
    });

    it("accepts exactly 1000ms (the minimum)", () => {
      expect(parse_timeout("1000")).toBe(1_000);
    });

    it("falls back to 90s for a negative value", () => {
      expect(parse_timeout("-1")).toBe(90_000);
    });

    it("falls back to 90s when env var is absent", () => {
      expect(parse_timeout(undefined)).toBe(90_000);
    });

    it("resolves deadline_hit quickly with a short override", async () => {
      // Use 1s timeout for test speed
      const racePromise = race_drain_against_deadline(() => false, 1_000, 500);

      await vi.advanceTimersByTimeAsync(1_000);

      const result = await racePromise;
      expect(result).toBe(deadline_hit);
    });
  });
});
