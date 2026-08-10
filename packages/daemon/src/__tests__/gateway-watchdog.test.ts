import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySnapshot } from "../gateway-watchdog.js";
import { GatewayWatchdog } from "../gateway-watchdog.js";

// Mock sentry so we can assert Sentry-first ordering without a DSN.
vi.mock("../sentry.js", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import * as sentry from "../sentry.js";

// discord.js v14 defaults the watchdog is tuned for.
const HEARTBEAT_MS = 41_250;
const THRESHOLD_MS = 3 * HEARTBEAT_MS; // 123_750

/**
 * Deterministic harness: injected clock + scripted probe, ticks driven by
 * hand — no timers, no Discord.
 */
function make_harness(opts?: { recycle_fails?: boolean }) {
  let now = 1_000_000;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };

  let snapshot: GatewaySnapshot = { last_heartbeat_ack_ms: now, connecting: false };
  const set_snapshot = (s: GatewaySnapshot) => {
    snapshot = s;
  };

  // Shared call log so cross-callee ordering (sentry vs recycle vs alert) is
  // assertable from one array.
  const call_order: string[] = [];
  (sentry.captureMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
    call_order.push("sentry");
  });

  const recycle = vi.fn(async () => {
    call_order.push("recycle");
    if (opts?.recycle_fails) throw new Error("login failed — discord unreachable");
  });
  const alert = vi.fn(async () => {
    call_order.push("alert");
  });

  const watchdog = new GatewayWatchdog({
    probe: () => snapshot,
    recycle,
    alert,
    now: clock.now,
  });

  return { watchdog, clock, set_snapshot, recycle, alert, call_order };
}

describe("gateway watchdog (#107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("healthy gateway (recent heartbeat acks) never recycles", async () => {
    const { watchdog, clock, set_snapshot, recycle } = make_harness();
    watchdog.start();

    // Simulate hours of healthy operation: ack refreshes every heartbeat.
    for (let i = 0; i < 100; i++) {
      clock.advance(HEARTBEAT_MS);
      set_snapshot({ last_heartbeat_ack_ms: clock.now(), connecting: false });
      await watchdog.tick();
    }

    expect(recycle).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("a quiet channel is NOT deafness: no messageCreate for hours, but heartbeats flow — no recycle", async () => {
    const { watchdog, clock, set_snapshot, recycle } = make_harness();
    watchdog.start();

    // The liveness signal is heartbeat recency, not message recency. As long
    // as acks keep landing, silence at the message level is irrelevant.
    for (let i = 0; i < 500; i++) {
      clock.advance(30_000);
      set_snapshot({ last_heartbeat_ack_ms: clock.now() - 5_000, connecting: false });
      await watchdog.tick();
    }
    expect(recycle).not.toHaveBeenCalled();
  });

  it("sustained heartbeat silence (3 missed intervals) triggers exactly one recycle", async () => {
    const { watchdog, clock, set_snapshot, recycle } = make_harness();
    watchdog.start();

    const last_ack = clock.now();
    set_snapshot({ last_heartbeat_ack_ms: last_ack, connecting: false });

    // Just under the threshold: no recycle yet.
    clock.advance(THRESHOLD_MS - 1);
    await watchdog.tick();
    expect(recycle).not.toHaveBeenCalled();

    // Cross the threshold: recycle fires once.
    clock.advance(2);
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(recycle.mock.calls[0]![0]).toContain("no gateway heartbeat ack");
  });

  it("emits the Sentry event FIRST, then recycles, then best-effort alerts", async () => {
    const { watchdog, clock, set_snapshot, call_order } = make_harness();
    watchdog.start();

    set_snapshot({ last_heartbeat_ack_ms: clock.now(), connecting: false });
    clock.advance(THRESHOLD_MS + 1);
    await watchdog.tick();

    // Discord may be the sick component — Sentry must be out-of-band and first.
    expect(call_order).toEqual(["sentry", "recycle", "alert"]);
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("recycling Discord client"),
      "error",
      expect.objectContaining({ tags: { module: "gateway-watchdog" } }),
    );
  });

  it("transient disconnect/resume does NOT recycle (connecting shard = discord.js recovery owns it)", async () => {
    const { watchdog, clock, set_snapshot, recycle } = make_harness();
    watchdog.start();

    // Gateway drops: acks stop, shard enters reconnect. Even far past the
    // threshold, the watchdog stays out of discord.js's way.
    const stale_ack = clock.now();
    clock.advance(THRESHOLD_MS * 4);
    set_snapshot({ last_heartbeat_ack_ms: stale_ack, connecting: true });
    await watchdog.tick();
    expect(recycle).not.toHaveBeenCalled();

    // Resume succeeds: fresh ack lands. Still no recycle.
    set_snapshot({ last_heartbeat_ack_ms: clock.now(), connecting: false });
    await watchdog.tick();
    expect(recycle).not.toHaveBeenCalled();
  });

  it("no ack ever (login flowed but heartbeats never started) counts from the start baseline", async () => {
    const { watchdog, clock, set_snapshot, recycle } = make_harness();
    watchdog.start();
    set_snapshot({ last_heartbeat_ack_ms: null, connecting: false });

    // Grace: a fresh start gets a full threshold before its first ack.
    clock.advance(THRESHOLD_MS - 1);
    await watchdog.tick();
    expect(recycle).not.toHaveBeenCalled();

    clock.advance(2);
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(1);
  });

  it("re-arms with a full grace window after a recycle (no hot-loop)", async () => {
    const { watchdog, clock, set_snapshot, recycle } = make_harness();
    watchdog.start();

    set_snapshot({ last_heartbeat_ack_ms: clock.now(), connecting: false });
    clock.advance(THRESHOLD_MS + 1);
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(1);

    // Immediately after the recycle the ack is still stale (fresh login takes
    // time to heartbeat) — but the baseline was reset, so no second recycle
    // until ANOTHER full threshold of silence.
    await watchdog.tick();
    clock.advance(THRESHOLD_MS - 1);
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(1);

    clock.advance(2);
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(2);
  });

  it("a failed recycle captures the exception, still alerts, and retries only after another threshold", async () => {
    const { watchdog, clock, set_snapshot, recycle, alert } = make_harness({
      recycle_fails: true,
    });
    watchdog.start();

    set_snapshot({ last_heartbeat_ack_ms: clock.now(), connecting: false });
    clock.advance(THRESHOLD_MS + 1);
    await watchdog.tick();

    expect(recycle).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    // Hail-mary alert still attempted, with the failure surfaced.
    expect(alert).toHaveBeenCalledTimes(1);
    expect((alert.mock.calls[0] as string[])[0]).toContain("FAILED");

    // No hot-loop: next tick is quiet; a full further threshold retries.
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(1);
    clock.advance(THRESHOLD_MS + 1);
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(2);
  });

  it("force_recycle (invalidated session) bypasses the silence threshold", async () => {
    const { watchdog, clock, set_snapshot, recycle, call_order } = make_harness();
    watchdog.start();
    set_snapshot({ last_heartbeat_ack_ms: clock.now(), connecting: false });

    await watchdog.force_recycle("gateway session invalidated");

    expect(recycle).toHaveBeenCalledTimes(1);
    expect(call_order).toEqual(["sentry", "recycle", "alert"]);
  });

  it("a throwing probe counts as silence, not a crash", async () => {
    let now = 1_000_000;
    const recycle = vi.fn(async () => {});
    const watchdog = new GatewayWatchdog({
      probe: () => {
        throw new Error("host wiring broken");
      },
      recycle,
      now: () => now,
    });
    watchdog.start();

    await watchdog.tick(); // must not throw
    expect(recycle).not.toHaveBeenCalled();

    now += THRESHOLD_MS + 1;
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(1);
  });

  it("custom threshold: missed_intervals and heartbeat_interval_ms are honored", async () => {
    let now = 0;
    const recycle = vi.fn(async () => {});
    const watchdog = new GatewayWatchdog({
      probe: () => ({ last_heartbeat_ack_ms: 0, connecting: false }),
      recycle,
      heartbeat_interval_ms: 1_000,
      missed_intervals: 5,
      now: () => now,
    });
    watchdog.start();

    now = 4_999;
    await watchdog.tick();
    expect(recycle).not.toHaveBeenCalled();

    now = 5_000;
    await watchdog.tick();
    expect(recycle).toHaveBeenCalledTimes(1);
  });
});
