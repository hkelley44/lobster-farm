/**
 * Tests for DiscordBot.scaffold_entity — the standard-channel creation path
 * that runs when a new entity is scaffolded.
 *
 * Focus (#56): assert the #work-log channel is created alongside #general and
 * #alerts, that creation is idempotent (find-or-create — an existing channel is
 * reused, not duplicated), and that the work_log channel's ID is returned in the
 * result payload so the caller can persist it to config.yaml.
 */

import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { ChannelType as DiscordChannelType, type Guild } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordBot } from "../discord.js";
import type { EntityRegistry } from "../registry.js";

const CATEGORY_ID = "cat-100000000000000000";

/**
 * Build a mock Guild whose channels.create() records calls and returns a fake
 * channel with a deterministic snowflake. A caller-supplied `existing` map lets
 * a test pre-seed channels into the cache to exercise the find-or-create path.
 */
function make_guild(existing: Map<string, { id: string; name: string; parentId?: string }>): {
  guild: Guild;
  created: Array<{ name: string; type: number }>;
} {
  const created: Array<{ name: string; type: number }> = [];
  let next_id = 200000000000000000n;

  const cache = {
    // scaffold_entity looks up the category by (name, type) and each channel by
    // (name, parentId). A single find() over the seeded values covers both.
    find: (predicate: (c: unknown) => boolean) => {
      for (const c of existing.values()) {
        if (predicate(c)) return c;
      }
      return undefined;
    },
  };

  const guild = {
    channels: {
      cache,
      create: vi.fn(
        async (opts: { name: string; type: number; parent?: string; reason?: string }) => {
          created.push({ name: opts.name, type: opts.type });
          const id = (next_id++).toString();
          const channel = { id, name: opts.name, parentId: opts.parent ?? null };
          // Newly created channels join the cache so subsequent find() calls
          // (within the same scaffold run) resolve them.
          existing.set(id, channel);
          return channel;
        },
      ),
    },
  } as unknown as Guild;

  return { guild, created };
}

/** Construct a DiscordBot with role/permission helpers stubbed out. */
function make_bot(guild: Guild | null): DiscordBot {
  const config = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
  const registry = { get_all: () => [] } as unknown as EntityRegistry;
  const bot = new DiscordBot(config, registry);

  const overrides: Record<string, unknown> = {
    get_guild: vi.fn().mockResolvedValue(guild),
    ensure_roles_cached: vi.fn().mockResolvedValue(undefined),
    find_or_create_bot_role: vi.fn().mockResolvedValue({ id: "bot-role" }),
    find_or_create_entity_role: vi.fn().mockResolvedValue({ id: "entity-role" }),
    set_entity_category_permissions: vi.fn().mockResolvedValue(undefined),
    build_channel_map: vi.fn(),
  };
  Object.assign(bot as unknown as Record<string, unknown>, overrides);
  return bot;
}

describe("DiscordBot.scaffold_entity — work_log channel (#56)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates #work-log with type work_log alongside #general and #alerts", async () => {
    // Pre-seed the category so scaffold reuses it and only creates channels.
    const existing = new Map<string, { id: string; name: string; parentId?: string }>([
      [CATEGORY_ID, { id: CATEGORY_ID, name: "Acme", parentId: undefined }],
    ]);
    // The category find() matches on type === GuildCategory; tag it so the
    // predicate resolves it.
    (existing.get(CATEGORY_ID) as unknown as { type: number }).type =
      DiscordChannelType.GuildCategory;

    const { guild, created } = make_guild(existing);
    const bot = make_bot(guild);

    const result = await bot.scaffold_entity("acme", "Acme");

    // Three standard channels created: general, alerts, work-log.
    expect(created.map((c) => c.name).sort()).toEqual(["alerts", "general", "work-log"]);

    // work_log channel present in the result with its created ID.
    const work_log = result.channels.find((c) => c.type === "work_log");
    expect(work_log).toBeDefined();
    expect(work_log?.id).toBeTruthy();
    expect(work_log?.purpose).toBe("Agent activity feed");

    // The Discord channel name is hyphenated; the config type is underscored.
    const work_log_create = created.find((c) => c.name === "work-log");
    expect(work_log_create).toBeDefined();
    expect(work_log_create?.type).toBe(DiscordChannelType.GuildText);
  });

  it("is idempotent — reuses an existing #work-log instead of creating a duplicate", async () => {
    const existing = new Map<string, { id: string; name: string; parentId?: string }>();
    // Seed category + a pre-existing work-log channel under it.
    const category = { id: CATEGORY_ID, name: "Acme", parentId: undefined } as {
      id: string;
      name: string;
      parentId?: string;
      type?: number;
    };
    category.type = DiscordChannelType.GuildCategory;
    existing.set(CATEGORY_ID, category);
    existing.set("existing-work-log", {
      id: "existing-work-log",
      name: "work-log",
      parentId: CATEGORY_ID,
    });

    const { guild, created } = make_guild(existing);
    const bot = make_bot(guild);

    const result = await bot.scaffold_entity("acme", "Acme");

    // work-log already existed → it must NOT be re-created.
    expect(created.map((c) => c.name)).not.toContain("work-log");
    // ...but it must still be reported in the result with the existing ID.
    const work_log = result.channels.find((c) => c.type === "work_log");
    expect(work_log?.id).toBe("existing-work-log");
  });

  it("is fully idempotent — when general, alerts, and work-log all exist, zero channels are created", async () => {
    // Seed the category plus all three standard channels under it. A re-scaffold
    // of an already-provisioned entity must be a complete no-op on creation —
    // every channel resolves via find-or-create, so create() is never called.
    const existing = new Map<string, { id: string; name: string; parentId?: string }>();
    const category = { id: CATEGORY_ID, name: "Acme", parentId: undefined } as {
      id: string;
      name: string;
      parentId?: string;
      type?: number;
    };
    category.type = DiscordChannelType.GuildCategory;
    existing.set(CATEGORY_ID, category);
    for (const name of ["general", "alerts", "work-log"]) {
      existing.set(`existing-${name}`, {
        id: `existing-${name}`,
        name,
        parentId: CATEGORY_ID,
      });
    }

    const { guild, created } = make_guild(existing);
    const bot = make_bot(guild);

    const result = await bot.scaffold_entity("acme", "Acme");

    // Full-idempotency: nothing was created.
    expect(created).toHaveLength(0);
    // Every standard channel is still reported, resolved to its existing ID.
    expect(result.channels.find((c) => c.type === "work_log")?.id).toBe("existing-work-log");
    expect(result.channels.find((c) => c.type === "alerts")?.id).toBe("existing-alerts");
  });
});
