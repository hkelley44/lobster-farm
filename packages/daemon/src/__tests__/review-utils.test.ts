/**
 * Tests for findings-comment verdict detection helpers in review-utils.ts (#46).
 *
 * In single-dev repos GitHub blocks `gh pr review --approve` on self-authored
 * PRs, so Reviewer falls back to posting a regular comment whose first line is
 * `**Verdict: Approved**` or `**Verdict: Changes Requested**`. These helpers
 * give the daemon a way to read those comments and count cycles.
 *
 * External I/O (execFile) is mocked with the same promisify.custom shim as
 * actions.test.ts, so we can assert exactly which gh calls are made.
 */

import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module-level mocks ──

const exec_calls: Array<{
  command: string;
  args: string[];
  options?: Record<string, unknown>;
}> = [];

let exec_mock_impl: (
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

vi.mock("node:child_process", () => {
  const mock_exec_file = vi.fn(
    (
      cmd: string,
      args: string[],
      opts: Record<string, unknown> | undefined,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      exec_calls.push({ command: cmd, args, options: opts });
      if (typeof cb === "function") {
        exec_mock_impl(cmd, args, opts)
          .then(({ stdout, stderr }) => cb(null, stdout, stderr))
          .catch((err: Error) => cb(err, "", ""));
      }
    },
  );

  (mock_exec_file as unknown as { [k: symbol]: unknown })[promisify.custom] = (
    cmd: string,
    args: string[],
    opts?: Record<string, unknown>,
  ) => {
    exec_calls.push({ command: cmd, args, options: opts });
    return exec_mock_impl(cmd, args, opts);
  };

  return {
    execFile: mock_exec_file,
    exec: vi.fn(),
  };
});

// ── Imports (after mocks) ──

import {
  count_reviews_by_login,
  count_verdict_comments,
  detect_verdict_from_comments,
  get_authenticated_login,
} from "../review-utils.js";

// ── Helpers ──

interface Comment {
  body: string;
  createdAt: string;
  author: { login: string } | null;
}

/**
 * Configure the exec mock so that:
 *   - `gh api user` resolves to `login`
 *   - `gh pr view <n> --json comments` resolves to `comments` (JSON-encoded)
 *   - `gh pr view <n> --json reviews` resolves to `reviews` (JSON-encoded)
 */
function set_gh_responses(opts: {
  login?: string;
  comments?: Comment[];
  reviews?: Array<{ author: { login: string } | null; state?: string }>;
  comments_error?: Error;
  reviews_error?: Error;
  login_error?: Error;
}) {
  exec_mock_impl = async (_cmd, args) => {
    if (args[0] === "api" && args[1] === "user") {
      if (opts.login_error) throw opts.login_error;
      return { stdout: opts.login ?? "", stderr: "" };
    }
    if (args.includes("--json") && args.includes("comments")) {
      if (opts.comments_error) throw opts.comments_error;
      return { stdout: JSON.stringify(opts.comments ?? []), stderr: "" };
    }
    if (args.includes("--json") && args.includes("reviews")) {
      if (opts.reviews_error) throw opts.reviews_error;
      return { stdout: JSON.stringify(opts.reviews ?? []), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

const REPO = "/repos/test-repo";
const REVIEWER = "reviewer-bot";

beforeEach(() => {
  exec_calls.length = 0;
  exec_mock_impl = async () => ({ stdout: "", stderr: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── detect_verdict_from_comments ──

describe("detect_verdict_from_comments", () => {
  it("returns Approved when latest comment matches the approved prefix", async () => {
    set_gh_responses({
      comments: [
        {
          body: "**Verdict: Approved**\n\nLooks good!",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });

    const result = await detect_verdict_from_comments(42, REPO, REVIEWER);
    expect(result).toEqual({ verdict: "approved", created_at: "2026-05-09T10:00:00Z" });
  });

  it("returns Changes Requested when latest comment matches that prefix", async () => {
    set_gh_responses({
      comments: [
        {
          body: "**Verdict: Changes Requested**\n\nFix the foo.",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });

    const result = await detect_verdict_from_comments(42, REPO, REVIEWER);
    expect(result).toEqual({
      verdict: "changes_requested",
      created_at: "2026-05-09T10:00:00Z",
    });
  });

  it("returns null when no comment matches the verdict format", async () => {
    set_gh_responses({
      comments: [
        {
          body: "Just a regular comment, no verdict here.",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
        {
          body: "Verdict: Approved", // missing the bold markers
          createdAt: "2026-05-09T11:00:00Z",
          author: { login: REVIEWER },
        },
        {
          body: "  **Verdict: Approved**", // leading whitespace breaks the literal-first-line rule
          createdAt: "2026-05-09T12:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });

    const result = await detect_verdict_from_comments(42, REPO, REVIEWER);
    expect(result).toBeNull();
  });

  it("ignores comments authored by anyone other than the authenticated login", async () => {
    set_gh_responses({
      comments: [
        {
          body: "**Verdict: Approved**\n\nNot the bot.",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: "hkelley44" },
        },
        {
          body: "**Verdict: Changes Requested**\n\nAlso not the bot.",
          createdAt: "2026-05-09T11:00:00Z",
          author: null,
        },
      ],
    });

    const result = await detect_verdict_from_comments(42, REPO, REVIEWER);
    expect(result).toBeNull();
  });

  it("uses the most recent matching comment when multiple exist", async () => {
    set_gh_responses({
      comments: [
        // Older verdict — should NOT win.
        {
          body: "**Verdict: Changes Requested**\n\nFirst pass.",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
        // Newer verdict, flipping the call. Note: deliberately out of chronological
        // order in the array so we exercise the timestamp comparison, not array order.
        {
          body: "**Verdict: Approved**\n\nAfter the fix.",
          createdAt: "2026-05-09T12:00:00Z",
          author: { login: REVIEWER },
        },
        // Even newer human comment — but wrong author, must be filtered.
        {
          body: "**Verdict: Changes Requested**\n\nHuman noise.",
          createdAt: "2026-05-09T13:00:00Z",
          author: { login: "hkelley44" },
        },
      ],
    });

    const result = await detect_verdict_from_comments(42, REPO, REVIEWER);
    expect(result).toEqual({ verdict: "approved", created_at: "2026-05-09T12:00:00Z" });
  });

  it("returns null on gh CLI failure", async () => {
    set_gh_responses({ comments_error: new Error("gh: rate limited") });
    const result = await detect_verdict_from_comments(42, REPO, REVIEWER);
    expect(result).toBeNull();
  });
});

// ── get_authenticated_login ──

describe("get_authenticated_login", () => {
  it("returns the trimmed login from `gh api user`", async () => {
    set_gh_responses({ login: "reviewer-bot\n" });
    const login = await get_authenticated_login(REPO);
    expect(login).toBe("reviewer-bot");
  });

  it("returns null when `gh api user` fails", async () => {
    set_gh_responses({ login_error: new Error("gh: not authenticated") });
    const login = await get_authenticated_login(REPO);
    expect(login).toBeNull();
  });

  it("returns null when login is empty", async () => {
    set_gh_responses({ login: "" });
    const login = await get_authenticated_login(REPO);
    expect(login).toBeNull();
  });
});

// ── count_verdict_comments ──

describe("count_verdict_comments", () => {
  it("counts only verdict-prefixed comments by the authenticated login", async () => {
    set_gh_responses({
      comments: [
        {
          body: "**Verdict: Approved**",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
        {
          body: "**Verdict: Changes Requested**",
          createdAt: "2026-05-09T11:00:00Z",
          author: { login: REVIEWER },
        },
        {
          body: "**Verdict: Changes Requested**",
          createdAt: "2026-05-09T12:00:00Z",
          author: { login: "hkelley44" },
        },
        {
          body: "Not a verdict",
          createdAt: "2026-05-09T13:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });
    const n = await count_verdict_comments(42, REPO, REVIEWER);
    expect(n).toBe(2);
  });

  it("returns 0 on gh CLI failure", async () => {
    set_gh_responses({ comments_error: new Error("gh: boom") });
    const n = await count_verdict_comments(42, REPO, REVIEWER);
    expect(n).toBe(0);
  });
});

// ── count_reviews_by_login ──

describe("count_reviews_by_login", () => {
  it("counts only reviews authored by the given login", async () => {
    set_gh_responses({
      reviews: [
        { author: { login: REVIEWER }, state: "APPROVED" },
        { author: { login: REVIEWER }, state: "CHANGES_REQUESTED" },
        { author: { login: "external-contributor" }, state: "COMMENTED" },
        { author: null, state: "DISMISSED" },
      ],
    });
    const n = await count_reviews_by_login(42, REPO, REVIEWER);
    expect(n).toBe(2);
  });

  it("returns 0 on gh CLI failure", async () => {
    set_gh_responses({ reviews_error: new Error("gh: boom") });
    const n = await count_reviews_by_login(42, REPO, REVIEWER);
    expect(n).toBe(0);
  });
});
