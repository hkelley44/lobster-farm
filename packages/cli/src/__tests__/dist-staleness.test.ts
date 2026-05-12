/**
 * Tests for the dist-staleness detector. Uses a fake `DistFsIo` so we
 * don't need a real git repo or real files on disk.
 */

import { describe, expect, it } from "vitest";
import {
  DIST_INDEX_REL,
  DIST_SHA_STAMP_REL,
  type DistFsIo,
  check_dist_staleness,
} from "../lib/dist-staleness.js";

const REPO = "/fake/repo";
const DIST_INDEX = `${REPO}/${DIST_INDEX_REL}`;
const DIST_STAMP = `${REPO}/${DIST_SHA_STAMP_REL}`;

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Build a fake fs from a flat map of path → content/mtime. */
function fake_fs(files: Record<string, { content?: string; mtime_seconds?: number }>): DistFsIo {
  return {
    exists: (p) => Object.hasOwn(files, p),
    mtime_seconds: (p) => {
      const f = files[p];
      if (!f) throw new Error(`ENOENT (fake): ${p}`);
      if (f.mtime_seconds === undefined) {
        throw new Error(`Test fixture for ${p} has no mtime_seconds`);
      }
      return f.mtime_seconds;
    },
    read_text: (p) => {
      const f = files[p];
      if (!f) throw new Error(`ENOENT (fake): ${p}`);
      if (f.content === undefined) {
        throw new Error(`Test fixture for ${p} has no content`);
      }
      return f.content;
    },
  };
}

describe("check_dist_staleness", () => {
  it("returns stale when dist/index.js is missing", () => {
    const fs = fake_fs({}); // nothing exists
    const result = check_dist_staleness(REPO, SHA_A, 1_000_000, fs);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("not built");
  });

  it("returns fresh when SHA stamp matches HEAD", () => {
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 999_000 },
      [DIST_STAMP]: { content: `${SHA_A}\n` },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000_000, fs);
    expect(result.stale).toBe(false);
    expect(result.reason).toContain(SHA_A.slice(0, 8));
  });

  it("ignores mtime when SHA stamp is present and matches", () => {
    // Even with dist mtime ancient, a matching stamp wins.
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 1 },
      [DIST_STAMP]: { content: `${SHA_A}\n` },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000_000, fs);
    expect(result.stale).toBe(false);
  });

  it("returns stale when SHA stamp differs from HEAD (the branch-switch case)", () => {
    // dist was built recently from SHA_B; HEAD now points at SHA_A.
    // Without the SHA stamp, mtime alone would say "fresh" (it's newer
    // than HEAD's commit time). The stamp catches it.
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 2_000_000 },
      [DIST_STAMP]: { content: `${SHA_B}\n` },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000_000, fs);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain(SHA_B.slice(0, 8));
    expect(result.reason).toContain(SHA_A.slice(0, 8));
  });

  it("trims whitespace from the SHA stamp content", () => {
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 999_000 },
      [DIST_STAMP]: { content: `   ${SHA_A}\n\n` },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000_000, fs);
    expect(result.stale).toBe(false);
  });

  it("reports <empty> when SHA stamp file is empty", () => {
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 999_000 },
      [DIST_STAMP]: { content: "" },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000_000, fs);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("<empty>");
  });

  // Mtime fallback (no SHA stamp present) — only meaningful for forward HEAD moves.

  it("falls back to mtime: stale when dist mtime older than HEAD commit time", () => {
    // dist built at t=500, HEAD committed at t=1_000 (e.g. user ran `git
    // reset --hard origin/main` and dist hasn't caught up).
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 500 },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000, fs);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("mtime");
  });

  it("falls back to mtime: fresh when dist mtime newer than HEAD commit time", () => {
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 2_000 },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000, fs);
    expect(result.stale).toBe(false);
    expect(result.reason).toContain("mtime fallback");
  });

  it("treats mtime exactly equal to HEAD commit time as fresh", () => {
    // Built immediately after the commit landed. The mtime check uses
    // strict `<`, so equality is fresh — avoids spurious rebuilds in CI
    // where `git checkout` and `pnpm build` can happen in the same second.
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 1_000 },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000, fs);
    expect(result.stale).toBe(false);
  });

  it("treats sub-second-fresher mtime as fresh", () => {
    // Real-world: dist mtime is float (e.g. 1_000.345); HEAD commit time
    // is integer (e.g. 1_000). The float should beat the integer.
    const fs = fake_fs({
      [DIST_INDEX]: { mtime_seconds: 1_000.345 },
    });
    const result = check_dist_staleness(REPO, SHA_A, 1_000, fs);
    expect(result.stale).toBe(false);
  });
});
