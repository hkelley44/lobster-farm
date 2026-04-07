import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prune_daily_logs } from "../memory-pruning.js";

// ── Helpers ──

/** Build a minimal config pointing at a temp lobsterfarm dir. */
function make_config(lf_dir: string): LobsterFarmConfig {
  return {
    paths: {
      lobsterfarm_dir: lf_dir,
      projects_dir: "/tmp",
      claude_dir: "/tmp",
    },
  } as LobsterFarmConfig;
}

/** Format a Date as YYYY-MM-DD. */
function fmt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Return a Date that is `days` days ago from now. */
function days_ago(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

// ── Test suite ──

describe("prune_daily_logs", () => {
  let tmp_dir: string;
  let entities_path: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), "lf-prune-"));
    entities_path = join(tmp_dir, "entities");
    await mkdir(entities_path);
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it("archives files older than 30 days", async () => {
    const daily = join(entities_path, "test-entity", "daily");
    await mkdir(daily, { recursive: true });

    const old_file = `${fmt(days_ago(45))}.md`;
    const new_file = `${fmt(days_ago(10))}.md`;

    await writeFile(join(daily, old_file), "old content");
    await writeFile(join(daily, new_file), "new content");

    await prune_daily_logs(make_config(tmp_dir));

    // Old file should be in archive/
    const archive = await readdir(join(daily, "archive"));
    expect(archive).toContain(old_file);

    // New file should still be in daily/
    const remaining = await readdir(daily);
    expect(remaining).toContain(new_file);
    expect(remaining).not.toContain(old_file);
  });

  it("leaves files 30 days old or younger untouched", async () => {
    const daily = join(entities_path, "test-entity", "daily");
    await mkdir(daily, { recursive: true });

    // Use 29 days to avoid boundary ambiguity from time-of-day offsets
    // (file dates are midnight UTC, but age is computed against current time)
    const recent_file = `${fmt(days_ago(29))}.md`;
    await writeFile(join(daily, recent_file), "recent");

    await prune_daily_logs(make_config(tmp_dir));

    const remaining = await readdir(daily);
    expect(remaining).toContain(recent_file);
  });

  it("creates archive/ directory if missing", async () => {
    const daily = join(entities_path, "test-entity", "daily");
    await mkdir(daily, { recursive: true });

    await writeFile(join(daily, `${fmt(days_ago(60))}.md`), "old");

    await prune_daily_logs(make_config(tmp_dir));

    const archive_entries = await readdir(join(daily, "archive"));
    expect(archive_entries.length).toBe(1);
  });

  it("is idempotent — running twice does not error", async () => {
    const daily = join(entities_path, "test-entity", "daily");
    await mkdir(daily, { recursive: true });

    const old_file = `${fmt(days_ago(45))}.md`;
    await writeFile(join(daily, old_file), "old");

    await prune_daily_logs(make_config(tmp_dir));
    // Second run: old_file is already in archive/, daily/ has no more old files
    await prune_daily_logs(make_config(tmp_dir));

    const archive = await readdir(join(daily, "archive"));
    expect(archive).toContain(old_file);
  });

  it("handles entity with no daily/ directory gracefully", async () => {
    // Entity dir exists but has no daily/ subdirectory
    await mkdir(join(entities_path, "empty-entity"), { recursive: true });

    // Should not throw
    await expect(prune_daily_logs(make_config(tmp_dir))).resolves.toBeUndefined();
  });

  it("handles missing entities directory gracefully", async () => {
    // Point at a config with a non-existent lobsterfarm dir
    const bad_config = make_config("/tmp/does-not-exist-lf-test");
    await expect(prune_daily_logs(bad_config)).resolves.toBeUndefined();
  });

  it("ignores non-date files in daily/", async () => {
    const daily = join(entities_path, "test-entity", "daily");
    await mkdir(daily, { recursive: true });

    await writeFile(join(daily, "notes.md"), "not a date file");
    await writeFile(join(daily, "2024-13-99.md"), "invalid date");

    await prune_daily_logs(make_config(tmp_dir));

    const remaining = await readdir(daily);
    expect(remaining).toContain("notes.md");
    expect(remaining).toContain("2024-13-99.md");
  });

  it("processes multiple entities independently", async () => {
    const daily_a = join(entities_path, "entity-a", "daily");
    const daily_b = join(entities_path, "entity-b", "daily");
    await mkdir(daily_a, { recursive: true });
    await mkdir(daily_b, { recursive: true });

    const old_file = `${fmt(days_ago(45))}.md`;
    const new_file = `${fmt(days_ago(5))}.md`;

    await writeFile(join(daily_a, old_file), "a-old");
    await writeFile(join(daily_a, new_file), "a-new");
    await writeFile(join(daily_b, old_file), "b-old");

    await prune_daily_logs(make_config(tmp_dir));

    // Entity A: old archived, new kept
    const archive_a = await readdir(join(daily_a, "archive"));
    expect(archive_a).toContain(old_file);
    const remaining_a = await readdir(daily_a);
    expect(remaining_a).toContain(new_file);

    // Entity B: old archived
    const archive_b = await readdir(join(daily_b, "archive"));
    expect(archive_b).toContain(old_file);
  });
});
