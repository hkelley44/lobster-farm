/**
 * PR-reviews persistence hardening (#102 Gap 3).
 *
 * Two failures are pinned here:
 *   1. Tests leaked into live state — `pr-cron-lease.test.ts` built a config with
 *      no `paths` override, so `save_pr_reviews` wrote to the real
 *      `~/.lobsterfarm/state/pr-reviews.json` (the bogus `lobster-farm:6010` key).
 *      `save_pr_reviews` now throws under NODE_ENV=test when the resolved state
 *      root is the real home dir.
 *   2. The loader did zero validation. `load_pr_reviews` now sanitizes on load,
 *      dropping malformed / mismatched / unknown-entity entries and rewriting
 *      the file clean.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load_pr_reviews, sanitize_pr_reviews, save_pr_reviews } from "../persistence.js";

let ROOT: string;

function sandboxed_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: ROOT },
  });
}

function write_state(obj: unknown): string {
  const dir = join(ROOT, "state");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "pr-reviews.json");
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
  return path;
}

const valid_entry = (entity: string, pr: number) => ({
  entity_id: entity,
  pr_number: pr,
  reviewed_at: "2026-07-30T10:00:00Z",
  outcome: "approved" as const,
});

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "lf-pr-reviews-"));
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("sanitize_pr_reviews (#102 Gap 3)", () => {
  it("keeps well-formed entries untouched", () => {
    const { clean, dropped } = sanitize_pr_reviews({
      "alpha:1": valid_entry("alpha", 1),
      "beta:22": valid_entry("beta", 22),
    });
    expect(dropped).toEqual([]);
    expect(Object.keys(clean).sort()).toEqual(["alpha:1", "beta:22"]);
  });

  it("drops keys that aren't `<entity>:<pr_number>` shaped", () => {
    const { clean, dropped } = sanitize_pr_reviews({
      nocolon: valid_entry("nocolon", 1),
      "alpha:notanumber": valid_entry("alpha", 1),
      "alpha:1": valid_entry("alpha", 1),
    });
    expect(dropped.sort()).toEqual(["alpha:notanumber", "nocolon"]);
    expect(Object.keys(clean)).toEqual(["alpha:1"]);
  });

  it("drops entries whose embedded pr_number / entity_id disagree with the key", () => {
    const { clean, dropped } = sanitize_pr_reviews({
      "alpha:1": { ...valid_entry("alpha", 1), pr_number: 999 }, // number mismatch
      "beta:2": { ...valid_entry("gamma", 2) }, // entity mismatch
      "delta:3": valid_entry("delta", 3), // ok
    });
    expect(dropped.sort()).toEqual(["alpha:1", "beta:2"]);
    expect(Object.keys(clean)).toEqual(["delta:3"]);
  });

  it("drops unknown-entity entries only when a registry snapshot is supplied", () => {
    const data = {
      "alpha:1": valid_entry("alpha", 1),
      "lobster-farm:6010": valid_entry("lobster-farm", 6010),
    };
    // Without a registry: both structurally valid entries are kept.
    expect(sanitize_pr_reviews(data).dropped).toEqual([]);
    // With a registry that doesn't know "lobster-farm": that key is dropped.
    const { clean, dropped } = sanitize_pr_reviews(data, new Set(["alpha"]));
    expect(dropped).toEqual(["lobster-farm:6010"]);
    expect(Object.keys(clean)).toEqual(["alpha:1"]);
  });
});

describe("load_pr_reviews sanitizes on load (#102 Gap 3)", () => {
  it("drops a bogus lobster-farm:6010 fixture and rewrites the file clean", async () => {
    const path = write_state({
      "lobster-farm:6010": valid_entry("lobster-farm", 6010),
      "alpha:7": valid_entry("alpha", 7),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Registry knows only "alpha" — 6010's entity is unknown → dropped.
    const loaded = await load_pr_reviews(sandboxed_config(), new Set(["alpha"]));

    expect(loaded).toEqual({ "alpha:7": valid_entry("alpha", 7) });
    // The on-disk file was rewritten without the bogus key.
    const on_disk = JSON.parse(readFileSync(path, "utf-8"));
    expect(on_disk["lobster-farm:6010"]).toBeUndefined();
    expect(on_disk["alpha:7"]).toBeDefined();
    // Each dropped key is logged.
    expect(warn.mock.calls.flat().join(" ")).toContain("lobster-farm:6010");
  });

  it("returns {} and leaves nothing when the whole file is malformed entries", async () => {
    write_state({ garbage: 123, "no:": valid_entry("no", 1) });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await load_pr_reviews(sandboxed_config());
    expect(loaded).toEqual({});
  });

  it("does not rewrite when everything is already clean", async () => {
    const path = write_state({ "alpha:1": valid_entry("alpha", 1) });
    const before = readFileSync(path, "utf-8");

    const loaded = await load_pr_reviews(sandboxed_config(), new Set(["alpha"]));
    expect(loaded).toEqual({ "alpha:1": valid_entry("alpha", 1) });
    // File untouched (no dropped entries → no rewrite).
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

describe("save_pr_reviews refuses to write live state during tests (#102 Gap 3)", () => {
  it("throws when the config has no paths override (would hit real ~/.lobsterfarm)", async () => {
    // NODE_ENV is "test" under vitest. A config without a paths override resolves
    // to the real home state root — the exact leak that wrote lobster-farm:6010.
    expect(process.env.NODE_ENV).toBe("test");
    const unsafe = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
    await expect(save_pr_reviews({ "alpha:1": valid_entry("alpha", 1) }, unsafe)).rejects.toThrow(
      /Refusing to write/,
    );
  });

  it("writes fine to a sandboxed state root, leaving the real state file untouched", async () => {
    await save_pr_reviews({ "alpha:1": valid_entry("alpha", 1) }, sandboxed_config());
    expect(existsSync(join(ROOT, "state", "pr-reviews.json"))).toBe(true);
  });
});
