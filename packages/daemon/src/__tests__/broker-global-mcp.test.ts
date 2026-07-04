import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotPool } from "../pool.js";

/**
 * Finding #2: under `--strict-mcp-config` the shim's broker-mcp.json is the ONLY
 * MCP config loaded, so a plugin-path session's global `mcpServers` (e.g.
 * playwright) would be dropped. `read_global_mcp_servers` reads them back from
 * the resolved `.claude.json` so a broker session keeps the same server set.
 * These tests exercise that reader directly (it's the load-bearing half of the
 * merge; the overlay itself is a plain object spread).
 */

// Expose the protected reader.
class TestPool extends BotPool {
  read_global(config_dir: string | null): Promise<Record<string, unknown>> {
    return this.read_global_mcp_servers(config_dir);
  }
}

let dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: dir },
  });
}

describe("read_global_mcp_servers", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "broker-global-mcp-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the global mcpServers block from <config_dir>/.claude.json", async () => {
    await writeFile(
      join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp"] },
        },
        somethingElse: true,
      }),
      "utf-8",
    );
    const pool = new TestPool(make_config());
    const servers = await pool.read_global(dir);
    expect(servers).toEqual({ playwright: { command: "npx", args: ["@playwright/mcp"] } });
  });

  it("merges global servers under the shim key with the shim winning (parity contract)", async () => {
    // Demonstrate the actual merge shape prepare_broker_session builds: globals
    // first, shim overlaid last so it wins even if a stale discord key exists.
    await writeFile(
      join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx" },
          plugin_discord_discord: { command: "STALE" },
        },
      }),
      "utf-8",
    );
    const pool = new TestPool(make_config());
    const globals = await pool.read_global(dir);
    const shim = { command: "node", args: ["shim.js"] };
    const merged = { ...globals, plugin_discord_discord: shim };
    // playwright preserved; the shim overrides the stale discord entry.
    expect(merged.playwright).toEqual({ command: "npx" });
    expect(merged.plugin_discord_discord).toBe(shim);
  });

  it("fails open to {} when the config file is missing", async () => {
    const pool = new TestPool(make_config());
    expect(await pool.read_global(dir)).toEqual({});
  });

  it("fails open to {} when the config file is corrupt", async () => {
    await writeFile(join(dir, ".claude.json"), "{ not json", "utf-8");
    const pool = new TestPool(make_config());
    expect(await pool.read_global(dir)).toEqual({});
  });

  it("returns {} when the config has no mcpServers block", async () => {
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ other: 1 }), "utf-8");
    const pool = new TestPool(make_config());
    expect(await pool.read_global(dir)).toEqual({});
  });
});
