import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Mock child_process — check_cwd_health calls execFileSync directly ──

const mock_exec_file_sync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mock_exec_file_sync(...args),
  spawn: vi.fn(),
}));

// ── Mock fs/promises — check_cwd_health uses stat() ──

const mock_stat = vi.fn();

vi.mock("node:fs/promises", () => ({
  stat: (...args: unknown[]) => mock_stat(...args),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock actions.ts — check_cwd_health calls notify for alerts
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
    paths: { lobsterfarm_dir: "/tmp/test-cwd-health" },
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

/**
 * Test-friendly subclass that exposes internals for check_cwd_health assertions.
 */
class TestBotPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  set_registry(registry: unknown): void {
    (this as unknown as { registry: unknown }).registry = registry;
  }

  /** Expose check_assigned_health for direct invocation. */
  async run_health_check(): Promise<void> {
    await this.check_assigned_health();
  }
}

// ── Tests ──

describe("check_cwd_health (issue #188)", () => {
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

    // Stub side effects — is_tmux_alive must return true to enter check_cwd_health
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      true,
    );
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers bot with orphaned cwd and posts alert", async () => {
    const deleted_path = "/repo/worktrees/deleted-feature";
    const safe_path = "/repo/root";

    // Set up registry so safe_path resolves from entity's primary repo
    pool.set_registry({
      get: vi.fn().mockReturnValue({
        entity: {
          repos: [{ path: safe_path }],
          channels: { list: [] },
        },
      }),
    });

    // tmux display-message returns the deleted path; send-keys is a no-op
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "display-message") {
        return `${deleted_path}\n`;
      }
      return "";
    });

    // stat throws — directory no longer exists
    mock_stat.mockRejectedValue(new Error("ENOENT: no such file or directory"));

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

    // send-keys should have been called with cd to safe_path
    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys_calls).toHaveLength(1);
    const send_args = send_keys_calls[0]![1] as string[];
    expect(send_args).toContain("-t");
    expect(send_args).toContain("pool-1");
    // The cd command should reference the safe path (shell-quoted)
    const cd_arg = send_args.find((a: string) => a.startsWith("cd "));
    expect(cd_arg).toContain(safe_path);

    // #alerts notification should have been posted
    expect(mock_notify).toHaveBeenCalledTimes(1);
    const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
    expect(channel_type).toBe("alerts");
    expect(message).toContain("orphaned cwd");
    expect(message).toContain(deleted_path);
    expect(message).toContain(safe_path);
  });

  it("does not send cd when cwd directory exists", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "display-message") {
        return "/repo/existing-dir\n";
      }
      return "";
    });

    // stat succeeds — directory exists
    mock_stat.mockResolvedValue({ isDirectory: () => true });

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

    // send-keys should NOT have been called
    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys_calls).toHaveLength(0);
    expect(mock_notify).not.toHaveBeenCalled();
  });

  it("does not crash health loop when tmux display-message fails", async () => {
    mock_exec_file_sync.mockImplementation(() => {
      throw new Error("tmux session not found");
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

    // Should complete without throwing — best-effort boundary
    await expect(pool.run_health_check()).resolves.toBeUndefined();
    expect(mock_notify).not.toHaveBeenCalled();
  });
});
