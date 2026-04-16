import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PoolBot, pending_json_path } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// ── Mocks ──

// Mock fs to capture writeFile — that's the key assertion for the hook
// contract (daemon writes pending JSON file before spawn).
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock child_process — assert send-keys is NOT called for message bridging.
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

function make_bot(id: number, overrides: Partial<PoolBot> = {}): PoolBot {
  return {
    id,
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: false,
    tmux_session: `pool-${String(id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-pool-${String(id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
}

// ── Tests ──

describe("assign() with pending_message (SessionStart hook wiring — issue #290)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let start_tmux_spy: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    temp_dir = join(tmpdir(), `pending-inject-test-${Date.now()}`);
    config = make_config();
    pool = new TestBotPool(config);

    // Stub assign() side effects
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
    vi.spyOn(pool as unknown as Record<string, unknown>, "persist" as never).mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a JSON pending file and sets LF_PENDING_FILE on spawn", async () => {
    pool.inject_bots([make_bot(0)]);

    const result = await pool.assign(
      "channel-abc",
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      {
        user: "carol",
        channel_id: "channel-abc",
        message_id: "msg-1",
        content: "please build the feature",
        ts: "2026-04-16T10:00:00.000Z",
      },
    );

    expect(result).not.toBeNull();

    // JSON payload written to the canonical pending_json_path
    const json_write = (writeFile as Mock).mock.calls.find((c: unknown[]) =>
      (c[0] as string).endsWith("lf-pending-pool-0.json"),
    );
    expect(json_write).toBeDefined();
    const written = JSON.parse((json_write![1] as string).trim());
    expect(written).toMatchObject({
      user: "carol",
      channel_id: "channel-abc",
      message_id: "msg-1",
      content: "please build the feature",
      ts: "2026-04-16T10:00:00.000Z",
    });

    // start_tmux received LF_PENDING_FILE in extra_env (7th arg)
    expect(start_tmux_spy).toHaveBeenCalled();
    const extra_env = start_tmux_spy.mock.calls[0]![6] as Record<string, string>;
    expect(extra_env.LF_PENDING_FILE).toBe(pending_json_path("pool-0"));
  });

  it("does NOT write pending file when no pending_message is given", async () => {
    pool.inject_bots([make_bot(1)]);

    await pool.assign("channel-def", "entity-1", "planner");

    const json_writes = (writeFile as Mock).mock.calls.filter((c: unknown[]) =>
      (c[0] as string).endsWith("lf-pending-pool-1.json"),
    );
    expect(json_writes).toHaveLength(0);

    // extra_env to start_tmux should not include LF_PENDING_FILE
    const extra_env = start_tmux_spy.mock.calls[0]?.[6] as Record<string, string> | undefined;
    expect(extra_env?.LF_PENDING_FILE).toBeUndefined();
  });

  it("does NOT invoke tmux send-keys to bridge the first message", async () => {
    pool.inject_bots([make_bot(2)]);

    await pool.assign("channel-ghi", "entity-1", "planner", undefined, undefined, undefined, {
      user: "dave",
      channel_id: "channel-ghi",
      message_id: "msg-2",
      content: "hello",
      ts: new Date().toISOString(),
    });

    // Allow any async background work to settle
    await vi.advanceTimersByTimeAsync(120_000);

    // There should be no send-keys call targeting pool-2 with a pending-file prompt.
    // Other send-keys calls (e.g. trust-dialog auto-accept inside start_tmux, which
    // we've stubbed out entirely) are fine — we assert on message-injection pattern.
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
      expect(payload).not.toContain("Read /tmp");
    }
  });

  it("pending file write failure does not block assignment", async () => {
    pool.inject_bots([make_bot(3)]);

    // Make only the JSON pending-file write fail — other writes (access.json, etc.)
    // must still succeed for assign() to progress.
    (writeFile as Mock).mockImplementation(async (path: string) => {
      if (path.includes("lf-pending-pool-3")) {
        throw new Error("disk full");
      }
    });

    const result = await pool.assign(
      "channel-jkl",
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      {
        user: "erin",
        channel_id: "channel-jkl",
        message_id: "msg-3",
        content: "hi",
        ts: new Date().toISOString(),
      },
    );

    // Assignment still succeeds — hook injection is best-effort.
    expect(result).not.toBeNull();
    // start_tmux was still called — just without LF_PENDING_FILE.
    expect(start_tmux_spy).toHaveBeenCalled();
    const extra_env = start_tmux_spy.mock.calls[0]![6] as Record<string, string>;
    expect(extra_env.LF_PENDING_FILE).toBeUndefined();
  });
});
