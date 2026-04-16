import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolBot } from "../pool.js";
import { detect_rate_limit_modal, type scan_and_recover } from "../rate-limit-recovery.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// Mock actions.ts — notify is imported by pool.ts for alerting
vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistence to avoid filesystem side effects
vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({
    bots: [],
    session_history: {},
    avatar_state: {},
  }),
}));

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Mock the rate-limit-recovery module's tmux functions so pool integration
// tests don't need real tmux sessions. The module-level import in pool.ts
// calls scan_and_recover which defaults to real tmux capture — we mock the
// entire module and provide a controllable scan_and_recover in pool tests.
vi.mock("../rate-limit-recovery.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../rate-limit-recovery.js")>();
  return {
    ...original,
    // Keep the pure detection function unchanged — it's tested directly
    detect_rate_limit_modal: original.detect_rate_limit_modal,
    // scan_and_recover is mocked per-test in the pool integration section
    scan_and_recover: vi.fn().mockReturnValue([]),
  };
});

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

// ── Pure detection tests ──

describe("detect_rate_limit_modal", () => {
  it("detects 'Switch to extra usage' in last 10 lines", () => {
    const output = [
      "some output line 1",
      "some output line 2",
      "You've exceeded your usage limit.",
      "",
      "  ● Wait 3 hours",
      "  ● Switch to extra usage",
      "  ● Switch to Team plan",
      "",
      "Enter to confirm · Esc to cancel",
      "",
    ].join("\n");

    expect(detect_rate_limit_modal(output)).toBe(true);
  });

  it("detects 'exceeded' + 'Esc to cancel' combo", () => {
    const output = [
      "some output line 1",
      "You've exceeded your usage limit.",
      "",
      "Press Esc to cancel or Enter to confirm.",
      "",
    ].join("\n");

    expect(detect_rate_limit_modal(output)).toBe(true);
  });

  it("returns false for normal working output", () => {
    const output = [
      "Reading file: /src/pool.ts",
      "Analyzing code...",
      "",
      "I'll make the following changes:",
      "",
      "1. Add a new function for rate limiting",
      "2. Update the health check",
      "",
      "esc to interrupt",
      "",
    ].join("\n");

    expect(detect_rate_limit_modal(output)).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(detect_rate_limit_modal("")).toBe(false);
  });

  it("returns false for prompt-only output", () => {
    const output = "❯ ";
    expect(detect_rate_limit_modal(output)).toBe(false);
  });

  it("is case-insensitive for pattern matching", () => {
    const output = ["some lines", "SWITCH TO EXTRA USAGE", "more lines"].join("\n");

    expect(detect_rate_limit_modal(output)).toBe(true);
  });

  it("only considers last 10 lines", () => {
    // Put the pattern before line 10 from the end — should not trigger
    const lines = [
      "Switch to extra usage", // line 1 — this is the 12th from end
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11", // last 10 starts here
      "line 12",
      "line 13",
      "line 14",
      "line 15",
      "line 16",
      "line 17",
      "line 18",
      "line 19",
      "line 20",
    ];

    expect(detect_rate_limit_modal(lines.join("\n"))).toBe(false);
  });

  it("detects pattern within last 10 lines of longer output", () => {
    const lines = [
      "old line 1",
      "old line 2",
      "old line 3",
      "old line 4",
      "old line 5",
      "old line 6",
      "old line 7",
      "old line 8",
      "old line 9",
      "old line 10",
      "old line 11",
      "old line 12",
      "You've exceeded your usage limit.",
      "",
      "  ● Wait 3 hours",
      "  ● Switch to extra usage",
      "  ● Switch to Team plan",
      "",
      "Enter to confirm · Esc to cancel",
      "",
    ];

    expect(detect_rate_limit_modal(lines.join("\n"))).toBe(true);
  });

  it("detects partial match: just 'exceeded' and 'esc to cancel'", () => {
    const output = ["You've exceeded your weekly usage.", "Esc to cancel"].join("\n");

    expect(detect_rate_limit_modal(output)).toBe(true);
  });
});

// ── scan_and_recover (with mock tmux functions) ──

describe("scan_and_recover", () => {
  // Use the REAL scan_and_recover from the module (not the mocked version used
  // by pool tests). We import the original implementation for direct unit testing.
  let real_scan_and_recover: typeof scan_and_recover;

  beforeEach(async () => {
    // Import the original module directly (bypassing vi.mock)
    const original = await vi.importActual<typeof import("../rate-limit-recovery.js")>(
      "../rate-limit-recovery.js",
    );
    real_scan_and_recover = original.scan_and_recover;
  });

  it("recovers bot showing rate-limit modal", () => {
    const bot = make_bot({
      id: 1,
      state: "assigned",
      entity_id: "test-entity",
    });

    const modal_output = [
      "You've exceeded your usage limit.",
      "  ● Switch to extra usage",
      "Enter to confirm · Esc to cancel",
    ].join("\n");

    const mock_capture = vi.fn().mockReturnValue(modal_output);
    const mock_escape = vi.fn();

    const results = real_scan_and_recover([bot], mock_capture, mock_escape);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      bot_id: 1,
      tmux_session: "pool-1",
      entity_id: "test-entity",
    });
    expect(mock_escape).toHaveBeenCalledWith("pool-1");
  });

  it("skips bots without rate-limit modal", () => {
    const bot = make_bot({
      id: 2,
      state: "assigned",
      entity_id: "test-entity",
    });

    const normal_output = "Working on something...\n❯ ";
    const mock_capture = vi.fn().mockReturnValue(normal_output);
    const mock_escape = vi.fn();

    const results = real_scan_and_recover([bot], mock_capture, mock_escape);

    expect(results).toHaveLength(0);
    expect(mock_escape).not.toHaveBeenCalled();
  });

  it("skips non-assigned bots", () => {
    const bot = make_bot({
      id: 3,
      state: "parked",
      entity_id: "test-entity",
    });

    const mock_capture = vi.fn();
    const mock_escape = vi.fn();

    const results = real_scan_and_recover([bot], mock_capture, mock_escape);

    expect(results).toHaveLength(0);
    expect(mock_capture).not.toHaveBeenCalled();
  });

  it("handles capture failure gracefully", () => {
    const bot = make_bot({
      id: 4,
      state: "assigned",
      entity_id: "test-entity",
    });

    const mock_capture = vi.fn().mockReturnValue(null); // tmux capture failed
    const mock_escape = vi.fn();

    const results = real_scan_and_recover([bot], mock_capture, mock_escape);

    expect(results).toHaveLength(0);
    expect(mock_escape).not.toHaveBeenCalled();
  });

  it("handles escape failure gracefully — does not crash loop", () => {
    const bot = make_bot({
      id: 5,
      state: "assigned",
      entity_id: "test-entity",
    });

    const modal_output = "Switch to extra usage\nEsc to cancel";
    const mock_capture = vi.fn().mockReturnValue(modal_output);
    const mock_escape = vi.fn().mockImplementation(() => {
      throw new Error("tmux send-keys failed");
    });

    // Should not throw — failure is caught and logged
    const results = real_scan_and_recover([bot], mock_capture, mock_escape);

    expect(results).toHaveLength(0); // recovery failed, not counted
    expect(mock_escape).toHaveBeenCalledWith("pool-5");
  });

  it("recovers multiple bots in a single scan", () => {
    const bots = [
      make_bot({ id: 1, state: "assigned", entity_id: "entity-a" }),
      make_bot({ id: 2, state: "assigned", entity_id: "entity-b" }),
      make_bot({ id: 3, state: "assigned", entity_id: "entity-c" }),
    ];

    const mock_capture = vi
      .fn()
      .mockReturnValueOnce("Switch to extra usage\nEsc to cancel") // bot 1: stuck
      .mockReturnValueOnce("Working normally\n❯ ") // bot 2: fine
      .mockReturnValueOnce("exceeded your limit\nEsc to cancel"); // bot 3: stuck

    const mock_escape = vi.fn();

    const results = real_scan_and_recover(bots, mock_capture, mock_escape);

    expect(results).toHaveLength(2);
    expect(results[0].bot_id).toBe(1);
    expect(results[1].bot_id).toBe(3);
    expect(mock_escape).toHaveBeenCalledTimes(2);
  });
});

// ── Pool integration tests (check_rate_limit_modals) ──

class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  /** Expose check_rate_limit_modals for direct invocation in tests. */
  async run_rate_limit_check(): Promise<void> {
    await this.check_rate_limit_modals();
  }
}

describe("pool rate-limit recovery integration", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let mock_notify: ReturnType<typeof vi.fn>;
  let mock_scan: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "rate-limit-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    // Get the module-level mocks
    const actions = await import("../actions.js");
    mock_notify = actions.notify as unknown as ReturnType<typeof vi.fn>;
    mock_notify.mockClear();

    const recovery = await import("../rate-limit-recovery.js");
    mock_scan = recovery.scan_and_recover as unknown as ReturnType<typeof vi.fn>;
    mock_scan.mockClear();

    // Stub side effects
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    pool.stop_rate_limit_monitor();
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("calls scan_and_recover with assigned bots", async () => {
    const bots = [
      make_bot({ id: 1, state: "assigned", entity_id: "e1", channel_id: "ch-1" }),
      make_bot({ id: 2, state: "free" }),
      make_bot({ id: 3, state: "assigned", entity_id: "e2", channel_id: "ch-2" }),
    ];
    pool.inject_bots(bots);
    mock_scan.mockReturnValue([]);

    await pool.run_rate_limit_check();

    expect(mock_scan).toHaveBeenCalledTimes(1);
    // Should pass only the assigned bots
    const passed_bots = mock_scan.mock.calls[0][0] as PoolBot[];
    expect(passed_bots).toHaveLength(2);
    expect(passed_bots[0].id).toBe(1);
    expect(passed_bots[1].id).toBe(3);
  });

  it("posts alert for each recovered bot", async () => {
    const bots = [
      make_bot({ id: 1, state: "assigned", entity_id: "test-entity", channel_id: "ch-1" }),
    ];
    pool.inject_bots(bots);

    mock_scan.mockReturnValue([{ bot_id: 1, tmux_session: "pool-1", entity_id: "test-entity" }]);

    await pool.run_rate_limit_check();

    expect(mock_notify).toHaveBeenCalledTimes(1);
    const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
    expect(channel_type).toBe("alerts");
    expect(message).toContain("Pool bot 1");
    expect(message).toContain("rate-limit");
    expect(message).toContain("auto-dismissed");
    expect(message).toContain("test-entity");
  });

  it("skips scan when draining", async () => {
    pool.drain();
    pool.inject_bots([make_bot({ id: 1, state: "assigned", entity_id: "e1", channel_id: "ch-1" })]);

    await pool.run_rate_limit_check();

    expect(mock_scan).not.toHaveBeenCalled();
  });

  it("skips scan when no assigned bots", async () => {
    pool.inject_bots([make_bot({ id: 1, state: "free" })]);

    await pool.run_rate_limit_check();

    expect(mock_scan).not.toHaveBeenCalled();
  });

  it("tolerates notify failure without crashing", async () => {
    pool.inject_bots([make_bot({ id: 1, state: "assigned", entity_id: "e1", channel_id: "ch-1" })]);
    mock_scan.mockReturnValue([{ bot_id: 1, tmux_session: "pool-1", entity_id: "e1" }]);
    mock_notify.mockRejectedValue(new Error("Discord down"));

    // Should not throw
    await pool.run_rate_limit_check();

    expect(mock_notify).toHaveBeenCalledTimes(1);
  });

  it("posts multiple alerts when multiple bots recovered", async () => {
    pool.inject_bots([
      make_bot({ id: 1, state: "assigned", entity_id: "e1", channel_id: "ch-1" }),
      make_bot({ id: 2, state: "assigned", entity_id: "e2", channel_id: "ch-2" }),
    ]);
    mock_scan.mockReturnValue([
      { bot_id: 1, tmux_session: "pool-1", entity_id: "e1" },
      { bot_id: 2, tmux_session: "pool-2", entity_id: "e2" },
    ]);

    await pool.run_rate_limit_check();

    expect(mock_notify).toHaveBeenCalledTimes(2);
  });
});
