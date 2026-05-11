/**
 * Tests for actions.ts — core git, GitHub, and Discord operations.
 *
 * All external I/O (execFile, exec, rm, fs, Discord, Sentry) is mocked.
 * Uses promisify.custom on the mocked execFile so that promisify(execFile)
 * returns { stdout, stderr } directly — matching Node's native behavior.
 */

import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module-level mocks ──

// Track calls to the promisified execFile
const exec_calls: Array<{
  command: string;
  args: string[];
  options?: Record<string, unknown>;
}> = [];

// Default resolved stdout — tests can override via exec_mock_impl
let exec_mock_impl: (
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

vi.mock("node:child_process", () => {
  // execFile needs a custom promisify symbol so that promisify(execFile)
  // returns { stdout, stderr } instead of trying the callback pattern.
  // Without this, the promisified version can't find stdout on the result.
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

  // Attach the custom promisify implementation so promisify(execFile)
  // returns a function that resolves to { stdout, stderr } directly
  (mock_exec_file as any)[promisify.custom] = (
    cmd: string,
    args: string[],
    opts?: Record<string, unknown>,
  ) => {
    exec_calls.push({ command: cmd, args, options: opts });
    return exec_mock_impl(cmd, args, opts);
  };

  const mock_exec = vi.fn(
    (
      cmd: string,
      opts: Record<string, unknown> | undefined,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      exec_calls.push({ command: "shell", args: [cmd], options: opts });
      if (typeof cb === "function") {
        cb(null, "", "");
      }
    },
  );

  (mock_exec as any)[promisify.custom] = (cmd: string, opts?: Record<string, unknown>) => {
    exec_calls.push({ command: "shell", args: [cmd], options: opts });
    return Promise.resolve({ stdout: "", stderr: "" });
  };

  return {
    execFile: mock_exec_file,
    exec: mock_exec,
  };
});

let rm_calls: Array<{ path: string; options: Record<string, unknown> }> = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(async (path: string, opts: Record<string, unknown>) => {
      rm_calls.push({ path, options: opts });
    }),
  };
});

vi.mock("@lobster-farm/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lobster-farm/shared")>();
  return {
    ...actual,
    expand_home: vi.fn((p: string) => p.replace("~", "/home/test")),
    entity_config_path: vi.fn(
      (_config: unknown, entity_id: string) =>
        `/home/test/.lobsterfarm/entities/${entity_id}/config.yaml`,
    ),
    write_yaml: vi.fn(async () => {}),
  };
});

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("../discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../discord.js")>();
  return {
    ...actual,
    is_discord_snowflake: actual.is_discord_snowflake,
  };
});

// ── Import after mocks ──

import type { ChannelMapping, EntityConfig } from "@lobster-farm/shared";
import {
  type FeatureData,
  assign_work_room,
  classify_merge_error,
  cleanup_worktree,
  create_pr,
  create_worktree,
  detect_review_outcome,
  merge_pr,
  notify,
  release_work_room,
  run_tests,
  set_discord_bot,
  set_pool,
} from "../actions.js";
import * as sentry from "../sentry.js";

// ── Test helpers ──

function make_feature(overrides: Partial<FeatureData> = {}): FeatureData {
  return {
    id: "test-feature-1",
    entity: "test-entity",
    githubIssue: 42,
    title: "Add widget support",
    branch: "feature/42-widget",
    worktreePath: null,
    discordWorkRoom: null,
    activeArchetype: null,
    prNumber: null,
    ...overrides,
  };
}

function make_entity_config(
  overrides: Partial<{
    id: string;
    repos: Array<{ path: string; url: string; name: string }>;
    channels: {
      category_id: string;
      list: ChannelMapping[];
    };
  }> = {},
): EntityConfig {
  return {
    entity: {
      id: overrides.id ?? "test-entity",
      name: overrides.id ?? "test-entity",
      repos: overrides.repos ?? [
        {
          name: "test-repo",
          url: "https://github.com/test-org/test-repo.git",
          path: "/repos/test-repo",
        },
      ],
      channels: overrides.channels ?? {
        category_id: "cat-123",
        list: [],
      },
      memory: { path: "/tmp/test-memory" },
      secrets: { vault_name: "entity-test" },
    },
  } as EntityConfig;
}

/** Create a mock DiscordBot with spied methods. */
function make_mock_discord() {
  return {
    send_to_entity: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    create_channel: vi.fn(async () => "new-channel-123456789012345678"),
    delete_channel: vi.fn(async () => true),
    build_channel_map: vi.fn(),
    send_as_agent: vi.fn(async () => {}),
  };
}

/** Create a mock BotPool. */
function make_mock_pool() {
  const assignments = new Map<string, object>();
  return {
    get_assignment: vi.fn((channel_id: string) => assignments.get(channel_id) ?? null),
    set_assignment: (channel_id: string, value: object) => assignments.set(channel_id, value),
  };
}

// ── Setup / teardown ──

beforeEach(() => {
  exec_calls.length = 0;
  rm_calls = [];
  exec_mock_impl = async () => ({ stdout: "", stderr: "" });
  // Reset global discord/pool state
  set_discord_bot(null);
  set_pool(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──

describe("create_worktree", () => {
  it("calls git branch and git worktree add with correct args", async () => {
    exec_mock_impl = async () => ({ stdout: "", stderr: "" });

    const feature = make_feature({ branch: "feature/42-widget" });
    const config = make_entity_config();

    const result = await create_worktree(feature, config);

    // Should have called git branch (may fail, that's ok) and git worktree add
    const worktree_call = exec_calls.find((c) => c.command === "git" && c.args[0] === "worktree");
    expect(worktree_call).toBeDefined();
    expect(worktree_call!.args).toEqual([
      "worktree",
      "add",
      "/repos/test-repo/worktrees/42-widget",
      "feature/42-widget",
    ]);

    expect(result).toBe("/repos/test-repo/worktrees/42-widget");
  });

  it("strips 'feature/' prefix from branch name for worktree path", async () => {
    exec_mock_impl = async () => ({ stdout: "", stderr: "" });

    const feature = make_feature({ branch: "feature/99-fancy" });
    const config = make_entity_config();

    const result = await create_worktree(feature, config);
    expect(result).toBe("/repos/test-repo/worktrees/99-fancy");
  });

  it("tolerates 'already exists' error gracefully", async () => {
    exec_mock_impl = async (cmd, args) => {
      if (args[0] === "worktree") {
        throw new Error("fatal: '/repos/test-repo/worktrees/42-widget' already exists");
      }
      return { stdout: "", stderr: "" };
    };

    const feature = make_feature();
    const config = make_entity_config();

    // Should not throw
    const result = await create_worktree(feature, config);
    expect(result).toBe("/repos/test-repo/worktrees/42-widget");
  });

  it("rethrows non-'already exists' errors", async () => {
    exec_mock_impl = async (cmd, args) => {
      if (args[0] === "worktree") {
        throw new Error("fatal: permission denied");
      }
      return { stdout: "", stderr: "" };
    };

    const feature = make_feature();
    const config = make_entity_config();

    await expect(create_worktree(feature, config)).rejects.toThrow("permission denied");
  });
});

describe("cleanup_worktree", () => {
  it("no-ops when worktreePath is null", async () => {
    const feature = make_feature({ worktreePath: null });
    const config = make_entity_config();

    await cleanup_worktree(feature, config);

    // No git commands should have been called
    expect(exec_calls).toHaveLength(0);
  });

  it("calls git worktree remove --force", async () => {
    exec_mock_impl = async () => ({ stdout: "", stderr: "" });

    const feature = make_feature({
      worktreePath: "/repos/test-repo/worktrees/42-widget",
    });
    const config = make_entity_config();

    await cleanup_worktree(feature, config);

    const remove_call = exec_calls.find(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "remove",
    );
    expect(remove_call).toBeDefined();
    expect(remove_call!.args).toEqual([
      "worktree",
      "remove",
      "/repos/test-repo/worktrees/42-widget",
      "--force",
    ]);
  });

  it("falls back to rm + prune when git worktree remove fails", async () => {
    exec_mock_impl = async (cmd, args) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        throw new Error("fatal: worktree locked");
      }
      // prune should succeed
      return { stdout: "", stderr: "" };
    };

    const feature = make_feature({
      worktreePath: "/repos/test-repo/worktrees/42-widget",
    });
    const config = make_entity_config();

    await cleanup_worktree(feature, config);

    // Should have called rm on the worktree path
    expect(rm_calls).toHaveLength(1);
    expect(rm_calls[0]!.path).toBe("/repos/test-repo/worktrees/42-widget");
    expect(rm_calls[0]!.options).toEqual({ recursive: true, force: true });

    // Should have called git worktree prune
    const prune_call = exec_calls.find(
      (c) => c.command === "git" && c.args[0] === "worktree" && c.args[1] === "prune",
    );
    expect(prune_call).toBeDefined();
  });

  it("reports to Sentry when all cleanup methods fail", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args[0] === "worktree") {
        throw new Error("git failed");
      }
      return { stdout: "", stderr: "" };
    };
    // rm also fails
    const { rm } = await import("node:fs/promises");
    (rm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rm failed"));

    const feature = make_feature({
      worktreePath: "/repos/test-repo/worktrees/42-widget",
    });
    const config = make_entity_config();

    await cleanup_worktree(feature, config);

    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { module: "actions", action: "cleanup_worktree" },
      }),
    );
  });
});

describe("create_pr", () => {
  it("calls gh pr create with correct args and extracts PR number", async () => {
    exec_mock_impl = async (cmd, args) => {
      if (cmd === "gh" && args[0] === "pr") {
        return {
          stdout: "https://github.com/test-org/test-repo/pull/123",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };

    const feature = make_feature({
      branch: "feature/42-widget",
      title: "Add widget support",
      githubIssue: 42,
    });
    const config = make_entity_config();

    const pr_number = await create_pr(feature, config);

    expect(pr_number).toBe(123);

    const gh_call = exec_calls.find(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "create",
    );
    expect(gh_call).toBeDefined();
    expect(gh_call!.args).toContain("--base");
    expect(gh_call!.args).toContain("main");
    expect(gh_call!.args).toContain("--head");
    expect(gh_call!.args).toContain("feature/42-widget");
    expect(gh_call!.args).toContain("--title");
    expect(gh_call!.args).toContain("Add widget support");
    expect(gh_call!.args).toContain("--body");
    expect(gh_call!.args).toContain("Closes #42");
  });

  it("returns 0 when PR URL cannot be parsed", async () => {
    exec_mock_impl = async () => ({
      stdout: "unexpected output",
      stderr: "",
    });

    const feature = make_feature();
    const config = make_entity_config();

    const pr_number = await create_pr(feature, config);
    expect(pr_number).toBe(0);
  });

  it("uses worktreePath as cwd when available", async () => {
    exec_mock_impl = async () => ({
      stdout: "https://github.com/org/repo/pull/1",
      stderr: "",
    });

    const feature = make_feature({
      worktreePath: "/repos/test-repo/worktrees/42-widget",
    });
    const config = make_entity_config();

    await create_pr(feature, config);

    const gh_call = exec_calls.find((c) => c.command === "gh");
    expect(gh_call!.options?.cwd).toBe("/repos/test-repo/worktrees/42-widget");
  });
});

describe("merge_pr", () => {
  it("throws when feature has no PR number", async () => {
    const feature = make_feature({ prNumber: null });
    const config = make_entity_config();

    await expect(merge_pr(feature, config)).rejects.toThrow("has no PR number");
  });

  it("calls gh pr merge with squash and delete-branch", async () => {
    exec_mock_impl = async () => ({ stdout: "", stderr: "" });

    const feature = make_feature({ prNumber: 123 });
    const config = make_entity_config();

    await merge_pr(feature, config);

    const gh_call = exec_calls.find(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "merge",
    );
    expect(gh_call).toBeDefined();
    expect(gh_call!.args).toContain("123");
    expect(gh_call!.args).toContain("--squash");
    expect(gh_call!.args).toContain("--delete-branch");
  });

  it("treats 'already been merged' as success (idempotent)", async () => {
    exec_mock_impl = async () => {
      throw new Error("GraphQL: Pull Request #123 has already been merged");
    };

    const feature = make_feature({ prNumber: 123 });
    const config = make_entity_config();

    // Should NOT throw
    await expect(merge_pr(feature, config)).resolves.toBeUndefined();
  });

  it("treats 'MERGED' status as success (idempotent)", async () => {
    exec_mock_impl = async () => {
      throw new Error("Pull request is in MERGED state");
    };

    const feature = make_feature({ prNumber: 123 });
    const config = make_entity_config();

    await expect(merge_pr(feature, config)).resolves.toBeUndefined();
  });

  it("rethrows non-merge errors", async () => {
    exec_mock_impl = async () => {
      throw new Error("gh: permission denied");
    };

    const feature = make_feature({ prNumber: 123 });
    const config = make_entity_config();

    await expect(merge_pr(feature, config)).rejects.toThrow("permission denied");
  });
});

describe("run_tests", () => {
  it("returns true and skips when no worktreePath", async () => {
    const feature = make_feature({ worktreePath: null });
    const result = await run_tests(feature);
    expect(result).toBe(true);
  });

  it("returns true when tests pass", async () => {
    const feature = make_feature({
      worktreePath: "/repos/test-repo/worktrees/42-widget",
    });
    const result = await run_tests(feature);
    expect(result).toBe(true);
  });
});

describe("detect_review_outcome", () => {
  it("returns 'approved' for MERGED PR", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "MERGED", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await detect_review_outcome(42, "/repos/test-repo");
    expect(result).toBe("approved");
  });

  it("returns 'approved' for APPROVED review decision", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "OPEN", stderr: "" };
      }
      if (args.includes("reviewDecision")) {
        return { stdout: "APPROVED", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await detect_review_outcome(42, "/repos/test-repo");
    expect(result).toBe("approved");
  });

  it("returns 'changes_requested' for CHANGES_REQUESTED review decision", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "OPEN", stderr: "" };
      }
      if (args.includes("reviewDecision")) {
        return { stdout: "CHANGES_REQUESTED", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await detect_review_outcome(42, "/repos/test-repo");
    expect(result).toBe("changes_requested");
  });

  it("returns 'pending' for empty/unknown review decision", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "OPEN", stderr: "" };
      }
      if (args.includes("reviewDecision")) {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await detect_review_outcome(42, "/repos/test-repo");
    expect(result).toBe("pending");
  });

  it("returns 'dismissed' when reviewDecision is DISMISSED", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "OPEN", stderr: "" };
      }
      if (args.includes("reviewDecision")) {
        return { stdout: "DISMISSED", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await detect_review_outcome(42, "/repos/test-repo");
    expect(result).toBe("dismissed");
  });

  it("returns 'pending' and reports to Sentry on gh CLI failure", async () => {
    exec_mock_impl = async () => {
      throw new Error("gh: not authenticated");
    };

    const result = await detect_review_outcome(42, "/repos/test-repo");

    expect(result).toBe("pending");
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { module: "actions", action: "detect_review_outcome" },
      }),
    );
  });

  it("handles case-insensitive review decisions", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "OPEN", stderr: "" };
      }
      if (args.includes("reviewDecision")) {
        return { stdout: "approved", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await detect_review_outcome(42, "/repos/test-repo");
    expect(result).toBe("approved");
  });

  it("passes GH_TOKEN in env when gh_token is provided", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "OPEN", stderr: "" };
      }
      if (args.includes("reviewDecision")) {
        return { stdout: "APPROVED", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    await detect_review_outcome(42, "/repos/test-repo", "ghs_cross_account_token");

    // All gh calls should have GH_TOKEN in their env
    const gh_calls = exec_calls.filter((c) => c.command === "gh");
    expect(gh_calls.length).toBeGreaterThan(0);
    for (const call of gh_calls) {
      expect((call.options as Record<string, unknown>)?.env).toBeDefined();
      expect(
        ((call.options as Record<string, unknown>)?.env as Record<string, string>)?.GH_TOKEN,
      ).toBe("ghs_cross_account_token");
    }
  });

  it("does not set env when gh_token is not provided", async () => {
    exec_mock_impl = async (_cmd, args) => {
      if (args.includes("state")) {
        return { stdout: "MERGED", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    await detect_review_outcome(42, "/repos/test-repo");

    const gh_calls = exec_calls.filter((c) => c.command === "gh");
    expect(gh_calls.length).toBeGreaterThan(0);
    for (const call of gh_calls) {
      // When no token is provided, env should not be set on the options
      expect((call.options as Record<string, unknown>)?.env).toBeUndefined();
    }
  });
});

// ── Findings-comment verdict fallback (#46) ──

/**
 * Build an exec mock that mimics the responses `detect_review_outcome` and
 * `detect_verdict_from_comments` make through the gh CLI:
 *   - `gh pr view <n> --json state`           → `state`
 *   - `gh pr view <n> --json reviewDecision`  → `review_decision`
 *   - `gh api user`                           → `login`
 *   - `gh pr view <n> --json comments`        → `comments` (JSON-encoded)
 */
function set_review_outcome_responses(opts: {
  state?: string;
  review_decision?: string;
  login?: string;
  comments?: Array<{
    body: string;
    createdAt: string;
    author: { login: string } | null;
  }>;
}) {
  exec_mock_impl = async (_cmd, args) => {
    if (args[0] === "api" && args[1] === "user") {
      return { stdout: opts.login ?? "", stderr: "" };
    }
    if (args.includes("state")) {
      return { stdout: opts.state ?? "OPEN", stderr: "" };
    }
    if (args.includes("reviewDecision")) {
      return { stdout: opts.review_decision ?? "", stderr: "" };
    }
    if (args.includes("--json") && args.includes("comments")) {
      return { stdout: JSON.stringify(opts.comments ?? []), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

describe("detect_review_outcome — findings-comment fallback (#46)", () => {
  const REVIEWER = "reviewer-bot";

  it("prefers reviewDecision when present, even if is_self_authored=true", async () => {
    // Regression guard: if reviewDecision is APPROVED, we must NOT consult
    // comments — formal reviews always win.
    set_review_outcome_responses({
      review_decision: "APPROVED",
      login: REVIEWER,
      comments: [
        // A stale "Changes Requested" comment that would flip the verdict if read.
        {
          body: "**Verdict: Changes Requested**\n\nstale",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });

    const result = await detect_review_outcome(42, "/repos/test-repo", {
      is_self_authored: true,
    });

    expect(result).toBe("approved");

    // And we should never have asked for comments.
    const comments_call = exec_calls.find(
      (c) => c.command === "gh" && c.args.includes("--json") && c.args.includes("comments"),
    );
    expect(comments_call).toBeUndefined();
  });

  it("falls back to the comment verdict when reviewDecision is empty and PR is self-authored", async () => {
    set_review_outcome_responses({
      review_decision: "",
      login: REVIEWER,
      comments: [
        {
          body: "**Verdict: Changes Requested**\n\nFix the foo.",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });

    const result = await detect_review_outcome(42, "/repos/test-repo", {
      is_self_authored: true,
    });

    expect(result).toBe("changes_requested");
  });

  it("uses the most recent matching comment when multiple exist", async () => {
    set_review_outcome_responses({
      review_decision: "",
      login: REVIEWER,
      comments: [
        {
          body: "**Verdict: Changes Requested**\n\nfirst pass",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
        {
          body: "**Verdict: Approved**\n\nafter the fix",
          createdAt: "2026-05-09T12:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });

    const result = await detect_review_outcome(42, "/repos/test-repo", {
      is_self_authored: true,
    });

    expect(result).toBe("approved");
  });

  it("does NOT fall back when is_self_authored is false (multi-dev path)", async () => {
    set_review_outcome_responses({
      review_decision: "",
      login: REVIEWER,
      comments: [
        {
          body: "**Verdict: Approved**\n\nshould be ignored",
          createdAt: "2026-05-09T10:00:00Z",
          author: { login: REVIEWER },
        },
      ],
    });

    const result = await detect_review_outcome(42, "/repos/test-repo", {
      is_self_authored: false,
    });

    expect(result).toBe("pending");

    // Make sure we never even asked for comments — the multi-dev path must
    // stay on formal reviews only.
    const comments_call = exec_calls.find(
      (c) => c.command === "gh" && c.args.includes("--json") && c.args.includes("comments"),
    );
    expect(comments_call).toBeUndefined();
  });

  it("stays pending when reviewDecision is empty, self-authored, but `gh api user` fails", async () => {
    // Without an authenticated login we cannot safely filter comments, so the
    // helper must refuse to guess and leave the outcome pending.
    exec_mock_impl = async (_cmd, args) => {
      if (args[0] === "api" && args[1] === "user") {
        throw new Error("gh: not authenticated");
      }
      if (args.includes("state")) return { stdout: "OPEN", stderr: "" };
      if (args.includes("reviewDecision")) return { stdout: "", stderr: "" };
      // If we somehow asked for comments anyway, return a verdict to make the
      // failure mode obvious.
      if (args.includes("--json") && args.includes("comments")) {
        return {
          stdout: JSON.stringify([
            {
              body: "**Verdict: Approved**",
              createdAt: "2026-05-09T10:00:00Z",
              author: { login: "reviewer-bot" },
            },
          ]),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await detect_review_outcome(42, "/repos/test-repo", {
      is_self_authored: true,
    });

    expect(result).toBe("pending");
  });

  it("accepts the legacy positional gh_token signature (backwards-compat)", async () => {
    // The old call signature was `detect_review_outcome(pr, repo, gh_token?)`.
    // We keep that working so existing call sites that haven't migrated still
    // compile and run correctly.
    set_review_outcome_responses({ review_decision: "APPROVED" });
    const result = await detect_review_outcome(42, "/repos/test-repo", "ghs_legacy_token");
    expect(result).toBe("approved");

    // And the token still gets injected into the gh env.
    const gh_calls = exec_calls.filter((c) => c.command === "gh");
    expect(gh_calls.length).toBeGreaterThan(0);
    for (const call of gh_calls) {
      const env = (call.options as Record<string, unknown>)?.env as
        | Record<string, string>
        | undefined;
      expect(env?.GH_TOKEN).toBe("ghs_legacy_token");
    }
  });

  it("merges process.env into the env passed to `gh api user` and `gh pr view --json comments` when gh_token is set", async () => {
    // Regression guard for cycle-2 review finding: `get_authenticated_login`
    // and `detect_verdict_from_comments` are called via `exec_async` directly
    // (not via the local `run()` helper), so they do NOT merge process.env on
    // their own. If we forward a partial `{ GH_TOKEN }` env, PATH is dropped
    // and the gh binary can't be located → login resolves to null → comment
    // fallback silently stays pending. Pin both call sites here so the bug
    // can't regress unnoticed.
    const SENTINEL_KEY = "REVIEW_OUTCOME_ENV_SENTINEL";
    const SENTINEL_VALUE = "preserved-from-process-env";
    process.env[SENTINEL_KEY] = SENTINEL_VALUE;

    try {
      set_review_outcome_responses({
        review_decision: "",
        login: "reviewer-bot",
        comments: [
          {
            body: "**Verdict: Approved**\n\nlgtm",
            createdAt: "2026-05-09T10:00:00Z",
            author: { login: "reviewer-bot" },
          },
        ],
      });

      await detect_review_outcome(42, "/repos/test-repo", {
        gh_token: "ghs_cross_account_token",
        is_self_authored: true,
      });

      // The `gh api user` call (used by get_authenticated_login) must see both
      // GH_TOKEN AND the sentinel that lives in process.env.
      const api_user_call = exec_calls.find(
        (c) => c.command === "gh" && c.args[0] === "api" && c.args[1] === "user",
      );
      expect(api_user_call, "expected a `gh api user` call").toBeDefined();
      const api_user_env = (api_user_call?.options as Record<string, unknown> | undefined)?.env as
        | Record<string, string>
        | undefined;
      expect(api_user_env?.GH_TOKEN).toBe("ghs_cross_account_token");
      expect(api_user_env?.[SENTINEL_KEY]).toBe(SENTINEL_VALUE);

      // Same for the `gh pr view --json comments` call (used by
      // detect_verdict_from_comments) — already correct before the fix but
      // pinned here so the two paths stay consistent.
      const comments_call = exec_calls.find(
        (c) => c.command === "gh" && c.args.includes("--json") && c.args.includes("comments"),
      );
      expect(comments_call, "expected a `gh pr view --json comments` call").toBeDefined();
      const comments_env = (comments_call?.options as Record<string, unknown> | undefined)?.env as
        | Record<string, string>
        | undefined;
      expect(comments_env?.GH_TOKEN).toBe("ghs_cross_account_token");
      expect(comments_env?.[SENTINEL_KEY]).toBe(SENTINEL_VALUE);
    } finally {
      delete process.env[SENTINEL_KEY];
    }
  });
});

describe("classify_merge_error", () => {
  it("returns 'conflict' for merge conflict errors", () => {
    expect(classify_merge_error("MERGE CONFLICT in file.ts")).toBe("conflict");
    expect(classify_merge_error("Pull request is not mergeable")).toBe("conflict");
    expect(classify_merge_error("There are conflicting files")).toBe("conflict");
    expect(classify_merge_error("Conflicts must be resolved before merging")).toBe("conflict");
    expect(classify_merge_error("PR is not mergeable due to conflicts")).toBe("conflict");
  });

  it("returns 'other' for non-conflict errors", () => {
    expect(classify_merge_error("permission denied")).toBe("other");
    expect(classify_merge_error("gh: authentication required")).toBe("other");
    expect(classify_merge_error("network timeout")).toBe("other");
    expect(classify_merge_error("")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classify_merge_error("MERGE CONFLICT")).toBe("conflict");
    expect(classify_merge_error("merge conflict")).toBe("conflict");
    expect(classify_merge_error("Merge Conflict")).toBe("conflict");
  });
});

describe("notify", () => {
  it("logs message even without Discord bot", async () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await notify("alerts", "Test message");

    expect(log_spy).toHaveBeenCalledWith(expect.stringContaining("[alerts] Test message"));

    log_spy.mockRestore();
  });

  it("sends to Discord when bot and config are available", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const config = make_entity_config({ id: "my-entity" });

    await notify("alerts", "PR approved", config, "reviewer");

    expect(mock_discord.send_to_entity).toHaveBeenCalledWith(
      "my-entity",
      "alerts",
      "PR approved",
      "reviewer",
    );
  });

  it("uses 'system' archetype when none is provided", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const config = make_entity_config({ id: "my-entity" });

    await notify("work-log", "Build started", config);

    expect(mock_discord.send_to_entity).toHaveBeenCalledWith(
      "my-entity",
      "work-log",
      "Build started",
      "system",
    );
  });

  it("does not call Discord when entity config is missing", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    await notify("alerts", "Hello");

    expect(mock_discord.send_to_entity).not.toHaveBeenCalled();
  });
});

describe("assign_work_room", () => {
  it("returns existing room when feature already has one", async () => {
    const feature = make_feature({ discordWorkRoom: "12345678901234567890" });
    const config = make_entity_config();

    const result = await assign_work_room(feature, config);
    expect(result).toBe("12345678901234567890");
  });

  it("assigns first free static room with a valid snowflake ID", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [
          {
            type: "work_room",
            id: "12345678901234567890",
            purpose: "Room 1",
          } as ChannelMapping,
        ],
      },
    });

    const feature = make_feature();
    const result = await assign_work_room(feature, config);

    expect(result).toBe("12345678901234567890");
  });

  it("skips rooms with non-snowflake placeholder IDs", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [
          {
            type: "work_room",
            id: "wr-1",
            purpose: "Placeholder",
          } as ChannelMapping,
          {
            type: "work_room",
            id: "12345678901234567890",
            purpose: "Real room",
          } as ChannelMapping,
        ],
      },
    });

    const feature = make_feature();
    const result = await assign_work_room(feature, config);

    // Should skip "wr-1" and use the real snowflake
    expect(result).toBe("12345678901234567890");
  });

  it("skips rooms occupied by pool bot assignments", async () => {
    const mock_discord = make_mock_discord();
    const mock_pool = make_mock_pool();
    set_discord_bot(mock_discord as any);
    set_pool(mock_pool as any);

    // Mark first room as occupied
    mock_pool.set_assignment("12345678901234567890", { bot_id: 1 });

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [
          {
            type: "work_room",
            id: "12345678901234567890",
            purpose: "Room 1 (occupied)",
          } as ChannelMapping,
          {
            type: "work_room",
            id: "22345678901234567890",
            purpose: "Room 2 (free)",
          } as ChannelMapping,
        ],
      },
    });

    const feature = make_feature();
    const result = await assign_work_room(feature, config);

    expect(result).toBe("22345678901234567890");
  });

  it("creates a dynamic room when all static rooms are occupied", async () => {
    const mock_discord = make_mock_discord();
    const mock_pool = make_mock_pool();
    set_discord_bot(mock_discord as any);
    set_pool(mock_pool as any);

    mock_pool.set_assignment("12345678901234567890", { bot_id: 1 });

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [
          {
            type: "work_room",
            id: "12345678901234567890",
            purpose: "Room 1 (occupied)",
          } as ChannelMapping,
        ],
      },
    });

    const feature = make_feature();
    const result = await assign_work_room(feature, config);

    // Should have created a new channel via Discord
    expect(mock_discord.create_channel).toHaveBeenCalledWith(
      "cat-123",
      "work-room-2",
      expect.stringContaining("test-feature-1"),
    );

    // Returns the dynamically created channel ID
    expect(result).toBe("new-channel-123456789012345678");

    // New channel should be added to the config list
    const dynamic_entry = config.entity.channels.list.find(
      (c: ChannelMapping) => c.id === "new-channel-123456789012345678",
    );
    expect(dynamic_entry).toBeDefined();
    expect(dynamic_entry!.dynamic).toBe(true);
  });

  it("returns null when no Discord and no category_id for dynamic room", async () => {
    // No discord, no pool
    const config = make_entity_config({
      channels: {
        category_id: "",
        list: [],
      },
    });

    const feature = make_feature();
    const result = await assign_work_room(feature, config);

    expect(result).toBeNull();
  });

  it("rebuilds channel map after assignment", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [
          {
            type: "work_room",
            id: "12345678901234567890",
            purpose: "Room 1",
          } as ChannelMapping,
        ],
      },
    });

    const feature = make_feature();
    await assign_work_room(feature, config);

    expect(mock_discord.build_channel_map).toHaveBeenCalled();
  });
});

describe("release_work_room", () => {
  it("no-ops when feature has no discordWorkRoom", async () => {
    const feature = make_feature({ discordWorkRoom: null });
    const config = make_entity_config();

    await release_work_room(feature, config);

    // Nothing should happen — no calls to Discord
    expect(exec_calls).toHaveLength(0);
  });

  it("resets static room topic to Available and clears assignment", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const room_entry: ChannelMapping = {
      type: "work_room",
      id: "12345678901234567890",
      purpose: "Room 1",
      assigned_feature: "test-feature-1",
    } as ChannelMapping;

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [room_entry],
      },
    });

    const feature = make_feature({
      discordWorkRoom: "12345678901234567890",
    });

    await release_work_room(feature, config);

    // Should send farewell message
    expect(mock_discord.send).toHaveBeenCalledWith(
      "12345678901234567890",
      expect.stringContaining("now available"),
    );
    // Should clear assigned_feature
    expect(room_entry.assigned_feature).toBeNull();
  });

  it("deletes dynamic rooms and removes from config", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const dynamic_entry: ChannelMapping = {
      type: "work_room",
      id: "12345678901234567890",
      purpose: "Dynamic room",
      assigned_feature: "test-feature-1",
      dynamic: true,
    } as ChannelMapping;

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [dynamic_entry],
      },
    });

    const feature = make_feature({
      discordWorkRoom: "12345678901234567890",
    });

    await release_work_room(feature, config);

    // Should send farewell and delete the channel
    expect(mock_discord.send).toHaveBeenCalledWith(
      "12345678901234567890",
      expect.stringContaining("Cleaning up"),
    );
    expect(mock_discord.delete_channel).toHaveBeenCalledWith("12345678901234567890");

    // Channel should be removed from config list
    const remaining = config.entity.channels.list.filter(
      (c: ChannelMapping) => c.id === "12345678901234567890",
    );
    expect(remaining).toHaveLength(0);
  });

  it("rebuilds channel map after release", async () => {
    const mock_discord = make_mock_discord();
    set_discord_bot(mock_discord as any);

    const config = make_entity_config({
      channels: {
        category_id: "cat-123",
        list: [
          {
            type: "work_room",
            id: "12345678901234567890",
            purpose: "Room 1",
          } as ChannelMapping,
        ],
      },
    });

    const feature = make_feature({
      discordWorkRoom: "12345678901234567890",
    });

    await release_work_room(feature, config);

    expect(mock_discord.build_channel_map).toHaveBeenCalled();
  });
});
