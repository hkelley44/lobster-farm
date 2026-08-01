/**
 * Tests for GLOBAL category name matching (#99).
 *
 * The live guild stores the category as "Global" while every lookup compared
 * `=== "GLOBAL"`. Discord renders category names uppercase in the client, so
 * the two are indistinguishable in the UI and differ only over the API. Every
 * `#command-center` lookup returned null, which silently disabled the
 * commander's `mark_inbound()` — the only signal feeding the plugin-liveness
 * deaf-probe (#77/#78). #command-center sat dead for 14 days without a single
 * alert. These tests pin the case-insensitive match so it cannot regress.
 */

import { describe, expect, it } from "vitest";
import { GLOBAL_CATEGORY_NAME, is_global_category_name } from "../discord.js";

describe("is_global_category_name", () => {
  it("matches the scaffolded spelling", () => {
    expect(is_global_category_name("GLOBAL")).toBe(true);
  });

  it("matches the spelling actually on the live guild (#99 regression)", () => {
    // The exact byte sequence returned by the Discord API for category
    // 1487620599609036866's parent. This is the case that was broken.
    expect(is_global_category_name("Global")).toBe(true);
  });

  it("matches regardless of case", () => {
    for (const name of ["global", "GlObAl", "gLOBAL"]) {
      expect(is_global_category_name(name)).toBe(true);
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(is_global_category_name("  Global  ")).toBe(true);
  });

  it("does not match other categories", () => {
    // Real category names from the guild — none of these may match.
    for (const name of [
      "LobsterFarm",
      "HealthyDogs",
      "Text Channels",
      "Paragon MM",
      "Land Acquisition",
      "",
    ]) {
      expect(is_global_category_name(name)).toBe(false);
    }
  });

  it("does not match names that merely contain GLOBAL", () => {
    // Substring matching would wrongly claim these, re-breaking the lookup in
    // the opposite direction.
    for (const name of ["GLOBAL ARCHIVE", "not-global", "globals"]) {
      expect(is_global_category_name(name)).toBe(false);
    }
  });

  it("accepts the name it scaffolds with (create/find are symmetric)", () => {
    // scaffold_server() creates GLOBAL_CATEGORY_NAME and then finds it with
    // this predicate. If they ever disagree, scaffolding silently creates a
    // duplicate category on every run.
    expect(is_global_category_name(GLOBAL_CATEGORY_NAME)).toBe(true);
  });
});
