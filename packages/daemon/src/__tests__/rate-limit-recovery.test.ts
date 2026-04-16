import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Mock child_process — check_rate_limit_stalls calls execFileSync directly ──

const mock_exec_file_sync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mock_exec_file_sync(...args),
  spawn: vi.fn(),
}));

// Mock fs/promises — health check path touches filesystem
vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock actions.ts — check_rate_limit_stalls calls notify for alerts
vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistence
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

// ── Test helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: "/tmp/test-rate-limit" },
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

/** Simulate tmux pane output showing a rate-limit modal. */
const RATE_LIMIT_PANE = [
  "",
  "  You've exceeded your usage limit.",
  "",
  "  Switch to extra usage to continue, or wait until your limit resets.",
  "",
  "  Esc to cancel",
  "",
].join("\n");

/** Normal working output — no modal. */
const NORMAL_PANE = [
  "  reading file src/pool.ts",
  "  analyzing changes...",
  "  esc to interrupt",
  "",
].join("\n");

/**
 * Test-friendly subclass that exposes internals for rate-limit recovery assertions.
 */
class TestBotPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  get_rate_limit_dismissed(): Set<number> {
    return (this as unknown as { rate_limit_dismissed: Set<number> }).rate_limit_dismissed;
  }

  /** Expose check_assigned_health for direct invocation. */
  async run_health_check(): Promise<void> {
    await this.check_assigned_health();
  }
}

// ── Tests ──

describe("rate-limit modal auto-recovery (issue #270)", () => {
  let pool: TestBotPool;
  let mock_notify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const config = make_config();
    pool = new TestBotPool(config);

    // Get the module-level mock for notify
    const actions = await import("../actions.js");
    mock_notify = actions.notify as unknown as ReturnType<typeof vi.fn>;
    mock_notify.mockClear();

    // Stub side effects — tmux is alive for all sessions (rate-limit bots aren't dead)
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      true,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects rate-limit modal and sends Escape", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") return RATE_LIMIT_PANE;
      return "";
    });

    const bot = make_bot({
      id: 3,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "test-entity",
      archetype: "builder",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    await pool.run_health_check();

    // send-keys should have been called with Escape (no "Enter")
    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys_calls).toHaveLength(1);
    const send_args = send_keys_calls[0]![1] as string[];
    expect(send_args).toContain("Escape");
    expect(send_args).not.toContain("Enter");
  });

  it("posts alert to #alerts on first detection", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") return RATE_LIMIT_PANE;
      return "";
    });

    const bot = make_bot({
      id: 5,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "test-entity",
      archetype: "planner",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    await pool.run_health_check();

    expect(mock_notify).toHaveBeenCalledTimes(1);
    const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
    expect(channel_type).toBe("alerts");
    expect(message).toContain("pool-5");
    expect(message).toContain("planner");
    expect(message).toContain("auto-dismissed");
  });

  it("suppresses duplicate alerts on consecutive detections", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") return RATE_LIMIT_PANE;
      return "";
    });

    const bot = make_bot({
      id: 2,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "test-entity",
      archetype: "builder",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    // First health check — should alert
    await pool.run_health_check();
    expect(mock_notify).toHaveBeenCalledTimes(1);

    mock_notify.mockClear();

    // Second health check — modal still showing, should NOT alert again
    await pool.run_health_check();
    expect(mock_notify).not.toHaveBeenCalled();

    // But Escape should still be sent each time
    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    // Two health checks = two Escape sends
    expect(send_keys_calls.length).toBeGreaterThanOrEqual(2);
  });

  it("clears tracking when modal is dismissed and re-alerts on reappearance", async () => {
    let pane_output = RATE_LIMIT_PANE;
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") return pane_output;
      return "";
    });

    const bot = make_bot({
      id: 4,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "test-entity",
      archetype: "designer",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    // First check — detect and alert
    await pool.run_health_check();
    expect(mock_notify).toHaveBeenCalledTimes(1);
    expect(pool.get_rate_limit_dismissed().has(4)).toBe(true);

    mock_notify.mockClear();

    // Second check — modal gone (Escape worked)
    pane_output = NORMAL_PANE;
    await pool.run_health_check();
    expect(pool.get_rate_limit_dismissed().has(4)).toBe(false);

    // Third check — modal reappears, should alert again
    pane_output = RATE_LIMIT_PANE;
    await pool.run_health_check();
    expect(mock_notify).toHaveBeenCalledTimes(1);
  });

  it("does not trigger on normal output", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") return NORMAL_PANE;
      return "";
    });

    const bot = make_bot({
      id: 1,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "test-entity",
      archetype: "builder",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    await pool.run_health_check();

    // No send-keys calls (Escape or otherwise for rate-limit)
    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys_calls).toHaveLength(0);
    expect(mock_notify).not.toHaveBeenCalled();
  });

  it("skips non-assigned bots", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") return RATE_LIMIT_PANE;
      return "";
    });

    const bots = [make_bot({ id: 0, state: "free" }), make_bot({ id: 1, state: "parked" })];
    pool.inject_bots(bots);

    await pool.run_health_check();

    // No capture-pane calls should have happened for non-assigned bots
    const capture_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "capture-pane",
    );
    expect(capture_calls).toHaveLength(0);
  });

  it("fails open when tmux capture throws", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        throw new Error("tmux server not running");
      }
      return "";
    });

    const bot = make_bot({
      id: 1,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "test-entity",
      archetype: "builder",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    // Should complete without throwing
    await expect(pool.run_health_check()).resolves.toBeUndefined();
    expect(mock_notify).not.toHaveBeenCalled();
  });

  it("detects 'Switch to extra usage' variant", async () => {
    const switch_pane = [
      "",
      "  Switch to extra usage to keep working.",
      "  Esc to cancel",
      "",
    ].join("\n");

    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") return switch_pane;
      return "";
    });

    const bot = make_bot({
      id: 7,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "test-entity",
      archetype: "operator",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    await pool.run_health_check();

    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys_calls).toHaveLength(1);
    expect(mock_notify).toHaveBeenCalledTimes(1);
  });
});
