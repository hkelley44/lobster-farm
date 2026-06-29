import { describe, expect, it } from "vitest";
import { PLUGIN_DEAF_THRESHOLD_MS, evaluate_plugin_liveness } from "../plugin-liveness.js";

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
