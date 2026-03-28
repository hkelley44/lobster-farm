import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extract_linked_issues,
  extract_first_linked_issue,
  close_linked_issues,
  nwo_from_url,
} from "../issue-utils.js";

// ── extract_linked_issues ──

describe("extract_linked_issues", () => {
  it("extracts Closes #N from body", () => {
    expect(extract_linked_issues("Closes #42", null)).toEqual([42]);
  });

  it("extracts Fixes #N from body", () => {
    expect(extract_linked_issues("Fixes #10", null)).toEqual([10]);
  });

  it("extracts Resolves #N from body", () => {
    expect(extract_linked_issues("Resolves #99", null)).toEqual([99]);
  });

  it("is case-insensitive", () => {
    expect(extract_linked_issues("CLOSES #5\nfixes #6\nResolves #7", null)).toEqual([5, 6, 7]);
  });

  it("extracts multiple linked issues from body", () => {
    expect(extract_linked_issues("Closes #10\nFixes #20\nResolves #30", null)).toEqual([10, 20, 30]);
  });

  it("extracts #N from title", () => {
    expect(extract_linked_issues(null, "feat: add foo (#42)")).toEqual([42]);
  });

  it("deduplicates issues found in both body and title", () => {
    expect(extract_linked_issues("Closes #42", "feat: add foo (#42)")).toEqual([42]);
  });

  it("combines body and title issues", () => {
    const result = extract_linked_issues("Closes #10", "feat: add foo (#42)");
    expect(result).toContain(10);
    expect(result).toContain(42);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no issues found", () => {
    expect(extract_linked_issues("No issues here", "plain title")).toEqual([]);
  });

  it("returns empty array for null body and title", () => {
    expect(extract_linked_issues(null, null)).toEqual([]);
  });

  it("handles body with non-keyword hash references", () => {
    // "#N" without Closes/Fixes/Resolves prefix should NOT match in body
    expect(extract_linked_issues("Related to #42", null)).toEqual([]);
  });
});

// ── extract_first_linked_issue ──

describe("extract_first_linked_issue", () => {
  it("returns first matched issue number", () => {
    expect(extract_first_linked_issue("Closes #42\nFixes #99")).toBe(42);
  });

  it("returns null for null body", () => {
    expect(extract_first_linked_issue(null)).toBeNull();
  });

  it("returns null when no keyword match", () => {
    expect(extract_first_linked_issue("No issues here")).toBeNull();
  });
});

// ── nwo_from_url ──

describe("nwo_from_url", () => {
  it("parses HTTPS URL", () => {
    expect(nwo_from_url("https://github.com/ultim88888888/lobster-farm.git")).toBe("ultim88888888/lobster-farm");
  });

  it("parses SSH URL", () => {
    expect(nwo_from_url("git@github.com:ultim88888888/lobster-farm.git")).toBe("ultim88888888/lobster-farm");
  });

  it("handles URL without .git suffix", () => {
    expect(nwo_from_url("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("returns undefined for non-GitHub URL", () => {
    expect(nwo_from_url("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });
});

// ── close_linked_issues ──

describe("close_linked_issues", () => {
  let fetch_spy: ReturnType<typeof vi.spyOn>;
  let warn_spy: ReturnType<typeof vi.spyOn>;
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetch_spy = vi.spyOn(globalThis, "fetch");
    warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    fetch_spy.mockRestore();
    warn_spy.mockRestore();
    log_spy.mockRestore();
  });

  it("returns empty array when no issues provided", async () => {
    const results = await close_linked_issues("owner/repo", 1, [], "token");
    expect(results).toEqual([]);
    expect(fetch_spy).not.toHaveBeenCalled();
  });

  it("comments and closes each issue", async () => {
    fetch_spy.mockResolvedValue(new Response("{}", { status: 200 }));

    const results = await close_linked_issues("owner/repo", 42, [10, 20], "ghs_token");

    // 2 issues x 2 API calls each (comment + close)
    expect(fetch_spy).toHaveBeenCalledTimes(4);

    // First issue: comment
    expect(fetch_spy).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/owner/repo/issues/10/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "Closed by #42." }),
      }),
    );

    // First issue: close
    expect(fetch_spy).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/owner/repo/issues/10",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      }),
    );

    expect(results).toEqual([
      { issue_number: 10, success: true },
      { issue_number: 20, success: true },
    ]);
  });

  it("uses the installation token in Authorization header", async () => {
    fetch_spy.mockResolvedValue(new Response("{}", { status: 200 }));

    await close_linked_issues("owner/repo", 42, [10], "ghs_test_token");

    for (const call of fetch_spy.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer ghs_test_token");
    }
  });

  it("continues to close even if commenting fails", async () => {
    fetch_spy
      .mockResolvedValueOnce(new Response("Not found", { status: 404 })) // comment fails
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // close succeeds

    const results = await close_linked_issues("owner/repo", 42, [10], "token");

    expect(results).toEqual([{ issue_number: 10, success: true }]);
    expect(warn_spy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to comment on issue #10"),
    );
  });

  it("reports failure when close API returns error", async () => {
    fetch_spy
      .mockResolvedValueOnce(new Response("{}", { status: 200 })) // comment succeeds
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 })); // close fails

    const results = await close_linked_issues("owner/repo", 42, [10], "token");

    expect(results).toEqual([
      { issue_number: 10, success: false, error: "403 Forbidden" },
    ]);
  });

  it("handles fetch throwing an exception", async () => {
    fetch_spy.mockRejectedValue(new Error("Network error"));

    const results = await close_linked_issues("owner/repo", 42, [10], "token");

    expect(results).toEqual([
      { issue_number: 10, success: false, error: expect.stringContaining("Network error") },
    ]);
  });

  it("does not throw even when all issues fail", async () => {
    fetch_spy.mockRejectedValue(new Error("timeout"));

    const results = await close_linked_issues("owner/repo", 42, [10, 20], "token");

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.success)).toBe(true);
  });
});
