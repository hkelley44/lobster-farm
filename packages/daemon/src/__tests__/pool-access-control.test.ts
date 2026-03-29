import { describe, expect, it, vi, beforeEach } from "vitest";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** Create a config with the given discord.user_id. */
function make_config(user_id?: string): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    discord: user_id
      ? { server_id: "111222333", user_id }
      : { server_id: "111222333" },
  });
}

/** Create a config with no discord section at all. */
function make_config_no_discord(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/**
 * Test subclass that exposes write_access_json for direct testing.
 * The real method is private, so we call it via bracket notation.
 */
class TestBotPool extends BotPool {
  async test_write_access_json(state_dir: string, channel_id: string | null): Promise<void> {
    // Call the private method via bracket notation
    return (this as unknown as { write_access_json: (d: string, c: string | null) => Promise<void> })
      .write_access_json(state_dir, channel_id);
  }
}

describe("pool bot access control", () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = join(tmpdir(), `pool-access-test-${randomUUID()}`);
    await mkdir(tmp_dir, { recursive: true });
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

    // Capture the console warning
    const warn_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pool.test_write_access_json(tmp_dir, "chan-123");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.allowFrom).toEqual([]);

    // Should have warned about missing user_id
    expect(warn_spy).toHaveBeenCalledWith(
      expect.stringContaining("discord.user_id not set"),
    );

    warn_spy.mockRestore();
  });

  it("writes empty allowFrom when discord section is absent", async () => {
    const config = make_config_no_discord();
    const pool = new TestBotPool(config);

    const warn_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pool.test_write_access_json(tmp_dir, null);

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.allowFrom).toEqual([]);
    expect(content.groups).toEqual({});

    warn_spy.mockRestore();
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
});
