import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedPoolBot } from "../persistence.js";
import { type PoolBot, pending_json_path } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// ── Mocks ──

// Mock node:fs/promises — writeFile is the key assertion target. The hook
// contract is "daemon writes JSON pending file before spawn, sets env var" —
// that's what we verify here.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock node:child_process — we assert send-keys is NOT called for message
// bridging (the whole point of #290). execFileSync is still used by other
// code paths (capture-pane, has-session) so we keep a no-op default.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(""),
    spawn: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

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

/** Find the start_tmux call for a given bot and return the extra_env arg. */
function extra_env_from_start_tmux_calls(
  start_tmux: Mock,
  tmux_session: string,
): Record<string, string> | undefined {
  const call = start_tmux.mock.calls.find((c: unknown[]) => {
    const bot = c[0] as { tmux_session: string } | undefined;
    return bot?.tmux_session === tmux_session;
  });
  return call?.[6] as Record<string, string> | undefined;
}

/**
 * Test-friendly BotPool subclass. Stubs tmux/filesystem side effects
 * and exposes internals for resume_parked_bots testing.
 */
class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  inject_resume_candidates(candidates: PersistedPoolBot[]): void {
    (this as unknown as { resume_candidates: PersistedPoolBot[] }).resume_candidates = candidates;
  }

  protected override is_bot_idle(): boolean {
    return true;
  }
}

// ── Tests ──

describe("resume nudge via SessionStart hook (issue #290)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let start_tmux_spy: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    temp_dir = join(tmpdir(), `resume-nudge-test-${Date.now()}`);
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out side effects that resume_parked_bots calls before the nudge
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_nickname" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_avatar" as never,
    ).mockResolvedValue(undefined);
    start_tmux_spy = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined) as unknown as Mock;
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      false,
    );
    vi.spyOn(pool as unknown as Record<string, unknown>, "persist" as never).mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a JSON pending nudge file before spawn", async () => {
    const bot = make_bot({
      id: 3,
      state: "parked",
      channel_id: "ch-1",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-abc123",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-abc123",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();

    // JSON pending file was written with the nudge content
    expect(writeFile).toHaveBeenCalledWith(
      pending_json_path("pool-3"),
      expect.stringContaining("daemon restarted"),
      "utf-8",
    );
  });

  it("passes LF_PENDING_FILE to start_tmux for the resumed bot", async () => {
    const bot = make_bot({
      id: 0,
      state: "parked",
      channel_id: "ch-1",
      entity_id: "e1",
      archetype: "builder",
      session_id: "sess-xyz",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 0,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        channel_type: null,
        session_id: "sess-xyz",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();

    const extra_env = extra_env_from_start_tmux_calls(start_tmux_spy, "pool-0");
    expect(extra_env).toBeDefined();
    expect(extra_env?.LF_PENDING_FILE).toBe(pending_json_path("pool-0"));
  });

  it("nudge JSON payload includes continue-work instruction", async () => {
    const bot = make_bot({
      id: 6,
      state: "parked",
      channel_id: "ch-6",
      entity_id: "e1",
      archetype: "builder",
      session_id: "sess-6",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 6,
        state: "assigned",
        channel_id: "ch-6",
        entity_id: "e1",
        archetype: "builder",
        channel_type: null,
        session_id: "sess-6",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();

    const write_calls = (writeFile as Mock).mock.calls;
    const nudge_call = write_calls.find((c: unknown[]) =>
      (c[0] as string).includes("lf-pending-pool-6"),
    );
    expect(nudge_call).toBeDefined();

    // Body is JSON — parse it and assert on the content field
    const payload = JSON.parse((nudge_call![1] as string).trim());
    expect(payload).toMatchObject({
      user: "lobsterfarm-daemon",
      channel_id: "ch-6",
    });
    expect(payload.content).toContain("continue any in-progress work");
    expect(typeof payload.ts).toBe("string");
  });

  it("JSON file path matches bot ID", async () => {
    const bot = make_bot({
      id: 7,
      state: "assigned",
      channel_id: "ch-7",
      entity_id: "e1",
      archetype: "designer",
      session_id: "sess-777",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 7,
        state: "assigned",
        channel_id: "ch-7",
        entity_id: "e1",
        archetype: "designer",
        channel_type: null,
        session_id: "sess-777",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();

    expect(writeFile).toHaveBeenCalledWith(
      pending_json_path("pool-7"),
      expect.any(String),
      "utf-8",
    );

    const extra_env = extra_env_from_start_tmux_calls(start_tmux_spy, "pool-7");
    expect(extra_env?.LF_PENDING_FILE).toBe(pending_json_path("pool-7"));
  });

  it("does NOT invoke tmux send-keys for message bridging (the whole point of #290)", async () => {
    const bot = make_bot({
      id: 9,
      state: "parked",
      channel_id: "ch-9",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-9",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 9,
        state: "assigned",
        channel_id: "ch-9",
        entity_id: "e1",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-9",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();
    // Let any fire-and-forget promises settle — there shouldn't be any
    await vi.advanceTimersByTimeAsync(120_000);

    // Filter specifically for send-keys targeting the resumed bot's session.
    // Other send-keys calls (trust dialog auto-accept after start_tmux) are
    // fine — we just forbid the legacy message-injection pattern.
    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c: unknown[]) =>
        c[0] === "tmux" &&
        Array.isArray(c[1]) &&
        (c[1] as string[])[0] === "send-keys" &&
        (c[1] as string[])[2] === "pool-9",
    );

    // Check none of them inject the pending-file read prompt (the legacy pattern)
    for (const call of send_keys_calls) {
      const payload = String((call[1] as string[])[3] ?? "");
      expect(payload).not.toContain("lf-pending");
      expect(payload).not.toContain("Read ");
    }
  });

  it("start_tmux failure before write is handled (write happens first)", async () => {
    const bot = make_bot({
      id: 2,
      state: "parked",
      channel_id: "ch-2",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-fail",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 2,
        state: "assigned",
        channel_id: "ch-2",
        entity_id: "e1",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-fail",
        last_active: new Date().toISOString(),
      },
    ]);

    start_tmux_spy.mockRejectedValue(new Error("tmux failed"));

    await pool.resume_parked_bots();

    // The pending file is written before start_tmux is attempted — that's
    // acceptable for the hook model because the stale file just sits in
    // /tmp until the next spawn overwrites it (or drain_pending_files
    // removes the legacy .txt variant, not applicable here). What we
    // MUST NOT do is fall back to tmux send-keys for delivery.
    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c: unknown[]) =>
        c[0] === "tmux" &&
        Array.isArray(c[1]) &&
        (c[1] as string[])[0] === "send-keys" &&
        (c[1] as string[])[2] === "pool-2",
    );
    for (const call of send_keys_calls) {
      const payload = String((call[1] as string[])[3] ?? "");
      expect(payload).not.toContain("lf-pending");
    }
  });
});
