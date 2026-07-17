/**
 * Tests for per-entity 1Password service-account token injection (issue #93).
 *
 * Verifies that:
 * - resolve_entity_op_token maps entity_id → OP_SERVICE_ACCOUNT_TOKEN_{ENTITY}
 *   (uppercase + hyphen→underscore), including hyphenated ids.
 * - It returns the env value when set, and null when unset or empty string.
 * - The spawned session's env gets OP_SERVICE_ACCOUNT_TOKEN when an entity
 *   token is present (additive override of the tmux-global platform token).
 * - The key is OMITTED (never empty-string) when no entity token exists, so the
 *   platform global is inherited (fallback path).
 * - All three spawn paths (assign, resume, crash-restart) inject identically.
 *
 * SECURITY: every token here is a fake string injected via process.env — never a
 * real OP_SERVICE_ACCOUNT_TOKEN_* value.
 */

import { EventEmitter } from "node:events";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Module-level mocks ──

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

function make_entity_config(id: string): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id,
      name: id,
      repos: [],
      channels: { category_id: "", list: [] },
      memory: { path: `/tmp/test-memory/${id}` },
      secrets: { vault_name: `entity-${id}` },
    },
  });
}

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
}

/** Test subclass that stubs tmux-dependent behavior and exposes internals. */
class OpTokenTestPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  inject_registry(registry: MockRegistry): void {
    (this as unknown as { registry: MockRegistry }).registry = registry;
  }

  call_resolve_entity_op_token(entity_id: string): string | null {
    return (
      this as unknown as { resolve_entity_op_token: (id: string) => string | null }
    ).resolve_entity_op_token(entity_id);
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

describe("per-entity 1Password token injection", () => {
  let config: LobsterFarmConfig;
  let pool: OpTokenTestPool;
  let registry: MockRegistry;

  // Track env keys we set so each test cleans up after itself — never leak a
  // fake token into the host process env across tests.
  const dirty_env_keys = new Set<string>();

  function set_env(key: string, value: string): void {
    process.env[key] = value;
    dirty_env_keys.add(key);
  }

  // The daemon (and this test process) runs under `op run`, so the host env
  // already holds a REAL platform OP_SERVICE_ACCOUNT_TOKEN. Snapshot and delete
  // it for the duration of the suite so the "omit" assertions see a clean env —
  // and so a real token value never touches an assertion or log. Restored after.
  const saved_platform_token = process.env.OP_SERVICE_ACCOUNT_TOKEN;

  afterEach(() => {
    for (const key of dirty_env_keys) {
      delete process.env[key];
    }
    dirty_env_keys.clear();
    if (saved_platform_token !== undefined) {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = saved_platform_token;
    } else {
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    spawn_calls = [];
    // Isolate from the host's real platform token (see note above).
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

    config = make_config();
    pool = new OpTokenTestPool(config);
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

  // ── Mapping rule + resolution semantics ──

  describe("resolve_entity_op_token", () => {
    it("returns the env value for a simple entity id", () => {
      set_env("OP_SERVICE_ACCOUNT_TOKEN_HEALTHYDOGS", "fake-token-healthydogs");
      expect(pool.call_resolve_entity_op_token("healthydogs")).toBe("fake-token-healthydogs");
    });

    it("maps a hyphenated id (hyphen→underscore + uppercase)", () => {
      set_env("OP_SERVICE_ACCOUNT_TOKEN_LAND_ACQUISITION", "fake-token-land");
      expect(pool.call_resolve_entity_op_token("land-acquisition")).toBe("fake-token-land");
    });

    it("maps a multi-hyphen id", () => {
      set_env("OP_SERVICE_ACCOUNT_TOKEN_PARAGON_MM", "fake-token-paragon");
      expect(pool.call_resolve_entity_op_token("paragon-mm")).toBe("fake-token-paragon");
    });

    it("returns null when the env var is unset", () => {
      expect(pool.call_resolve_entity_op_token("no-such-entity")).toBeNull();
    });

    it("returns null when the env var is the empty string", () => {
      set_env("OP_SERVICE_ACCOUNT_TOKEN_EMPTY_ENTITY", "");
      expect(pool.call_resolve_entity_op_token("empty-entity")).toBeNull();
    });

    it("does not read a differently-cased env var (mapping is exact)", () => {
      // Only the lowercase env key exists — the helper must not match it.
      set_env("op_service_account_token_casing", "fake-should-not-match");
      expect(pool.call_resolve_entity_op_token("casing")).toBeNull();
    });
  });

  // ── Call-site injection: assign path ──

  describe("assign path", () => {
    it("injects OP_SERVICE_ACCOUNT_TOKEN into tmux command and spawn env when present", async () => {
      set_env("OP_SERVICE_ACCOUNT_TOKEN_ASSIGN_ENTITY", "fake-assign-token");
      registry.add(make_entity_config("assign-entity"));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-test", "assign-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).toContain("OP_SERVICE_ACCOUNT_TOKEN=");

      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.OP_SERVICE_ACCOUNT_TOKEN).toBe("fake-assign-token");
    });

    it("OMITS the key (no empty string) when no entity token exists", async () => {
      registry.add(make_entity_config("no-token-entity"));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 2, state: "free" })]);

      await pool.assign("ch-test", "no-token-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      // The additive extra-env prefix must NOT set the key at all — never as an
      // empty string, never at all. The tmux-global platform token is inherited.
      expect(cmd_string).not.toContain("OP_SERVICE_ACCOUNT_TOKEN=");

      // With the host platform token isolated (beforeEach), the merged spawn env
      // has no OP token either — proving the call site added nothing.
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    });
  });

  // ── Call-site injection: crash-restart path ──

  describe("crash-restart path", () => {
    it("injects OP_SERVICE_ACCOUNT_TOKEN when present", async () => {
      set_env("OP_SERVICE_ACCOUNT_TOKEN_CRASH_ENTITY", "fake-crash-token");
      registry.add(make_entity_config("crash-entity"));
      pool.inject_registry(registry);

      const bot = make_bot({
        id: 3,
        state: "busy",
        entity_id: "crash-entity",
        channel_id: "ch-crash",
        archetype: "builder",
        channel_type: "work_room",
        session_id: null,
      });
      pool.inject_bots([bot]);

      await (
        pool as unknown as { restart_crashed_session: (b: PoolBot) => Promise<void> }
      ).restart_crashed_session(bot);

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.OP_SERVICE_ACCOUNT_TOKEN).toBe("fake-crash-token");
    });

    it("OMITS the key when no entity token exists", async () => {
      registry.add(make_entity_config("crash-no-token"));
      pool.inject_registry(registry);

      const bot = make_bot({
        id: 4,
        state: "busy",
        entity_id: "crash-no-token",
        channel_id: "ch-crash2",
        archetype: "builder",
        channel_type: "work_room",
        session_id: null,
      });
      pool.inject_bots([bot]);

      await (
        pool as unknown as { restart_crashed_session: (b: PoolBot) => Promise<void> }
      ).restart_crashed_session(bot);

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).not.toContain("OP_SERVICE_ACCOUNT_TOKEN=");
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    });
  });
});
