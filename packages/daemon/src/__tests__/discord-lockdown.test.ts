/**
 * Tests for the core lockdown helpers and the lockdown() orchestration (#295).
 *
 * Covers the Discord-interaction branches the schema/pure tests in
 * discord-roles.test.ts can't reach:
 *   - find_or_create_bot_role — existing vs create paths
 *   - find_or_create_entity_role — existing vs create paths
 *   - lockdown() — category fetch returns null (entity skipped, run continues)
 *
 * The DiscordBot is exercised against a lightweight Guild mock so we can
 * drive the branching without a real Discord connection.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityConfig,
  EntityConfigSchema,
  type LobsterFarmConfig,
  LobsterFarmConfigSchema,
} from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

// Mock child_process — discord.ts imports execFileSync at module scope.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(""),
    spawn: vi.fn(),
  };
});

// Mock discord.js Client so construction doesn't try to open a WebSocket.
vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn(),
      destroy: vi.fn(),
      user: null,
      channels: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
      application: null,
    })),
  };
});

// Mock sentry so failing paths don't attempt to send events.
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import type { Guild, Role } from "discord.js";
import { DiscordBot } from "../discord.js";
import { EntityRegistry } from "../registry.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
    discord: {
      server_id: "1485323605331017859",
      user_id: "732686813856006245",
    },
  });
}

interface MockRole {
  id: string;
  name: string;
}

interface MockGuildOpts {
  existing_roles?: MockRole[];
  channel_fetch?: (id: string) => Promise<unknown>;
}

interface MockGuildResult {
  guild: Guild;
  created_roles: MockRole[];
  roles_create: ReturnType<typeof vi.fn>;
  roles_fetch: ReturnType<typeof vi.fn>;
}

/**
 * Build a lightweight Guild mock that supports the subset of the discord.js
 * API the lockdown helpers exercise: role lookup/create, member iteration,
 * and channel fetch.
 */
function make_mock_guild(opts: MockGuildOpts = {}): MockGuildResult {
  const existing_roles: MockRole[] = [...(opts.existing_roles ?? [])];
  const created_roles: MockRole[] = [];
  let next_created_id = 1;

  const roles_fetch = vi.fn().mockResolvedValue(undefined);
  const roles_create = vi.fn().mockImplementation((create_opts: { name: string }) => {
    const role: MockRole = {
      id: `created-${String(next_created_id++)}`,
      name: create_opts.name,
    };
    created_roles.push(role);
    existing_roles.push(role);
    return Promise.resolve(role as unknown as Role);
  });

  const roles = {
    everyone: { id: "everyone-id" } as unknown as Role,
    fetch: roles_fetch,
    cache: {
      find: (pred: (r: MockRole) => boolean) => existing_roles.find(pred),
    },
    create: roles_create,
  };

  const members = {
    fetch: vi.fn().mockResolvedValue(new Map()),
  };

  const channels = {
    cache: {
      find: (_pred: (c: unknown) => boolean) => undefined,
    },
    fetch: vi.fn().mockImplementation((id: string) => {
      return opts.channel_fetch ? opts.channel_fetch(id) : Promise.resolve(null);
    }),
  };

  const guild = {
    roles,
    members,
    channels,
  } as unknown as Guild;

  return { guild, created_roles, roles_create, roles_fetch };
}

/**
 * Test-friendly DiscordBot subclass. Injects a guild, stubs the persistence
 * helper to avoid disk writes, and no-ops build_channel_map so the test
 * doesn't need a real channel map.
 */
class TestDiscordBot extends DiscordBot {
  persisted: Array<{ entity: { id: string } }> = [];
  private _guild: Guild | null = null;

  constructor(config: LobsterFarmConfig, registry: EntityRegistry) {
    super(config, registry);
    (this as unknown as Record<string, unknown>).persist_entity_config = vi
      .fn()
      .mockImplementation((cfg: { entity: { id: string } }) => {
        this.persisted.push(cfg);
        return Promise.resolve();
      });
    (this as unknown as Record<string, unknown>).build_channel_map = vi.fn();
  }

  set_guild(guild: Guild | null): void {
    this._guild = guild;
  }

  protected override get_guild(): Promise<Guild | null> {
    return Promise.resolve(this._guild);
  }
}

/** Registry subclass that returns a caller-supplied entity list. */
class TestRegistry extends EntityRegistry {
  private _entities: EntityConfig[] = [];

  override load_all(): Promise<void> {
    return Promise.resolve();
  }

  override get_all(): EntityConfig[] {
    return this._entities;
  }

  set_entities(entities: EntityConfig[]): void {
    this._entities = entities;
  }
}

beforeEach(async () => {
  temp_dir = await mkdtemp(join(tmpdir(), "lf-discord-lockdown-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(temp_dir, { recursive: true, force: true });
});

// ── Tests ──

describe("find_or_create_bot_role (#295)", () => {
  it("returns the existing LobsterFarm Bot role when present", async () => {
    const config = make_config();
    const registry = new TestRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const existing: MockRole = { id: "111111111111111111", name: "LobsterFarm Bot" };
    const { guild, roles_create, roles_fetch } = make_mock_guild({
      existing_roles: [existing],
    });

    const role = await bot.find_or_create_bot_role(guild);

    expect(role.id).toBe(existing.id);
    expect(role.name).toBe("LobsterFarm Bot");
    // Fresh-fetch before cache lookup is part of the idempotency contract.
    expect(roles_fetch).toHaveBeenCalledTimes(1);
    expect(roles_create).not.toHaveBeenCalled();
  });

  it("creates the role when not present", async () => {
    const config = make_config();
    const registry = new TestRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const { guild, roles_create, created_roles } = make_mock_guild();

    const role = await bot.find_or_create_bot_role(guild);

    expect(role.name).toBe("LobsterFarm Bot");
    expect(roles_create).toHaveBeenCalledTimes(1);
    expect(created_roles).toHaveLength(1);
    expect(created_roles[0]?.name).toBe("LobsterFarm Bot");
  });
});

describe("find_or_create_entity_role (#295)", () => {
  it("returns the existing entity role when present", async () => {
    const config = make_config();
    const registry = new TestRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const existing: MockRole = { id: "222222222222222222", name: "acme" };
    const { guild, roles_create, roles_fetch } = make_mock_guild({
      existing_roles: [existing],
    });

    const role = await bot.find_or_create_entity_role(guild, "acme");

    expect(role.id).toBe(existing.id);
    expect(role.name).toBe("acme");
    expect(roles_fetch).toHaveBeenCalledTimes(1);
    expect(roles_create).not.toHaveBeenCalled();
  });

  it("creates the entity role when not present", async () => {
    const config = make_config();
    const registry = new TestRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const { guild, roles_create, created_roles } = make_mock_guild();

    const role = await bot.find_or_create_entity_role(guild, "acme");

    expect(role.name).toBe("acme");
    expect(roles_create).toHaveBeenCalledTimes(1);
    expect(created_roles).toHaveLength(1);
    expect(created_roles[0]?.name).toBe("acme");
  });
});

describe("lockdown — category fetch returns null (#295)", () => {
  it("counts the entity as failed and continues the run", async () => {
    const config = make_config();
    const registry = new TestRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const entity: EntityConfig = EntityConfigSchema.parse({
      entity: {
        id: "ghost",
        name: "Ghost",
        memory: { path: "~/.lobsterfarm/entities/ghost" },
        secrets: { vault_name: "entity-ghost" },
        channels: {
          category_id: "1234567890123456789",
          list: [],
        },
      },
    });
    registry.set_entities([entity]);

    // Category fetch resolves null for this snowflake — a valid snowflake
    // resolving to null means the category was deleted or the bot lost
    // access. That's a failure (not a silent skip). Lockdown should still
    // complete and continue on to GLOBAL/failsafe.
    const channel_fetch = vi.fn().mockResolvedValue(null);
    const { guild } = make_mock_guild({ channel_fetch });
    bot.set_guild(guild);

    const result = await bot.lockdown();

    expect(channel_fetch).toHaveBeenCalledWith("1234567890123456789");
    expect(result.entities_processed).toBe(0);
    expect(result.entities_failed).toBe(1);
    // No disk write happened since the entity never reached the persist step.
    expect(bot.persisted).toHaveLength(0);
    // Bot role was still created even though no entity completed.
    expect(result.bot_role_id).toBeTruthy();
    // GLOBAL and failsafe lookups return undefined from the mock — both skipped.
    expect(result.global_locked).toBe(false);
    expect(result.failsafe_locked).toBe(false);
  });
});
