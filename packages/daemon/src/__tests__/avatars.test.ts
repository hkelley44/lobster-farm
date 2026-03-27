import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, ArchetypeRole } from "@lobster-farm/shared";
import { DiscordBot } from "../discord.js";
import { EntityRegistry } from "../registry.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(lobsterfarm_dir_override?: string): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: {
      lobsterfarm_dir: lobsterfarm_dir_override ?? temp_dir,
    },
  });
}

/**
 * Test-friendly subclass of DiscordBot that avoids real Discord connections.
 * Exposes avatar cache internals for unit testing.
 */
class TestDiscordBot extends DiscordBot {
  /** Directly set an avatar URL in the in-memory cache (simulates a prior upload). */
  set_avatar_url(name: string, url: string): void {
    (this as unknown as { avatar_urls: Map<string, string> }).avatar_urls.set(name, url);
  }

  /** Get the full avatar_urls map for inspection. */
  get_avatar_urls(): Map<string, string> {
    return (this as unknown as { avatar_urls: Map<string, string> }).avatar_urls;
  }
}

function make_registry(config: LobsterFarmConfig): EntityRegistry {
  return new EntityRegistry(config);
}

beforeEach(async () => {
  temp_dir = await mkdtemp(join(tmpdir(), "lf-avatar-test-"));
  // Create state directory
  await mkdir(join(temp_dir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(temp_dir, { recursive: true, force: true });
});

// ── resolve_agent_identity ──

describe("resolve_agent_identity", () => {
  it("returns avatar URL when cache is populated", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    bot.set_avatar_url("gary", "https://cdn.discordapp.com/attachments/123/gary.jpg");
    bot.set_avatar_url("bob", "https://cdn.discordapp.com/attachments/123/bob.jpg");

    const gary = bot.resolve_agent_identity("planner");
    expect(gary.name).toBe("Gary");
    expect(gary.avatar_url).toBe("https://cdn.discordapp.com/attachments/123/gary.jpg");

    const bob = bot.resolve_agent_identity("builder");
    expect(bob.name).toBe("Bob");
    expect(bob.avatar_url).toBe("https://cdn.discordapp.com/attachments/123/bob.jpg");
  });

  it("returns undefined avatar_url when no cache entry exists", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    const result = bot.resolve_agent_identity("planner");
    expect(result.name).toBe("Gary");
    expect(result.avatar_url).toBeUndefined();
  });

  it("returns system identity with avatar when cached", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    bot.set_avatar_url("lobsterfarm", "https://cdn.discordapp.com/attachments/123/lobsterfarm.png");

    const result = bot.resolve_agent_identity("system");
    expect(result.name).toBe("LobsterFarm");
    expect(result.avatar_url).toBe("https://cdn.discordapp.com/attachments/123/lobsterfarm.png");
  });

  it("returns undefined avatar for system when not cached", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    const result = bot.resolve_agent_identity("system");
    expect(result.name).toBe("LobsterFarm");
    expect(result.avatar_url).toBeUndefined();
  });

  it("matches agent names case-insensitively", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    // Avatar cached under lowercase name
    bot.set_avatar_url("pearl", "https://cdn.discordapp.com/attachments/123/pearl.jpg");

    // Config has "Pearl" — resolve_agent_identity lowercases for lookup
    const result = bot.resolve_agent_identity("designer");
    expect(result.name).toBe("Pearl");
    expect(result.avatar_url).toBe("https://cdn.discordapp.com/attachments/123/pearl.jpg");
  });

  it("returns all configured agent identities", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    const archetypes: ArchetypeRole[] = ["planner", "designer", "builder", "operator", "commander"];
    const expected_names = ["Gary", "Pearl", "Bob", "Ray", "Pat"];

    for (let i = 0; i < archetypes.length; i++) {
      const result = bot.resolve_agent_identity(archetypes[i]!);
      expect(result.name).toBe(expected_names[i]);
    }
  });
});

// ── Avatar cache persistence ──

describe("avatar cache load/save", () => {
  it("saves and loads avatar cache to disk", async () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    bot.set_avatar_url("gary", "https://cdn.discordapp.com/attachments/1/gary.jpg");
    bot.set_avatar_url("bob", "https://cdn.discordapp.com/attachments/1/bob.jpg");

    await bot.save_avatar_cache();

    // Verify file exists and has correct content
    const raw = await readFile(join(temp_dir, "state", "avatar-urls.json"), "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    expect(data["gary"]).toBe("https://cdn.discordapp.com/attachments/1/gary.jpg");
    expect(data["bob"]).toBe("https://cdn.discordapp.com/attachments/1/bob.jpg");

    // Create a new bot and load the cache
    const bot2 = new TestDiscordBot(config, registry);
    const loaded = await bot2.load_avatar_cache();
    expect(loaded.get("gary")).toBe("https://cdn.discordapp.com/attachments/1/gary.jpg");
    expect(loaded.get("bob")).toBe("https://cdn.discordapp.com/attachments/1/bob.jpg");

    // Verify it also populates the bot's internal state
    const identity = bot2.resolve_agent_identity("planner");
    expect(identity.avatar_url).toBe("https://cdn.discordapp.com/attachments/1/gary.jpg");
  });

  it("returns empty map when cache file does not exist", async () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    const loaded = await bot.load_avatar_cache();
    expect(loaded.size).toBe(0);
  });

  it("returns empty map when cache file is invalid JSON", async () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    await writeFile(join(temp_dir, "state", "avatar-urls.json"), "not-json", "utf-8");

    const loaded = await bot.load_avatar_cache();
    expect(loaded.size).toBe(0);
  });

  it("ignores non-string values in cache file", async () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    await writeFile(
      join(temp_dir, "state", "avatar-urls.json"),
      JSON.stringify({ gary: "https://valid.url", bob: 42, pearl: null }),
      "utf-8",
    );

    const loaded = await bot.load_avatar_cache();
    expect(loaded.size).toBe(1);
    expect(loaded.get("gary")).toBe("https://valid.url");
  });

  it("creates state directory if it does not exist", async () => {
    // Use a fresh temp dir without pre-created state/
    const fresh_dir = await mkdtemp(join(tmpdir(), "lf-avatar-fresh-"));
    try {
      const config = make_config(fresh_dir);
      const registry = make_registry(config);
      const bot = new TestDiscordBot(config, registry);

      bot.set_avatar_url("gary", "https://example.com/gary.jpg");
      await bot.save_avatar_cache();

      const raw = await readFile(join(fresh_dir, "state", "avatar-urls.json"), "utf-8");
      const data = JSON.parse(raw) as Record<string, string>;
      expect(data["gary"]).toBe("https://example.com/gary.jpg");
    } finally {
      await rm(fresh_dir, { recursive: true, force: true });
    }
  });
});

// ── get_avatar_url ──

describe("get_avatar_url", () => {
  it("returns the cached URL for an agent", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    bot.set_avatar_url("gary", "https://cdn.discordapp.com/attachments/1/gary.jpg");

    expect(bot.get_avatar_url("gary")).toBe("https://cdn.discordapp.com/attachments/1/gary.jpg");
    expect(bot.get_avatar_url("Gary")).toBe("https://cdn.discordapp.com/attachments/1/gary.jpg");
  });

  it("returns undefined for uncached agent", () => {
    const config = make_config();
    const registry = make_registry(config);
    const bot = new TestDiscordBot(config, registry);

    expect(bot.get_avatar_url("nonexistent")).toBeUndefined();
  });
});
