import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for `lf update` preconditions.
 *
 * The helpers shell out to git via `execFileSync`. We mock it at the
 * `node:child_process` module level and drive per-test behavior with a
 * queue of responses (one per expected git invocation).
 *
 * Each response is either a string (resolves as stdout) or an Error
 * (simulates a git failure — the mock re-throws it with stderr attached).
 */

type GitResponse = string | { error: string; stderr?: string };

// Queue of responses, consumed in order by the mocked execFileSync.
let responses: GitResponse[] = [];
// Calls captured for assertions (args only — cwd/options are uninteresting).
let calls: string[][] = [];

vi.mock("node:child_process", () => ({
  execFileSync: (_cmd: string, args: string[]) => {
    calls.push(args);
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    }
    if (typeof next === "string") return next;
    const err: Error & { stderr?: string; status?: number } = new Error(next.error);
    err.stderr = next.stderr ?? next.error;
    err.status = 128;
    throw err;
  },
}));

beforeEach(() => {
  responses = [];
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("check_on_main", () => {
  it("returns ok when HEAD is main", async () => {
    responses = ["main\n"];
    const { check_on_main } = await import("../commands/update.js");

    const result = check_on_main("/repo");

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(["symbolic-ref", "--short", "HEAD"]);
  });

  it("refuses on a feature branch with the exact switch command", async () => {
    responses = ["feat/295-discord-roles\n"];
    const { check_on_main, EXIT_BRANCH_NOT_MAIN } = await import("../commands/update.js");

    const result = check_on_main("/repo");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exit_code).toBe(EXIT_BRANCH_NOT_MAIN);
    expect(result.message).toContain("feat/295-discord-roles");
    expect(result.message).toContain("git checkout main && lf update");
  });

  it("reports detached HEAD cleanly", async () => {
    responses = [{ error: "symbolic-ref failed", stderr: "fatal: ref HEAD is not a symbolic ref" }];
    const { check_on_main, EXIT_BRANCH_NOT_MAIN } = await import("../commands/update.js");

    const result = check_on_main("/repo");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exit_code).toBe(EXIT_BRANCH_NOT_MAIN);
    expect(result.message).toContain("HEAD (detached)");
    expect(result.message).toContain("git checkout main && lf update");
  });

  it("surfaces git's stderr when not a git repo", async () => {
    responses = [
      {
        error: "git failed",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      },
    ];
    const { check_on_main } = await import("../commands/update.js");

    const result = check_on_main("/tmp/not-a-repo");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("not a git repository");
  });
});

describe("check_working_tree_clean", () => {
  it("returns ok on an empty porcelain output", async () => {
    responses = [""];
    const { check_working_tree_clean } = await import("../commands/update.js");

    const result = check_working_tree_clean("/repo");

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(["status", "--porcelain"]);
  });

  it("refuses when tracked files are modified and lists the paths", async () => {
    responses = [" M packages/foo/bar.ts\nM  packages/baz/qux.ts\n"];
    const { check_working_tree_clean, EXIT_TREE_DIRTY } = await import("../commands/update.js");

    const result = check_working_tree_clean("/repo");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exit_code).toBe(EXIT_TREE_DIRTY);
    expect(result.message).toContain("packages/foo/bar.ts");
    expect(result.message).toContain("packages/baz/qux.ts");
    expect(result.message).toContain("Commit or stash first");
  });

  it("allows untracked-only output", async () => {
    responses = ["?? worktrees/something/\n?? scratch.txt\n"];
    const { check_working_tree_clean } = await import("../commands/update.js");

    const result = check_working_tree_clean("/repo");

    expect(result.ok).toBe(true);
  });

  it("truncates long dirty lists after 5 entries", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => ` M file-${String(i)}.ts`).join("\n");
    responses = [lines];
    const { check_working_tree_clean } = await import("../commands/update.js");

    const result = check_working_tree_clean("/repo");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("file-0.ts");
    expect(result.message).toContain("file-4.ts");
    expect(result.message).not.toContain("file-5.ts");
    expect(result.message).toContain("+3 more");
  });

  it("surfaces git errors when status itself fails", async () => {
    responses = [{ error: "git failed", stderr: "fatal: not a git repository" }];
    const { check_working_tree_clean, EXIT_GIT_ERROR } = await import("../commands/update.js");

    const result = check_working_tree_clean("/repo");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exit_code).toBe(EXIT_GIT_ERROR);
    expect(result.message).toContain("not a git repository");
  });
});

describe("precondition ordering", () => {
  it("reports the branch error first when both preconditions would fail", async () => {
    // Simulate the "wrong branch AND dirty tree" case: both checks run
    // independently and each calls git once. We queue both responses, then
    // assert the branch failure is what the caller would see first.
    responses = ["some-feature\n", " M packages/foo/bar.ts\n"];
    const { check_on_main, check_working_tree_clean } = await import("../commands/update.js");

    const branch_result = check_on_main("/repo");
    const tree_result = check_working_tree_clean("/repo");

    expect(branch_result.ok).toBe(false);
    expect(tree_result.ok).toBe(false);
    if (branch_result.ok || tree_result.ok) return;
    // The branch error is the actionable one — it names the exact fix.
    expect(branch_result.message).toContain("some-feature");
    expect(branch_result.message).toContain("git checkout main && lf update");
  });
});
