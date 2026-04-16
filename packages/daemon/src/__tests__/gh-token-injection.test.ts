/**
 * Tests for per-entity GitHub token injection via 1Password.
 *
 * Verifies that:
 * - resolve_op_secret is called when entity has github_token_ref
 * - GH_TOKEN appears in the spawn env and tmux command when token is resolved
 * - Session starts gracefully without GH_TOKEN when resolve_op_secret fails
 * - No token resolution when entity has no github_token_ref
 */

import { EventEmitter } from "node:events";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Module-level mocks ──

// Track spawn calls for assertions
let spawn_calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let spawn_emitter: EventEmitter;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: unknown[]) => {
      spawn_calls.push({
        command: args[0] as string,
        args: args[1] as string[],
        options: args[2] as Record<string, unknown>,
      });
      spawn_emitter = new EventEmitter();
      // Emit close with code 0 on next tick
      setTimeout(() => spawn_emitter.emit("close", 0), 0);
      return spawn_emitter;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(actual.readFile),
  };
});

vi.mock("../env.js", () => ({
  resolve_binary: vi.fn((name: string) => `/usr/local/bin/${name}`),
}));

// ── Minimal mock registry ──

class MockRegistry {
  private entities = new Map<string, EntityConfig>();

  add(config: EntityConfig): void {
    this.entities.set(config.entity.id, config);
  }

  get(id: string): EntityConfig | undefined {
    return this.entities.get(id);
  }
}

function make_entity_config(overrides: {
  id: string;
  github_token_ref?: string;
}): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: overrides.id,
      name: overrides.id,
      repos: [],
      channels: { category_id: "", list: [] },
      memory: { path: `/tmp/test-memory/${overrides.id}` },
      secrets: {
        vault_name: `entity-${overrides.id}`,
        ...(overrides.github_token_ref ? { github_token_ref: overrides.github_token_ref } : {}),
      },
    },
  });
}

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/** Test subclass that stubs tmux-dependent behavior and exposes internals. */
class GhTokenTestPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  inject_registry(registry: MockRegistry): void {
    (this as unknown as { registry: MockRegistry }).registry = registry;
  }

  /** Replace resolve_op_secret with a test double. */
  override_resolve_op_secret(mock: (ref: string) => Promise<string>): void {
    (this as unknown as { resolve_op_secret: (ref: string) => Promise<string> }).resolve_op_secret =
      mock;
  }

  protected override is_bot_idle(): boolean {
    return true;
  }
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

describe("per-entity GitHub token injection", () => {
  let config: LobsterFarmConfig;
  let pool: GhTokenTestPool;
  let registry: MockRegistry;
  const saved_gh_token = process.env.GH_TOKEN;

  afterAll(() => {
    // Restore host environment's GH_TOKEN
    if (saved_gh_token !== undefined) {
      process.env.GH_TOKEN = saved_gh_token;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    spawn_calls = [];
    // Isolate tests from the host environment's GH_TOKEN
    delete process.env.GH_TOKEN;

    config = make_config();
    pool = new GhTokenTestPool(config);
    registry = new MockRegistry();

    // Stub pool side effects unrelated to start_tmux
    vi.spyOn(
      pool as unknown as { kill_tmux: (s: string) => void },
      "kill_tmux" as never,
    ).mockImplementation(() => {});
    vi.spyOn(
      pool as unknown as { write_access_json: (d: string, c: string | null) => Promise<void> },
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as { set_bot_nickname: (d: string, a: string) => Promise<void> },
      "set_bot_nickname" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as { set_bot_avatar: (b: PoolBot, a: string) => Promise<void> },
      "set_bot_avatar" as never,
    ).mockResolvedValue(undefined);
    // is_tmux_alive must return true AFTER spawn so start_tmux resolves successfully
    vi.spyOn(
      pool as unknown as { is_tmux_alive: (s: string) => boolean },
      "is_tmux_alive" as never,
    ).mockReturnValue(true);
    vi.spyOn(
      pool as unknown as { park_bot: (b: PoolBot) => Promise<void> },
      "park_bot" as never,
    ).mockImplementation(async (bot: PoolBot) => {
      bot.state = "parked";
    });
  });

  describe("resolve_github_token_ref", () => {
    it("returns null when registry is not set", () => {
      const resolve = (
        pool as unknown as { resolve_github_token_ref: (id: string) => string | null }
      ).resolve_github_token_ref.bind(pool);
      expect(resolve("some-entity")).toBeNull();
    });

    it("returns null when entity is not in registry", () => {
      pool.inject_registry(registry);
      const resolve = (
        pool as unknown as { resolve_github_token_ref: (id: string) => string | null }
      ).resolve_github_token_ref.bind(pool);
      expect(resolve("nonexistent")).toBeNull();
    });

    it("returns null when entity has no github_token_ref", () => {
      registry.add(make_entity_config({ id: "no-token" }));
      pool.inject_registry(registry);
      const resolve = (
        pool as unknown as { resolve_github_token_ref: (id: string) => string | null }
      ).resolve_github_token_ref.bind(pool);
      expect(resolve("no-token")).toBeNull();
    });

    it("returns the reference when entity has github_token_ref", () => {
      const ref = "op://entity-my-app/github/credential";
      registry.add(make_entity_config({ id: "with-token", github_token_ref: ref }));
      pool.inject_registry(registry);
      const resolve = (
        pool as unknown as { resolve_github_token_ref: (id: string) => string | null }
      ).resolve_github_token_ref.bind(pool);
      expect(resolve("with-token")).toBe(ref);
    });
  });

  describe("tmux command without github_token_ref", () => {
    it("does NOT include GH_TOKEN in tmux command or spawn env", async () => {
      registry.add(make_entity_config({ id: "no-gh-token" }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 3, state: "free" })]);

      await pool.assign("ch-test", "no-gh-token", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();

      // The tmux command string (last element in the args array)
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).not.toContain("GH_TOKEN=");
      expect(cmd_string).toContain("claude");

      // Spawn env should not have GH_TOKEN
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.GH_TOKEN).toBeUndefined();
    });

    it("does not call resolve_op_secret", async () => {
      registry.add(make_entity_config({ id: "no-resolve" }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      const resolve_spy = vi.fn();
      pool.override_resolve_op_secret(resolve_spy);

      await pool.assign("ch-test", "no-resolve", "builder", undefined, "work_room");

      expect(resolve_spy).not.toHaveBeenCalled();
    });
  });

  describe("tmux command with github_token_ref", () => {
    it("injects GH_TOKEN into tmux command and spawn env", async () => {
      const ref = "op://entity-client/github/credential";
      registry.add(make_entity_config({ id: "gh-token-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 5, state: "free" })]);

      pool.override_resolve_op_secret(async () => "ghp_test_token_abc123");

      await pool.assign("ch-test", "gh-token-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];

      // GH_TOKEN should appear as an env var prefix in the tmux command
      expect(cmd_string).toContain("GH_TOKEN=");
      expect(cmd_string).toContain("claude");
      // Should NOT use op run wrapping
      expect(cmd_string).not.toContain("op' run");
      expect(cmd_string).not.toContain("--env-file");

      // Spawn env should also have GH_TOKEN
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.GH_TOKEN).toBe("ghp_test_token_abc123");
    });

    it("calls resolve_op_secret with the ref from entity config", async () => {
      const ref = "op://entity-client/github/credential";
      registry.add(make_entity_config({ id: "resolve-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 4, state: "free" })]);

      const resolve_spy = vi.fn().mockResolvedValue("ghp_resolved");
      pool.override_resolve_op_secret(resolve_spy);

      await pool.assign("ch-test", "resolve-entity", "builder", undefined, "work_room");

      expect(resolve_spy).toHaveBeenCalledWith(ref);
      expect(resolve_spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("graceful fallback", () => {
    it("session starts without GH_TOKEN when resolve_op_secret fails", async () => {
      const ref = "op://entity-fail/github/credential";
      registry.add(make_entity_config({ id: "fail-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 6, state: "free" })]);

      pool.override_resolve_op_secret(async () => {
        throw new Error("op: item not found");
      });

      // Should NOT throw — session starts without GH_TOKEN
      await pool.assign("ch-test", "fail-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];

      // Should NOT contain GH_TOKEN since resolution failed
      expect(cmd_string).not.toContain("GH_TOKEN=");
      // But should still contain claude
      expect(cmd_string).toContain("claude");

      // Spawn env should not have GH_TOKEN
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.GH_TOKEN).toBeUndefined();
    });

    it("backward compatible — no registry means no token resolution", async () => {
      // Pool without a registry (legacy path)
      pool.inject_bots([make_bot({ id: 9, state: "free" })]);

      const resolve_spy = vi.fn();
      pool.override_resolve_op_secret(resolve_spy);

      await pool.assign("ch-test", "some-entity", "builder", undefined, "work_room");

      // resolve_op_secret should never be called — resolve_github_token_ref returns null
      expect(resolve_spy).not.toHaveBeenCalled();

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];

      expect(cmd_string).not.toContain("GH_TOKEN=");
      expect(cmd_string).toContain("claude");
    });
  });
});
