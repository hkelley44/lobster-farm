import { describe, expect, it } from "vitest";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { is_discord_snowflake, DiscordBot } from "../discord.js";
import { EntityRegistry } from "../registry.js";

// ── Test helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

function make_entity_config(
  entity_id: string,
  channels: Array<{ id: string; type: string; name?: string }>,
): EntityConfig {
  return {
    entity: {
      id: entity_id,
      name: `Test ${entity_id}`,
      description: "",
      status: "active",
      repos: [],
      accounts: {},
      channels: {
        category_id: "",
        list: channels.map(ch => ({
          type: ch.type as "general" | "work_room" | "work_log" | "alerts",
          id: ch.id,
          name: ch.name ?? ch.type,
        })),
      },
      memory: { path: "/tmp/memory", auto_extract: true },
      secrets: { vault: "1password", vault_name: `entity-${entity_id}` },
    },
  };
}

function make_registry(entities: EntityConfig[]): EntityRegistry {
  const map = new Map<string, EntityConfig>();
  for (const e of entities) {
    map.set(e.entity.id, e);
  }
  return {
    get: (id: string) => map.get(id),
    get_all: () => [...map.values()],
    get_active: () => [...map.values()].filter(e => e.entity.status === "active"),
    count: () => map.size,
  } as unknown as EntityRegistry;
}

/**
 * Test-friendly subclass that exposes build_channel_map() internals
 * without requiring a real Discord connection.
 */
class TestDiscordBot extends DiscordBot {
  get_channel_map(): Map<string, unknown> {
    return (this as unknown as { channel_map: Map<string, unknown> }).channel_map;
  }

  get_entity_channels(): Map<string, Map<string, string>> {
    return (this as unknown as { entity_channels: Map<string, Map<string, string>> }).entity_channels;
  }
}

// ── is_discord_snowflake ──

describe("is_discord_snowflake", () => {
  it("accepts valid 18-digit snowflake IDs", () => {
    expect(is_discord_snowflake("1486494404784160849")).toBe(true);
  });

  it("accepts 17-digit snowflake IDs", () => {
    expect(is_discord_snowflake("12345678901234567")).toBe(true);
  });

  it("accepts 20-digit snowflake IDs", () => {
    expect(is_discord_snowflake("12345678901234567890")).toBe(true);
  });

  it("rejects placeholder IDs like 'gen-1'", () => {
    expect(is_discord_snowflake("gen-1")).toBe(false);
  });

  it("rejects placeholder IDs like 'wr-1'", () => {
    expect(is_discord_snowflake("wr-1")).toBe(false);
  });

  it("rejects placeholder IDs like 'cat-123'", () => {
    expect(is_discord_snowflake("cat-123")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(is_discord_snowflake("")).toBe(false);
  });

  it("rejects IDs shorter than 17 digits", () => {
    expect(is_discord_snowflake("1234567890123456")).toBe(false);
  });

  it("rejects IDs longer than 20 digits", () => {
    expect(is_discord_snowflake("123456789012345678901")).toBe(false);
  });

  it("rejects IDs with non-digit characters", () => {
    expect(is_discord_snowflake("1234567890123456a")).toBe(false);
  });
});

// ── build_channel_map snowflake filtering ──

describe("build_channel_map skips non-snowflake IDs", () => {
  it("only maps channels with valid snowflake IDs", () => {
    const config = make_config();
    const entity = make_entity_config("test-entity", [
      { id: "1486494404784160849", type: "general", name: "general" },
      { id: "gen-1", type: "general", name: "general-placeholder" },
      { id: "1486494404784160850", type: "work_room", name: "work-room-1" },
      { id: "wr-1", type: "work_room", name: "work-room-placeholder" },
    ]);

    const registry = make_registry([entity]);
    const bot = new TestDiscordBot(config, registry);

    bot.build_channel_map();

    const channel_map = bot.get_channel_map();

    // Only the two valid snowflake IDs should be in the map
    expect(channel_map.size).toBe(2);
    expect(channel_map.has("1486494404784160849")).toBe(true);
    expect(channel_map.has("1486494404784160850")).toBe(true);
    expect(channel_map.has("gen-1")).toBe(false);
    expect(channel_map.has("wr-1")).toBe(false);
  });

  it("entity_channels map only contains valid snowflake IDs", () => {
    const config = make_config();
    const entity = make_entity_config("test-entity", [
      { id: "gen-1", type: "general", name: "general-placeholder" },
      { id: "1486494404784160849", type: "work_room", name: "work-room-1" },
    ]);

    const registry = make_registry([entity]);
    const bot = new TestDiscordBot(config, registry);

    bot.build_channel_map();

    const entity_channels = bot.get_entity_channels();
    const entity_map = entity_channels.get("test-entity");

    // general was skipped (placeholder ID), work_room has valid snowflake
    expect(entity_map).toBeDefined();
    expect(entity_map!.has("general")).toBe(false);
    expect(entity_map!.has("work_room")).toBe(true);
    expect(entity_map!.get("work_room")).toBe("1486494404784160849");
  });

  it("handles entity with all placeholder IDs gracefully", () => {
    const config = make_config();
    const entity = make_entity_config("test-entity", [
      { id: "gen-1", type: "general" },
      { id: "wr-1", type: "work_room" },
      { id: "cat-123", type: "alerts" },
    ]);

    const registry = make_registry([entity]);
    const bot = new TestDiscordBot(config, registry);

    bot.build_channel_map();

    const channel_map = bot.get_channel_map();
    expect(channel_map.size).toBe(0);
  });
});

// ── find_upload_channel returns valid snowflake ──

describe("find_upload_channel returns valid snowflake when mixed entries exist", () => {
  it("returns a valid snowflake ID, not a placeholder", () => {
    const config = make_config();
    const entity = make_entity_config("test-entity", [
      { id: "gen-1", type: "general", name: "general-placeholder" },
      { id: "1486494404784160849", type: "work_log", name: "work-log" },
      { id: "wr-1", type: "work_room", name: "work-room-placeholder" },
    ]);

    const registry = make_registry([entity]);
    const bot = new TestDiscordBot(config, registry);

    bot.build_channel_map();

    // find_upload_channel is private — call it through the class
    const upload_id = (bot as unknown as { find_upload_channel: () => string | null }).find_upload_channel();

    // The only valid channel in the map is the work_log one
    expect(upload_id).toBe("1486494404784160849");
    expect(is_discord_snowflake(upload_id!)).toBe(true);
  });

  it("returns null when no valid snowflake channels exist", () => {
    const config = make_config();
    const entity = make_entity_config("test-entity", [
      { id: "gen-1", type: "general" },
      { id: "wr-1", type: "work_room" },
    ]);

    const registry = make_registry([entity]);
    const bot = new TestDiscordBot(config, registry);

    bot.build_channel_map();

    const upload_id = (bot as unknown as { find_upload_channel: () => string | null }).find_upload_channel();
    expect(upload_id).toBeNull();
  });
});
