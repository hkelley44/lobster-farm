import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_DEAF_THRESHOLD_MS } from "../plugin-liveness.js";

// The probe reads the live tmux pane via is_tmux_session_idle. Mock it so tests
// can simulate a deaf (perpetually idle) or healthy (working) commander pane
// without a real tmux session.
const { idle_mock } = vi.hoisted(() => ({ idle_mock: vi.fn(() => true) }));
vi.mock("../plugin-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin-liveness.js")>();
  return { ...actual, is_tmux_session_idle: idle_mock };
});

import { CommanderProcess } from "../commander-process.js";

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: tmpdir() },
  });
}

/**
 * Test harness exposing the protected probe and the private state the probe
 * reads/mutates, plus stubbed tmux-alive and start() so no real tmux/Claude is
 * spawned. Mirrors the pool liveness test's subclass approach.
 */
class TestCommander extends CommanderProcess {
  start_calls = 0;
  start_should_throw = false;
  /** When true, the stubbed start() leaves state "stopped" instead of flipping
   * to "running" — simulates start()'s has_token()-false early return, the
   * real path where the commander goes silently dark. */
  start_leaves_stopped = false;

  // Drive the probe directly without the 10s interval.
  async run_probe(): Promise<void> {
    await (
      this as unknown as { check_plugin_liveness: () => Promise<void> }
    ).check_plugin_liveness();
  }

  set_state(state: "stopped" | "starting" | "running" | "crashed"): void {
    (this as unknown as { state: string }).state = state;
  }

  set_inbound(at: Date | null): void {
    (this as unknown as { last_inbound_at: Date | null }).last_inbound_at = at;
  }
  get_inbound(): Date | null {
    return (this as unknown as { last_inbound_at: Date | null }).last_inbound_at;
  }

  set_processing(at: Date | null): void {
    (this as unknown as { last_processing_at: Date | null }).last_processing_at = at;
  }
  get_processing(): Date | null {
    return (this as unknown as { last_processing_at: Date | null }).last_processing_at;
  }

  set_recovering(v: boolean): void {
    (this as unknown as { recovering_plugin: boolean }).recovering_plugin = v;
  }

  // Report tmux as not-alive so recovery skips the real kill-session call (no
  // real `pat` session exists in tests); start() is stubbed to avoid spawning.
  stub_internals(): void {
    vi.spyOn(this as unknown as { is_tmux_alive: () => boolean }, "is_tmux_alive").mockReturnValue(
      false,
    );
    vi.spyOn(this as unknown as { start: () => Promise<void> }, "start").mockImplementation(
      async () => {
        this.start_calls++;
        if (this.start_should_throw) throw new Error("respawn failed");
        // Mirror start()'s outcomes: either confirm running, or (has_token()
        // false) early-return leaving state "stopped". recover_deaf_commander
        // sets state "stopped" before calling start(), so the stopped case is
        // simply "leave it as-is".
        if (!this.start_leaves_stopped) {
          (this as unknown as { state: string }).state = "running";
        }
      },
    );
  }
}

describe("commander plugin-liveness probe (issue #77)", () => {
  let commander: TestCommander;
  let alert_mock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    idle_mock.mockReset();
    idle_mock.mockReturnValue(true); // default: idle (the dangerous case)
    commander = new TestCommander(make_config());
    commander.set_state("running");
    commander.stub_internals();
    alert_mock = vi.fn(async () => {});
    commander.set_alert_notifier(alert_mock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when no inbound message was delivered", async () => {
    commander.set_inbound(null);
    idle_mock.mockReturnValue(true);

    await commander.run_probe();

    expect(commander.start_calls).toBe(0);
    expect(alert_mock).not.toHaveBeenCalled();
  });

  it("does nothing during the grace window after an inbound", async () => {
    commander.set_inbound(new Date(Date.now() - 5_000)); // well under threshold
    idle_mock.mockReturnValue(true); // still idle, but within grace

    await commander.run_probe();

    expect(commander.start_calls).toBe(0);
    expect(alert_mock).not.toHaveBeenCalled();
    // Marker preserved so a later pass can still catch deafness.
    expect(commander.get_inbound()).not.toBeNull();
  });

  it("clears the inbound marker when the commander is actively working", async () => {
    commander.set_inbound(new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 10_000));
    idle_mock.mockReturnValue(false); // working → plugin delivered

    await commander.run_probe();

    expect(commander.start_calls).toBe(0);
    expect(alert_mock).not.toHaveBeenCalled();
    expect(commander.get_inbound()).toBeNull();
    expect(commander.get_processing()).not.toBeNull();
  });

  it("treats a commander that processed AFTER the inbound (then idled) as healthy", async () => {
    const inbound = new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 10_000);
    commander.set_inbound(inbound);
    commander.set_processing(new Date(inbound.getTime() + 1_000)); // processed after inbound
    idle_mock.mockReturnValue(true); // idle now — but it DID process

    await commander.run_probe();

    expect(commander.start_calls).toBe(0);
    expect(alert_mock).not.toHaveBeenCalled();
    expect(commander.get_inbound()).toBeNull();
  });

  it("detects deafness after the threshold and recovers via resume (alerts + restart)", async () => {
    commander.set_inbound(new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000));
    commander.set_processing(null);
    idle_mock.mockReturnValue(true); // idle the whole time, never processed

    await commander.run_probe();

    // Recovered via the start() resume path.
    expect(commander.start_calls).toBe(1);
    // The inbound marker is consumed so we don't re-trigger on the same silence.
    expect(commander.get_inbound()).toBeNull();
    // Two alerts: the up-front "went DEAF" and the closing "recovered ✅".
    expect(alert_mock).toHaveBeenCalledTimes(2);
    expect(String(alert_mock.mock.calls[0]?.[0])).toContain("went DEAF");
    expect(String(alert_mock.mock.calls[1]?.[0])).toContain("recovered");
  });

  it("surfaces a FAILED recovery when start() leaves the commander non-running (dark)", async () => {
    // Real-world reachable: has_token() returns false at recovery time, so
    // start() early-returns leaving state "stopped". Without a failure alert the
    // operator would see "resuming" and never learn the commander is dark.
    commander.start_leaves_stopped = true;
    commander.set_inbound(new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000));
    commander.set_processing(null);
    idle_mock.mockReturnValue(true);

    await commander.run_probe();

    expect(commander.start_calls).toBe(1);
    // Two alerts: "went DEAF" then "recovery FAILED — ... dark".
    expect(alert_mock).toHaveBeenCalledTimes(2);
    expect(String(alert_mock.mock.calls[0]?.[0])).toContain("went DEAF");
    const failure = String(alert_mock.mock.calls[1]?.[0]);
    expect(failure).toContain("recovery FAILED");
    expect(failure).toContain("dark");
    // No false "recovered ✅" surface on the dark path.
    expect(failure).not.toContain("✅");
    // Lock released so a future probe can retry.
    expect((commander as unknown as { recovering_plugin: boolean }).recovering_plugin).toBe(false);
  });

  it("in-flight lock prevents a second concurrent recovery", async () => {
    commander.set_inbound(new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000));
    commander.set_processing(null);
    idle_mock.mockReturnValue(true);

    // Simulate a recovery already in flight.
    commander.set_recovering(true);

    await commander.run_probe();

    expect(commander.start_calls).toBe(0);
    expect(alert_mock).not.toHaveBeenCalled();
  });

  it("does not probe when the commander is not running", async () => {
    commander.set_state("crashed");
    commander.set_inbound(new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000));
    idle_mock.mockReturnValue(true);

    await commander.run_probe();

    expect(commander.start_calls).toBe(0);
    expect(alert_mock).not.toHaveBeenCalled();
  });

  it("mark_inbound stamps last_inbound_at", () => {
    commander.set_inbound(null);
    commander.mark_inbound();
    expect(commander.get_inbound()).not.toBeNull();
  });

  it("still releases the in-flight lock if the respawn throws", async () => {
    commander.start_should_throw = true;
    commander.set_inbound(new Date(Date.now() - PLUGIN_DEAF_THRESHOLD_MS - 5_000));
    commander.set_processing(null);
    idle_mock.mockReturnValue(true);

    await commander.run_probe();

    // Two alerts: the up-front "went DEAF" and the "recovery FAILED" surface
    // from the catch. start attempted, and the lock was released in finally so a
    // subsequent probe is not permanently blocked.
    expect(alert_mock).toHaveBeenCalledTimes(2);
    expect(String(alert_mock.mock.calls[0]?.[0])).toContain("went DEAF");
    expect(String(alert_mock.mock.calls[1]?.[0])).toContain("recovery FAILED");
    expect(commander.start_calls).toBe(1);
    expect((commander as unknown as { recovering_plugin: boolean }).recovering_plugin).toBe(false);
  });
});
