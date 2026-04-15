/**
 * Tests for Sentry alert formatting + in-memory issue details cache (#259).
 *
 * Covers:
 * - format_sentry_alert(): all fields present → full 5-line layout
 * - format_sentry_alert(): missing release, missing stack frame, missing culprit
 * - format_sentry_alert(): level → emoji mapping (fatal/error/warning/other)
 * - format_sentry_alert(): action prefix for resolved/unresolved events
 * - format_sentry_alert_minimal(): fallback format when enrichment fails
 * - relative_time(): formats seconds/minutes/hours/days ago
 * - extract_top_app_frame(): prefers in-app frames, handles missing data
 * - get_cached_issue_details(): cache hit within TTL
 * - get_cached_issue_details(): concurrent callers share one in-flight fetch
 * - get_cached_issue_details(): TTL expiry triggers refetch
 * - get_cached_issue_details(): error is not cached
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _reset_cache_for_test,
  extract_top_app_frame,
  format_sentry_alert,
  format_sentry_alert_minimal,
  get_cached_issue_details,
  relative_time,
} from "../sentry-alert-format.js";
import type { SentryIssueDetails } from "../sentry-api.js";

// ── Fixture helpers ──

function make_details(overrides: Partial<SentryIssueDetails> = {}): SentryIssueDetails {
  return {
    title: "TimeoutError: request timed out",
    culprit: "asyncpg.pool.close",
    level: "error",
    count: "8",
    first_seen: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
    last_seen: new Date().toISOString(),
    platform: "python",
    short_id: "SONAR-BACKEND-A7K",
    web_url: "https://ultim8.sentry.io/issues/7409847425/",
    tags: [
      { key: "environment", value: "production" },
      { key: "release", value: "a7b3c9d4e5f6" },
    ],
    stack_trace: "TimeoutError: request timed out\n  at cleanup (apps/backend/src/db/pool.py:142)",
    top_frame: null,
    contexts: {},
    ...overrides,
  };
}

// ── format_sentry_alert ──

describe("format_sentry_alert", () => {
  it("renders full 5-line layout when all fields are present", () => {
    const alert = format_sentry_alert({
      action: "created",
      short_id: "SONAR-BACKEND-A7K",
      project_slug: "sonar-backend",
      details: make_details(),
      top_frame: {
        filename: "apps/backend/src/db/pool.py",
        lineno: 142,
        function: "cleanup",
      },
    });

    const lines = alert.split("\n");
    expect(lines[0]).toBe("⚠️ Sentry [error]: TimeoutError: request timed out");
    expect(lines[1]).toBe("SONAR-BACKEND-A7K · sonar-backend · release a7b3c9d");
    expect(lines[2]).toMatch(/^asyncpg\.pool\.close {2}\(8 events, first \d+[smhd] ago\)$/);
    expect(lines[3]).toBe("→ apps/backend/src/db/pool.py:142 cleanup()");
    expect(lines[4]).toBe("https://ultim8.sentry.io/issues/7409847425/");
  });

  it("uses 🔥 for fatal, ⚠️ for error, ℹ️ for warning, no emoji otherwise", () => {
    const base = {
      action: "created",
      short_id: "S-1",
      project_slug: "p",
      top_frame: null,
    };
    expect(
      format_sentry_alert({ ...base, details: make_details({ level: "fatal" }) }).split("\n")[0],
    ).toMatch(/^🔥 Sentry \[fatal\]/);
    expect(
      format_sentry_alert({ ...base, details: make_details({ level: "error" }) }).split("\n")[0],
    ).toMatch(/^⚠️ Sentry \[error\]/);
    expect(
      format_sentry_alert({ ...base, details: make_details({ level: "warning" }) }).split("\n")[0],
    ).toMatch(/^ℹ️ Sentry \[warning\]/);
    expect(
      format_sentry_alert({ ...base, details: make_details({ level: "info" }) }).split("\n")[0],
    ).toBe("Sentry [info]: TimeoutError: request timed out");
  });

  it("omits release token when release tag is missing", () => {
    const alert = format_sentry_alert({
      action: "created",
      short_id: "S-1",
      project_slug: "sonar-backend",
      details: make_details({ tags: [{ key: "environment", value: "production" }] }),
      top_frame: null,
    });
    const meta_line = alert.split("\n")[1];
    expect(meta_line).toBe("S-1 · sonar-backend");
  });

  it("omits short_id token when shortId is missing", () => {
    const alert = format_sentry_alert({
      action: "created",
      short_id: null,
      project_slug: "sonar-backend",
      details: make_details({ tags: [{ key: "release", value: "abc1234567" }] }),
      top_frame: null,
    });
    const meta_line = alert.split("\n")[1];
    expect(meta_line).toBe("sonar-backend · release abc1234");
  });

  it("omits stack-frame line when top_frame is null", () => {
    const alert = format_sentry_alert({
      action: "created",
      short_id: "S-1",
      project_slug: "sonar-backend",
      details: make_details(),
      top_frame: null,
    });
    const lines = alert.split("\n");
    expect(lines).toHaveLength(4); // header, meta, culprit, url
    expect(lines[3]).toBe("https://ultim8.sentry.io/issues/7409847425/");
  });

  it("omits culprit line entirely when culprit is empty and count is 0", () => {
    const alert = format_sentry_alert({
      action: "created",
      short_id: "S-1",
      project_slug: "sonar-backend",
      details: make_details({ culprit: "", count: "0", first_seen: "" }),
      top_frame: null,
    });
    const lines = alert.split("\n");
    // header, meta, url — no culprit line, no stack line
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("https://ultim8.sentry.io/issues/7409847425/");
  });

  it("prefixes 'Resolved' instead of 'Sentry' for resolved action", () => {
    const alert = format_sentry_alert({
      action: "resolved",
      short_id: "S-1",
      project_slug: "sonar-backend",
      details: make_details(),
      top_frame: null,
    });
    expect(alert.split("\n")[0]).toMatch(/^⚠️ Resolved \[error\]:/);
  });
});

// ── format_sentry_alert_minimal ──

describe("format_sentry_alert_minimal", () => {
  it("renders the legacy fallback format", () => {
    const alert = format_sentry_alert_minimal({
      action: "created",
      error_title: "TimeoutError",
      project_slug: "sonar-backend",
      issue_url: "https://ultim8.sentry.io/issues/1/",
    });
    expect(alert).toBe(
      "Sentry: TimeoutError\nProject: sonar-backend\nhttps://ultim8.sentry.io/issues/1/",
    );
  });

  it("uses Resolved prefix and includes action label for unresolved", () => {
    expect(
      format_sentry_alert_minimal({
        action: "resolved",
        error_title: "T",
        project_slug: "p",
        issue_url: "u",
      }),
    ).toBe("Resolved: T\nProject: p\nu");

    expect(
      format_sentry_alert_minimal({
        action: "unresolved",
        error_title: "T",
        project_slug: "p",
        issue_url: "u",
      }),
    ).toBe("Sentry [unresolved]: T\nProject: p\nu");
  });
});

// ── relative_time ──

describe("relative_time", () => {
  const now = new Date("2026-04-15T12:00:00Z").getTime();

  it("formats seconds ago", () => {
    expect(relative_time(new Date(now - 30_000).toISOString(), now)).toBe("30s");
  });

  it("formats minutes ago", () => {
    expect(relative_time(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m");
  });

  it("formats hours ago", () => {
    expect(relative_time(new Date(now - 3 * 3600_000).toISOString(), now)).toBe("3h");
  });

  it("formats days ago", () => {
    expect(relative_time(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d");
  });

  it("returns empty string for invalid input", () => {
    expect(relative_time("", now)).toBe("");
    expect(relative_time("not-a-date", now)).toBe("");
  });
});

// ── extract_top_app_frame ──

describe("extract_top_app_frame", () => {
  it("returns the innermost in-app frame from the first exception", () => {
    const event = {
      exception: {
        values: [
          {
            type: "TimeoutError",
            value: "request timed out",
            stacktrace: {
              frames: [
                { filename: "vendor/lib.py", lineNo: 99, function: "vendor_fn", inApp: false },
                {
                  filename: "apps/backend/src/db/pool.py",
                  lineNo: 142,
                  function: "cleanup",
                  inApp: true,
                },
                // Innermost-last per Sentry convention
                { filename: "stdlib/socket.py", lineNo: 1, function: "recv", inApp: false },
              ],
            },
          },
        ],
      },
    };
    const frame = extract_top_app_frame(event);
    expect(frame).toEqual({
      filename: "apps/backend/src/db/pool.py",
      lineno: 142,
      function: "cleanup",
    });
  });

  it("falls back to any frame if no in-app frames are marked", () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: "a.py", lineNo: 1, function: "f" }],
            },
          },
        ],
      },
    };
    expect(extract_top_app_frame(event)).toEqual({
      filename: "a.py",
      lineno: 1,
      function: "f",
    });
  });

  it("returns null when event has no exception frames", () => {
    expect(extract_top_app_frame({})).toBeNull();
    expect(extract_top_app_frame({ exception: { values: [] } })).toBeNull();
    expect(
      extract_top_app_frame({
        exception: { values: [{ stacktrace: { frames: [] } }] },
      }),
    ).toBeNull();
  });
});

// ── get_cached_issue_details ──

describe("get_cached_issue_details", () => {
  beforeEach(() => {
    _reset_cache_for_test();
  });

  afterEach(() => {
    _reset_cache_for_test();
  });

  it("caches within TTL — second call does not re-fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue(make_details());

    const a = await get_cached_issue_details("issue-1", fetcher);
    const b = await get_cached_issue_details("issue-1", fetcher);

    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent callers — both share one in-flight promise", async () => {
    let resolve_inner: ((v: SentryIssueDetails) => void) | null = null;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<SentryIssueDetails>((r) => {
          resolve_inner = r;
        }),
    );

    const p1 = get_cached_issue_details("issue-1", fetcher);
    const p2 = get_cached_issue_details("issue-1", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve_inner?.(make_details());
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
  });

  it("re-fetches after TTL expiry", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(make_details());

    await get_cached_issue_details("issue-1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance beyond the 30s TTL
    vi.advanceTimersByTime(31_000);

    await get_cached_issue_details("issue-1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("does not cache a rejected promise", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("sentry 500"))
      .mockResolvedValueOnce(make_details());

    await expect(get_cached_issue_details("issue-1", fetcher)).rejects.toThrow("sentry 500");
    // Failed fetches must not poison the cache — the next call should retry
    await expect(get_cached_issue_details("issue-1", fetcher)).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
