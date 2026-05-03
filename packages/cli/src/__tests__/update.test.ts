/**
 * Tests for `lf update`'s rebuild decision logic. The CLI action itself
 * shells out to git and pnpm, so we test the pure decision helpers
 * (`decide_rebuild`, `describe_rebuild_decision`) directly.
 */

import { describe, expect, it } from "vitest";
import { decide_rebuild, describe_rebuild_decision } from "../commands/update.js";
import type { StalenessResult } from "../lib/dist-staleness.js";

const FRESH: StalenessResult = { stale: false, reason: "dist matches HEAD (abcd1234)" };
const STALE: StalenessResult = {
  stale: true,
  reason: "dist built from deadbeef, HEAD is abcd1234",
};

describe("decide_rebuild", () => {
  it("rebuilds when commits were pulled, regardless of other signals", () => {
    expect(decide_rebuild({ pulled: true, force: false, staleness: FRESH }).kind).toBe("pulled");
    expect(decide_rebuild({ pulled: true, force: true, staleness: STALE }).kind).toBe("pulled");
  });

  it("rebuilds via --force when no pull was needed but force is set", () => {
    expect(decide_rebuild({ pulled: false, force: true, staleness: FRESH }).kind).toBe("force");
  });

  it("rebuilds via staleness when dist is out of sync but no pull / no force", () => {
    const result = decide_rebuild({ pulled: false, force: false, staleness: STALE });
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") {
      expect(result.detail).toContain("deadbeef");
    }
  });

  it("short-circuits as 'fresh' when nothing changed and dist is in sync", () => {
    expect(decide_rebuild({ pulled: false, force: false, staleness: FRESH }).kind).toBe("fresh");
  });

  it("prioritises pulled over stale (pulled implies stale anyway, but keeps logs clear)", () => {
    expect(decide_rebuild({ pulled: true, force: false, staleness: STALE }).kind).toBe("pulled");
  });

  it("prioritises force over stale when no pull happened", () => {
    expect(decide_rebuild({ pulled: false, force: true, staleness: STALE }).kind).toBe("force");
  });
});

describe("describe_rebuild_decision", () => {
  it("force message mentions --force", () => {
    expect(describe_rebuild_decision({ kind: "force" })).toContain("--force");
  });

  it("pulled message mentions pulled commits", () => {
    expect(describe_rebuild_decision({ kind: "pulled" })).toContain("pulled");
  });

  it("stale message embeds the staleness reason verbatim", () => {
    const msg = describe_rebuild_decision({
      kind: "stale",
      detail: "dist mtime 500 older than HEAD commit time 1000",
    });
    expect(msg).toContain("dist stale");
    expect(msg).toContain("dist mtime 500 older than HEAD commit time 1000");
  });

  it("fresh message reads as the legacy 'Already up to date' line", () => {
    expect(describe_rebuild_decision({ kind: "fresh" })).toBe("Already up to date.");
  });
});
