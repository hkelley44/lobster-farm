import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotPool } from "../pool.js";
import type { EntityRegistry } from "../registry.js";

/** Create a config with the given discord.user_id. */
function make_config(user_id?: string): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    discord: user_id ? { server_id: "111222333", user_id } : { server_id: "111222333" },
  });
}

/** Create a config with no discord section at all. */
function make_config_no_discord(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/** Build a minimal EntityConfig stub for registry mocking. */
function make_entity(id: string, channels: Array<{ type: string; id: string }>): EntityConfig {
  return {
    entity: {
      id,
      name: id,
      description: "",
      status: "active",
      blueprint: "software",
      pr_lifecycle: "v1",
      repos: [],
      accounts: { github: { user: "test" } },
      channels: {
        category_id: "cat-1",
        list: channels.map((c) => ({
          type: c.type,
          id: c.id,
          purpose: "",
        })),
      },
      memory: { path: "/tmp", auto_extract: false },
      secrets: { vault: "1password", vault_name: `entity-${id}` },
    },
  } as unknown as EntityConfig;
}

/** Build a fake EntityRegistry that returns our stubbed entities. */
function make_registry(entities: Record<string, EntityConfig>): EntityRegistry {
  return {
    get: (id: string) => entities[id],
    get_all: () => Object.values(entities),
    get_active: () => Object.values(entities),
    count: () => Object.keys(entities).length,
    load_all: async () => {},
  } as unknown as EntityRegistry;
}

/**
 * Test subclass that exposes write_access_json for direct testing and
 * lets tests inject a fake registry. The real method is private, so we
 * call it via bracket notation.
 */
class TestBotPool extends BotPool {
  set_registry(registry: EntityRegistry | null): void {
    (this as unknown as { registry: EntityRegistry | null }).registry = registry;
  }

  async test_write_access_json(
    state_dir: string,
    channel_id: string | null,
    entity_id: string | null = null,
  ): Promise<void> {
    return (
      this as unknown as {
        write_access_json: (d: string, c: string | null, e: string | null) => Promise<void>;
      }
    ).write_access_json(state_dir, channel_id, entity_id);
  }
}

describe("pool bot access control", () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = join(tmpdir(), `pool-access-test-${randomUUID()}`);
    await mkdir(tmp_dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true }).catch(() => {});
  });

  it("writes configured user_id into access.json allowFrom", async () => {
    const config = make_config("999888777666555");
    const pool = new TestBotPool(config);

    await pool.test_write_access_json(tmp_dir, "chan-123");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.allowFrom).toEqual(["999888777666555"]);
    expect(content.dmPolicy).toBe("allowlist");
  });

  it("writes empty allowFrom when discord.user_id is not set", async () => {
    const config = make_config(); // no user_id
    const pool = new TestBotPool(config);

    await pool.test_write_access_json(tmp_dir, "chan-123");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.allowFrom).toEqual([]);
    // Warning is logged once in initialize(), not per write_access_json call
  });

  it("writes empty allowFrom when discord section is absent", async () => {
    const config = make_config_no_discord();
    const pool = new TestBotPool(config);

    await pool.test_write_access_json(tmp_dir, null);

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.allowFrom).toEqual([]);
    expect(content.groups).toEqual({});
  });

  it("does not contain any hardcoded Discord user IDs", async () => {
    const config = make_config("123456789012345678");
    const pool = new TestBotPool(config);

    await pool.test_write_access_json(tmp_dir, "chan-123");

    const raw = await readFile(join(tmp_dir, "access.json"), "utf-8");
    // The old hardcoded ID should never appear
    expect(raw).not.toContain("732686813856006245");
    // Only the configured ID should be present
    expect(raw).toContain("123456789012345678");
  });

  it("includes channel group when channel_id is provided", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);

    await pool.test_write_access_json(tmp_dir, "chan-456");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.groups["chan-456"]).toEqual({
      requireMention: false,
      allowFrom: [],
    });
  });

  it("writes no channel groups when channel_id is null", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);

    await pool.test_write_access_json(tmp_dir, null);

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.groups).toEqual({});
  });

  // ── #40: alerts channel outbound allowlist enrichment ──

  it("includes the entity's #alerts channel in groups when entity_id is provided (#40)", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(
      make_registry({
        healthydogs: make_entity("healthydogs", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
          { type: "work_room", id: "wr-chan" },
        ]),
      }),
    );

    await pool.test_write_access_json(tmp_dir, "wr-chan", "healthydogs");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    // Inbound channel: requireMention false (normal listening)
    expect(content.groups["wr-chan"]).toEqual({
      requireMention: false,
      allowFrom: [],
    });
    // Alerts channel: outbound-only — requireMention true so we don't consume
    // alert posts as commands
    expect(content.groups["alerts-chan"]).toEqual({
      requireMention: true,
      allowFrom: [],
    });
  });

  // ── #56: work_log channel outbound allowlist enrichment ──

  it("includes the entity's #work-log channel as output-only in groups (#56)", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(
      make_registry({
        healthydogs: make_entity("healthydogs", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
          { type: "work_log", id: "work-log-chan" },
          { type: "work_room", id: "wr-chan" },
        ]),
      }),
    );

    await pool.test_write_access_json(tmp_dir, "wr-chan", "healthydogs");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    // Inbound channel: requireMention false (normal listening)
    expect(content.groups["wr-chan"]).toEqual({ requireMention: false, allowFrom: [] });
    // work_log channel: outbound-only — requireMention true so the activity feed
    // is never consumed as an input surface.
    expect(content.groups["work-log-chan"]).toEqual({ requireMention: true, allowFrom: [] });
    // alerts is also present and output-only — both broadcast surfaces.
    expect(content.groups["alerts-chan"]).toEqual({ requireMention: true, allowFrom: [] });
  });

  it("omits the work_log entry when the entity has no work_log channel (content entity) (#56)", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(
      make_registry({
        // Content-blueprint entities don't declare a work_log channel.
        somecontent: make_entity("somecontent", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
        ]),
      }),
    );

    await pool.test_write_access_json(tmp_dir, "general-chan", "somecontent");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(Object.keys(content.groups).sort()).toEqual(["alerts-chan", "general-chan"]);
  });

  it("does not duplicate an entry when the bot is bound directly to its #work-log channel (#56)", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(
      make_registry({
        healthydogs: make_entity("healthydogs", [{ type: "work_log", id: "work-log-chan" }]),
      }),
    );

    await pool.test_write_access_json(tmp_dir, "work-log-chan", "healthydogs");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    // The inbound entry wins — requireMention: false (no duplicate output entry).
    expect(content.groups["work-log-chan"]).toEqual({ requireMention: false, allowFrom: [] });
    expect(Object.keys(content.groups)).toEqual(["work-log-chan"]);
  });

  it("does not duplicate an entry when the bot is bound directly to its #alerts channel", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(
      make_registry({
        healthydogs: make_entity("healthydogs", [{ type: "alerts", id: "alerts-chan" }]),
      }),
    );

    await pool.test_write_access_json(tmp_dir, "alerts-chan", "healthydogs");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    // The inbound entry wins — keep requireMention: false so the bot listens
    expect(content.groups["alerts-chan"]).toEqual({
      requireMention: false,
      allowFrom: [],
    });
    expect(Object.keys(content.groups)).toEqual(["alerts-chan"]);
  });

  it("omits the alerts entry when the entity has no alerts channel configured", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(
      make_registry({
        healthydogs: make_entity("healthydogs", [{ type: "general", id: "general-chan" }]),
      }),
    );

    await pool.test_write_access_json(tmp_dir, "general-chan", "healthydogs");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(Object.keys(content.groups)).toEqual(["general-chan"]);
  });

  it("omits the alerts entry when the entity_id is unknown to the registry", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(make_registry({}));

    await pool.test_write_access_json(tmp_dir, "general-chan", "healthydogs");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(Object.keys(content.groups)).toEqual(["general-chan"]);
  });

  it("omits the alerts entry when entity_id is null (free or parked bot)", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    pool.set_registry(
      make_registry({
        healthydogs: make_entity("healthydogs", [{ type: "alerts", id: "alerts-chan" }]),
      }),
    );

    await pool.test_write_access_json(tmp_dir, null, null);

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.groups).toEqual({});
  });

  it("safely handles a missing registry (lookup returns null)", async () => {
    const config = make_config("111");
    const pool = new TestBotPool(config);
    // No registry injected — resolve_alerts_channel_id should short-circuit

    await pool.test_write_access_json(tmp_dir, "chan-1", "healthydogs");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(Object.keys(content.groups)).toEqual(["chan-1"]);
  });
});
