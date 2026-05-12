/**
 * Tests for `lf update`'s rebuild decision logic. The CLI action itself
 * shells out to git and pnpm, so we test the pure decision helpers
 * (`decide_rebuild`, `describe_rebuild_decision`) directly.
 */

import { describe, expect, it, vi } from "vitest";
import {
  decide_rebuild,
  describe_rebuild_decision,
  safe_check_dist_staleness,
} from "../commands/update.js";
import {
  DIST_INDEX_REL,
  DIST_SHA_STAMP_REL,
  type DistFsIo,
  type StalenessResult,
} from "../lib/dist-staleness.js";

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

describe("safe_check_dist_staleness", () => {
  const REPO = "/repo";
  const HEAD_SHA = "abcd1234abcd1234abcd1234abcd1234abcd1234";
  const HEAD_TIME = 1_700_000_000;

  /** Build a `DistFsIo` from per-method stubs, defaulting unused methods to throw. */
  function make_fs_io(overrides: Partial<DistFsIo>): DistFsIo {
    return {
      exists: overrides.exists ?? (() => false),
      mtime_seconds:
        overrides.mtime_seconds ??
        (() => {
          throw new Error("mtime_seconds not stubbed");
        }),
      read_text:
        overrides.read_text ??
        (() => {
          throw new Error("read_text not stubbed");
        }),
    };
  }

  it("falls back to stale + warns when .build-sha disappears between exists() and read_text() (TOCTOU)", () => {
    const sha_stamp_path = `${REPO}/${DIST_SHA_STAMP_REL}`;
    const dist_index_path = `${REPO}/${DIST_INDEX_REL}`;
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, open '.build-sha'"),
      {
        code: "ENOENT",
      },
    );
    const fs_io = make_fs_io({
      // Both dist/index.js and .build-sha report present...
      exists: (p) => p === dist_index_path || p === sha_stamp_path,
      // ...but the follow-up read_text races and throws ENOENT.
      read_text: () => {
        throw enoent;
      },
    });
    const warn = vi.fn();

    const result = safe_check_dist_staleness(REPO, HEAD_SHA, HEAD_TIME, fs_io, warn);

    expect(result).toEqual({
      stale: true,
      reason: "staleness check failed; rebuilding to be safe",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(enoent.message);
  });

  it("falls back to stale + warns when dist/index.js disappears between exists() and mtime_seconds() (TOCTOU)", () => {
    const sha_stamp_path = `${REPO}/${DIST_SHA_STAMP_REL}`;
    const dist_index_path = `${REPO}/${DIST_INDEX_REL}`;
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, stat 'dist/index.js'"),
      {
        code: "ENOENT",
      },
    );
    const fs_io = make_fs_io({
      // dist/index.js reports present; no SHA stamp → mtime fallback path.
      exists: (p) => p === dist_index_path && p !== sha_stamp_path,
      // ...then the stat for mtime races and throws ENOENT.
      mtime_seconds: () => {
        throw enoent;
      },
    });
    const warn = vi.fn();

    const result = safe_check_dist_staleness(REPO, HEAD_SHA, HEAD_TIME, fs_io, warn);

    expect(result).toEqual({
      stale: true,
      reason: "staleness check failed; rebuilding to be safe",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(enoent.message);
  });

  it("is transparent on the happy path — returns check_dist_staleness's result verbatim", () => {
    const sha_stamp_path = `${REPO}/${DIST_SHA_STAMP_REL}`;
    const dist_index_path = `${REPO}/${DIST_INDEX_REL}`;
    const fs_io = make_fs_io({
      exists: (p) => p === dist_index_path || p === sha_stamp_path,
      read_text: () => HEAD_SHA,
    });
    const warn = vi.fn();

    const result = safe_check_dist_staleness(REPO, HEAD_SHA, HEAD_TIME, fs_io, warn);

    expect(result).toEqual({
      stale: false,
      reason: `dist matches HEAD (${HEAD_SHA.slice(0, 8)})`,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
