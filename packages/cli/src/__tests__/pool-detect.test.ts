import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check_pool_bots } from "../commands/init/detect.js";

describe("check_pool_bots", () => {
  let temp_dir: string;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "lf-pool-detect-"));
  });

  afterEach(async () => {
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("returns zero when no channels directory exists", async () => {
    const result = await check_pool_bots(temp_dir);
    expect(result.count).toBe(0);
    expect(result.indices).toEqual([]);
    expect(result.status).toBe("no pool bots configured");
  });

  it("returns zero when channels directory is empty", async () => {
    await mkdir(join(temp_dir, "channels"), { recursive: true });
    const result = await check_pool_bots(temp_dir);
    expect(result.count).toBe(0);
    expect(result.indices).toEqual([]);
  });

  it("detects pool bots with valid .env files", async () => {
    for (const i of [0, 1, 2]) {
      const dir = join(temp_dir, "channels", `pool-${String(i)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".env"), `DISCORD_BOT_TOKEN=fake-token-${String(i)}\n`);
    }

    const result = await check_pool_bots(temp_dir);
    expect(result.count).toBe(3);
    expect(result.indices).toEqual([0, 1, 2]);
    expect(result.status).toContain("3 pool bots configured");
  });

  it("skips pool directories without .env files", async () => {
    // pool-0 has a token, pool-1 does not
    const dir0 = join(temp_dir, "channels", "pool-0");
    await mkdir(dir0, { recursive: true });
    await writeFile(join(dir0, ".env"), "DISCORD_BOT_TOKEN=token0\n");

    const dir1 = join(temp_dir, "channels", "pool-1");
    await mkdir(dir1, { recursive: true });
    // No .env file

    const result = await check_pool_bots(temp_dir);
    expect(result.count).toBe(1);
    expect(result.indices).toEqual([0]);
  });

  it("skips .env files without DISCORD_BOT_TOKEN", async () => {
    const dir = join(temp_dir, "channels", "pool-0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".env"), "SOME_OTHER_VAR=value\n");

    const result = await check_pool_bots(temp_dir);
    expect(result.count).toBe(0);
    expect(result.indices).toEqual([]);
  });

  it("ignores non-pool directories in channels/", async () => {
    // pat directory should be ignored
    const pat_dir = join(temp_dir, "channels", "pat");
    await mkdir(pat_dir, { recursive: true });
    await writeFile(join(pat_dir, ".env"), "DISCORD_BOT_TOKEN=pat-token\n");

    const pool_dir = join(temp_dir, "channels", "pool-0");
    await mkdir(pool_dir, { recursive: true });
    await writeFile(join(pool_dir, ".env"), "DISCORD_BOT_TOKEN=pool-token\n");

    const result = await check_pool_bots(temp_dir);
    expect(result.count).toBe(1);
    expect(result.indices).toEqual([0]);
  });

  it("sorts indices numerically", async () => {
    for (const i of [5, 2, 8, 0]) {
      const dir = join(temp_dir, "channels", `pool-${String(i)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".env"), `DISCORD_BOT_TOKEN=token-${String(i)}\n`);
    }

    const result = await check_pool_bots(temp_dir);
    expect(result.indices).toEqual([0, 2, 5, 8]);
    expect(result.count).toBe(4);
  });

  it("returns correct status string for single bot", async () => {
    const dir = join(temp_dir, "channels", "pool-0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".env"), "DISCORD_BOT_TOKEN=token\n");

    const result = await check_pool_bots(temp_dir);
    expect(result.status).toBe("1 pool bot configured (LF-0)");
  });
});
