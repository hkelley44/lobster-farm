import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ACTIVE_MARKER,
  cleanup_after_merge,
  find_worktree_for_branch,
  has_live_agent_marker,
  is_unstarted_branch,
  is_worktree_safe_to_remove,
  parse_worktree_list,
  relocate_sessions_from_path,
  remove_worktree,
  sweep_stale_worktrees,
} from "../worktree-cleanup.js";

// ── Mock child_process.execFile and execFileSync ──

const mock_exec_file = vi.fn();
const mock_exec_file_sync = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    // The promisified version passes a callback as the last arg
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      const result = mock_exec_file(args[0], args[1], args[2]);
      if (result instanceof Error) {
        callback(result, "", result.message);
      } else {
        callback(null, { stdout: result ?? "", stderr: "" });
      }
    }
    return undefined;
  },
  execFileSync: (...args: unknown[]) => {
    return mock_exec_file_sync(args[0], args[1], args[2]);
  },
}));

// ── Mock fs operations ──

const mock_stat = vi.fn();
const mock_readdir = vi.fn();

vi.mock("node:fs/promises", () => ({
  stat: (...args: unknown[]) => mock_stat(...args),
  readdir: (...args: unknown[]) => mock_readdir(...args),
}));

// ── Mock sentry (no-op) ──

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// ── Helpers ──

/** Build porcelain output for git worktree list. */
function make_porcelain(
  ...entries: Array<{
    path: string;
    head?: string;
    branch?: string;
    bare?: boolean;
  }>
): string {
  return entries
    .map((e) => {
      const lines = [`worktree ${e.path}`];
      lines.push(`HEAD ${e.head ?? "abc1234567890"}`);
      if (e.branch) lines.push(`branch ${e.branch}`);
      if (e.bare) lines.push("bare");
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Configure mock_exec_file to handle specific git commands.
 * Returns a chainable builder for easy test setup.
 */
function setup_git_mocks(
  opts: {
    worktree_list?: string;
    worktree_remove_error?: Error;
    branch_delete_error?: Error;
    merged_branches?: string;
    fetch_error?: Error;
    rev_parse_missing?: string[]; // branches whose remote ref is gone
    /** Output for `git status --porcelain=v1 --untracked-files=all`. Defaults to "" (clean). */
    status_porcelain?: string;
    /** Output for `git rev-list <branch> --not --remotes`. Defaults to "" (no unpushed commits). */
    rev_list_unpushed?: string;
    /**
     * Commits on the trunk's first-parent history, keyed by trunk ref
     * (issue #110). A ref absent from this map resolves to an empty history;
     * set `trunk_unresolvable` to make every trunk ref fail instead.
     */
    trunk_first_parent?: Record<string, string[]>;
    /** When true, every `rev-list --first-parent <trunk>` probe throws. */
    trunk_unresolvable?: boolean;
    /** Tip sha per local branch, for `rev-parse --verify refs/heads/<branch>`. */
    branch_tips?: Record<string, string>;
    /** Local branches whose `refs/heads/<branch>` lookup should fail. */
    missing_local_branches?: string[];
    /**
     * Branch checked out in a given worktree directory, keyed by absolute
     * path, for `git -C <dir> symbolic-ref --short HEAD`. A directory absent
     * from this map resolves to `null` (detached, pruned, or not a worktree),
     * which `cleanup_claude_worktrees` treats as "do not touch".
     */
    worktree_branches?: Record<string, string>;
  } = {},
): void {
  mock_exec_file.mockImplementation((cmd: string, args: string[], exec_opts: unknown) => {
    if (cmd !== "git") return "";

    const subcmd = args[0];
    const cwd = (exec_opts as { cwd?: string } | undefined)?.cwd ?? "";

    // `git -C <dir> symbolic-ref --short HEAD` — the worktree's own branch.
    if (subcmd === "symbolic-ref") {
      const own_branch = opts.worktree_branches?.[cwd];
      if (own_branch === undefined) throw new Error("fatal: ref HEAD is not a symbolic ref");
      return own_branch;
    }

    if (subcmd === "worktree") {
      if (args[1] === "list") {
        return opts.worktree_list ?? "";
      }
      if (args[1] === "remove") {
        if (opts.worktree_remove_error) throw opts.worktree_remove_error;
        return "";
      }
      if (args[1] === "prune") {
        return "";
      }
    }

    if (subcmd === "branch") {
      if (args[1] === "-d") {
        if (opts.branch_delete_error) throw opts.branch_delete_error;
        return "";
      }
      if (args[1] === "--merged") {
        return opts.merged_branches ?? "";
      }
    }

    if (subcmd === "fetch") {
      if (opts.fetch_error) throw opts.fetch_error;
      return "";
    }

    if (subcmd === "rev-parse") {
      // args: ["rev-parse", "--verify", "<ref>"]
      const ref = args[2] ?? "";

      // Remote tracking ref — drives the "remote gone" stale test.
      if (ref.startsWith("refs/remotes/origin/")) {
        const branch = ref.slice("refs/remotes/origin/".length);
        if (opts.rev_parse_missing?.includes(branch)) {
          throw new Error("fatal: Needed a single revision");
        }
        return "abc123";
      }

      // Local branch ref — existence probe plus tip resolution (issue #110).
      if (ref.startsWith("refs/heads/")) {
        const branch = ref.slice("refs/heads/".length);
        if (opts.missing_local_branches?.includes(branch)) {
          throw new Error("fatal: Needed a single revision");
        }
        return opts.branch_tips?.[branch] ?? `tip-${branch}`;
      }

      return "abc123";
    }

    // Issue #27 guardrail probes
    if (subcmd === "status") {
      return opts.status_porcelain ?? "";
    }

    if (subcmd === "rev-list") {
      // Issue #110 trunk probe: `rev-list --first-parent <trunk-ref>`.
      if (args[1] === "--first-parent") {
        if (opts.trunk_unresolvable) throw new Error("fatal: bad revision");
        return (opts.trunk_first_parent?.[args[2] ?? ""] ?? []).join("\n");
      }
      // Issue #27 guardrail: `rev-list <branch> --not --remotes`.
      return opts.rev_list_unpushed ?? "";
    }

    return "";
  });
}

// ── Tests ──

/** Paths passed to `git worktree remove`, in call order. */
function removed_paths(): string[] {
  return mock_exec_file.mock.calls
    .filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    )
    .map((c: unknown[]) => (c[1] as string[])[2]);
}

/**
 * Default `stat` behavior: every path exists EXCEPT the `.lf-agent-active`
 * live-agent marker, which must be absent or every removal in this file would
 * be (correctly) refused. Tests that want the shield engaged override this.
 */
function stat_without_agent_marker(path: string): Promise<{ isDirectory: () => boolean }> {
  if (path.endsWith(AGENT_ACTIVE_MARKER)) return Promise.reject(new Error("ENOENT"));
  return Promise.resolve({ isDirectory: () => true });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock_stat.mockImplementation(stat_without_agent_marker);
  mock_readdir.mockResolvedValue([]);
  // Default: tmux not running (execFileSync throws)
  mock_exec_file_sync.mockImplementation(() => {
    throw new Error("no server running on /tmp/tmux-501/default");
  });
});

describe("relocate_sessions_from_path", () => {
  it("returns 0 and does not throw when tmux is not running", async () => {
    // Default mock throws (tmux not running)
    const result = relocate_sessions_from_path("/some/worktree", "/repo");
    expect(result).toBe(0);
  });

  it("returns 0 when no panes have a matching cwd", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /other/path\nsession2 %1 /another/path\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/target/worktree", "/repo");
    expect(result).toBe(0);

    // Should not have sent any cd commands
    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys_calls).toHaveLength(0);
  });

  it("relocates a pane whose cwd is exactly the target path", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /target/worktree\nsession2 %1 /other/path\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/target/worktree", "/repo");
    expect(result).toBe(1);

    // Should have sent cd to the matching pane using its pane ID
    expect(mock_exec_file_sync).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "%0", expect.stringContaining("cd"), "Enter"],
      expect.objectContaining({ timeout: 2000 }),
    );
  });

  it("relocates panes inside a subdirectory of the target path", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /target/worktree/src/deep/dir\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/target/worktree", "/repo");
    expect(result).toBe(1);
  });

  it("does NOT relocate a pane whose path is a prefix but not inside the target", async () => {
    // /foo/bar-baz should NOT match target /foo/bar (trailing-slash guard)
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /foo/bar-baz\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/foo/bar", "/repo");
    expect(result).toBe(0);
  });

  it("handles multiple matching panes across sessions", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return [
          "gary %0 /worktree/path",
          "bob %1 /worktree/path/src",
          "other %2 /different/path",
          "bob %3 /worktree/path",
        ].join("\n");
      }
      return "";
    });

    const result = relocate_sessions_from_path("/worktree/path", "/repo");
    expect(result).toBe(3);
  });

  it("continues relocating other panes when one send-keys fails", async () => {
    let send_keys_count = 0;
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "s1 %0 /wt/path\ns2 %1 /wt/path\n";
      }
      if (cmd === "tmux" && args[0] === "send-keys") {
        send_keys_count++;
        if (send_keys_count === 1) {
          throw new Error("session not found");
        }
        return "";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/wt/path", "/repo");
    // First pane fails, second succeeds — only 1 relocated
    expect(result).toBe(1);
  });
});

describe("parse_worktree_list", () => {
  it("parses a single main worktree", () => {
    const output = ["worktree /repo", "HEAD abc123", "branch refs/heads/main"].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      path: "/repo",
      head: "abc123",
      branch: "refs/heads/main",
      bare: false,
    });
  });

  it("parses multiple worktrees including a detached head", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/worktrees/feature-foo",
      "HEAD def456",
      "branch refs/heads/feature/foo",
      "",
      "worktree /repo/worktrees/detached",
      "HEAD 789abc",
      "detached",
    ].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries).toHaveLength(3);
    expect(entries[1]!.branch).toBe("refs/heads/feature/foo");
    expect(entries[2]!.branch).toBeNull();
  });

  it("handles empty output", () => {
    expect(parse_worktree_list("")).toEqual([]);
    expect(parse_worktree_list("  ")).toEqual([]);
  });

  it("recognizes bare worktree entries", () => {
    const output = ["worktree /repo", "HEAD abc123", "bare"].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries[0]!.bare).toBe(true);
  });
});

describe("remove_worktree", () => {
  it("removes worktree and deletes branch on success", async () => {
    setup_git_mocks();

    const result = await remove_worktree("/repo", "/repo/worktrees/foo", "feature/foo");

    expect(result).toBe(true);
    // Verify git worktree remove was called
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/foo", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    // Verify git branch -d was called
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["branch", "-d", "feature/foo"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("returns true when worktree is already gone", async () => {
    setup_git_mocks({
      worktree_remove_error: new Error("not a working tree"),
    });

    const result = await remove_worktree("/repo", "/repo/worktrees/gone", "feature/gone");

    expect(result).toBe(true);
  });

  it("returns false on unexpected worktree remove error", async () => {
    setup_git_mocks({
      worktree_remove_error: new Error("permission denied"),
    });

    const result = await remove_worktree("/repo", "/repo/worktrees/locked", "feature/locked");

    expect(result).toBe(false);
  });

  it("handles branch already deleted gracefully", async () => {
    setup_git_mocks({
      branch_delete_error: new Error("error: branch 'feature/gone' not found"),
    });

    const result = await remove_worktree("/repo", "/repo/worktrees/foo", "feature/gone");

    expect(result).toBe(true); // worktree removal succeeded
  });
});

describe("find_worktree_for_branch", () => {
  it("finds worktree matching the branch", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/auto-cleanup", branch: "refs/heads/feature/134-auto-cleanup" },
    );
    setup_git_mocks({ worktree_list: porcelain });

    const result = await find_worktree_for_branch("/repo", "feature/134-auto-cleanup");

    expect(result).toBe("/repo/worktrees/auto-cleanup");
  });

  it("returns null when no worktree matches", async () => {
    const porcelain = make_porcelain({ path: "/repo", branch: "refs/heads/main" });
    setup_git_mocks({ worktree_list: porcelain });

    const result = await find_worktree_for_branch("/repo", "feature/nonexistent");

    expect(result).toBeNull();
  });

  it("returns null on git command failure", async () => {
    mock_exec_file.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const result = await find_worktree_for_branch("/not-a-repo", "feature/foo");

    expect(result).toBeNull();
  });
});

describe("cleanup_after_merge", () => {
  it("removes worktree and branch when found", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/my-feature", branch: "refs/heads/feature/my-feature" },
    );
    setup_git_mocks({ worktree_list: porcelain });

    await cleanup_after_merge("/repo", "feature/my-feature");

    // Should have called worktree remove
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/my-feature", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("still tries to delete branch when no worktree is found", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
    });

    await cleanup_after_merge("/repo", "feature/orphan");

    // Should have tried to delete the branch directly
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["branch", "-d", "feature/orphan"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("does not delete a no-worktree branch with unpushed commits and posts an alert", async () => {
    // Regression: the no-worktree path of cleanup_after_merge used to call
    // `git branch -d` directly, bypassing the guardrail. `git branch -d` is
    // soft (refuses unmerged branches), so this isn't a new data-loss path —
    // but the PR spec was that *every* removal route through the guardrail
    // and produce a consistent alert when blocked.
    setup_git_mocks({
      // No worktree exists for this branch
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      status_porcelain: "",
      // Branch has an unpushed commit
      rev_list_unpushed: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    const alert_router = { post_alert: vi.fn() };

    await cleanup_after_merge("/repo", "feature/orphan-with-work", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    // (a) `git branch -d` must NOT be called for this branch
    const delete_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "branch" &&
        (c[1] as string[])[1] === "-d" &&
        (c[1] as string[])[2] === "feature/orphan-with-work",
    );
    expect(delete_calls).toHaveLength(0);

    // (b) An alert must have fired
    expect(alert_router.post_alert).toHaveBeenCalledTimes(1);
    const payload = alert_router.post_alert.mock.calls[0][0];
    expect(payload.entity_id).toBe("test-entity");
    expect(payload.tier).toBe("action_required");
    expect(payload.title).toContain("Unpushed");
    expect(payload.body).toContain("feature/orphan-with-work");
  });

  it("deletes a no-worktree branch when it has no unpushed commits", async () => {
    // The happy path for the no-worktree branch: nothing to protect, delete proceeds.
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      status_porcelain: "",
      rev_list_unpushed: "",
    });

    const alert_router = { post_alert: vi.fn() };

    await cleanup_after_merge("/repo", "feature/orphan", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    // Branch delete must have run
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["branch", "-d", "feature/orphan"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    // No alert
    expect(alert_router.post_alert).not.toHaveBeenCalled();
  });

  it("removes the .claude/worktrees/ directory whose own branch is the merged one", async () => {
    // Directory names here are the harness's real shape: random hex, no
    // relation to any branch. Identity comes from `symbolic-ref`, not the name.
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      worktree_branches: {
        "/repo/.claude/worktrees/agent-134abcde": "feature/134-auto-cleanup",
        "/repo/.claude/worktrees/agent-999fedcb": "feature/999-other",
      },
    });
    mock_readdir.mockImplementation(async (dir: string) => {
      if (dir.includes(".claude/worktrees")) {
        return [
          { name: "agent-134abcde", isDirectory: () => true },
          { name: "agent-999fedcb", isDirectory: () => true },
        ];
      }
      return [];
    });

    await cleanup_after_merge("/repo", "feature/134-auto-cleanup");

    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/.claude/worktrees/agent-134abcde", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(removed_paths()).not.toContain("/repo/.claude/worktrees/agent-999fedcb");
  });

  it("never removes a .claude/worktrees/ directory whose own branch differs from the target", async () => {
    // The regression this guards: the directory name substring-matches the
    // merged branch's slug ("99" appears in "agent-b199c0de"), but the branch
    // checked out in it is someone else's live work. Pre-fix this directory
    // was deleted and #30's unpushed check ran against `fix/99` — the wrong
    // branch — so it reported "safe".
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      worktree_branches: { "/repo/.claude/worktrees/agent-b199c0de": "feature/live-work" },
    });
    mock_readdir.mockImplementation(async (dir: string) => {
      if (dir.includes(".claude/worktrees")) {
        return [{ name: "agent-b199c0de", isDirectory: () => true }];
      }
      return [];
    });

    await cleanup_after_merge("/repo", "fix/99");

    expect(removed_paths()).not.toContain("/repo/.claude/worktrees/agent-b199c0de");
  });

  it("leaves a .claude/worktrees/ directory whose branch cannot be resolved", async () => {
    // Detached HEAD, pruned metadata, or a plain directory — all unresolvable,
    // all left alone. `worktree_branches` is empty so symbolic-ref throws.
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
    });
    mock_readdir.mockImplementation(async (dir: string) => {
      if (dir.includes(".claude/worktrees")) {
        return [{ name: "agent-detached", isDirectory: () => true }];
      }
      return [];
    });

    await cleanup_after_merge("/repo", "feature/whatever");

    expect(removed_paths()).not.toContain("/repo/.claude/worktrees/agent-detached");
  });

  it("relocates sessions before removing worktree", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/my-feature", branch: "refs/heads/feature/my-feature" },
    );
    setup_git_mocks({ worktree_list: porcelain });

    // Track call order: relocation (execFileSync for list-panes) must happen
    // before worktree removal (execFile for git worktree remove).
    const call_order: string[] = [];

    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        call_order.push("tmux:list-panes");
        return "session1 %0 /repo/worktrees/my-feature/src\n";
      }
      if (cmd === "tmux" && args[0] === "send-keys") {
        call_order.push("tmux:send-keys");
        return "";
      }
      return "";
    });

    const original_impl = mock_exec_file.getMockImplementation()!;
    mock_exec_file.mockImplementation((cmd: string, args: string[], opts: unknown) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        call_order.push("git:worktree-remove");
      }
      return original_impl(cmd, args, opts);
    });

    await cleanup_after_merge("/repo", "feature/my-feature");

    // Relocation must precede removal
    const relocation_idx = call_order.indexOf("tmux:list-panes");
    const removal_idx = call_order.indexOf("git:worktree-remove");
    expect(relocation_idx).toBeGreaterThanOrEqual(0);
    expect(removal_idx).toBeGreaterThanOrEqual(0);
    expect(relocation_idx).toBeLessThan(removal_idx);
  });

  it("does not throw when .claude/worktrees/ does not exist", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
    });
    mock_stat.mockImplementation(async (path: string) => {
      if (path.includes(".claude/worktrees")) throw new Error("ENOENT");
      return { isDirectory: () => true };
    });

    // Should complete without throwing
    await expect(cleanup_after_merge("/repo", "feature/foo")).resolves.toBeUndefined();
  });
});

describe("sweep_stale_worktrees", () => {
  it("cleans up worktrees whose branch is merged into main", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/done", branch: "refs/heads/feature/done" },
      { path: "/repo/worktrees/active", branch: "refs/heads/feature/active" },
    );
    setup_git_mocks({
      worktree_list: porcelain,
      // `+ ` is how real git marks a branch checked out in another worktree —
      // which every worktree-held branch here is. `some-other-branch` has no
      // worktree, so it gets the plain two-space indent.
      merged_branches: "+ feature/done\n  some-other-branch\n",
      rev_parse_missing: [], // both have remote refs
    });

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    await sweep_stale_worktrees(registry as any);

    // Should remove the merged worktree
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/done", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );

    // Should NOT remove the active worktree
    const remove_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    );
    const removed_paths = remove_calls.map((c: unknown[]) => (c[1] as string[])[2]);
    expect(removed_paths).not.toContain("/repo/worktrees/active");
  });

  it("cleans up worktrees whose remote tracking ref is gone", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/orphan", branch: "refs/heads/feature/orphan" },
    );
    setup_git_mocks({
      worktree_list: porcelain,
      merged_branches: "", // not merged
      rev_parse_missing: ["feature/orphan"], // remote ref gone
    });

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    await sweep_stale_worktrees(registry as any);

    // Should remove the orphaned worktree
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/orphan", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("skips repos that do not exist on disk", async () => {
    mock_stat.mockRejectedValue(new Error("ENOENT"));
    setup_git_mocks();

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/nonexistent", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    // Should complete without error
    await expect(sweep_stale_worktrees(registry as any)).resolves.toBeUndefined();

    // Should not have called any git commands
    expect(mock_exec_file).not.toHaveBeenCalled();
  });

  it("never removes the main worktree", async () => {
    const porcelain = make_porcelain({ path: "/repo", branch: "refs/heads/main" });
    setup_git_mocks({
      worktree_list: porcelain,
      merged_branches: "* main\n",
    });

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    await sweep_stale_worktrees(registry as any);

    // Should NOT have called worktree remove at all
    const remove_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    );
    expect(remove_calls).toHaveLength(0);
  });

  it("handles empty entity list gracefully", async () => {
    const registry = {
      get_active: vi.fn().mockReturnValue([]),
    };

    await expect(sweep_stale_worktrees(registry as any)).resolves.toBeUndefined();
  });
});

// ── Issue #27: Worktree cleanup safety guardrail ──

describe("is_worktree_safe_to_remove", () => {
  it("returns safe=true on a clean, fully-pushed worktree", async () => {
    setup_git_mocks({ status_porcelain: "", rev_list_unpushed: "" });
    mock_stat.mockImplementation(stat_without_agent_marker);

    const result = await is_worktree_safe_to_remove("/repo", "/repo/wt/foo", "feature/foo");
    expect(result.safe).toBe(true);
  });

  it("returns safe=true when the worktree directory is already gone (no-op path)", async () => {
    mock_stat.mockRejectedValue(new Error("ENOENT"));
    // Even if status would say dirty, we should never reach it for a missing dir.
    setup_git_mocks({ status_porcelain: " M src/foo.ts" });

    const result = await is_worktree_safe_to_remove(
      "/repo",
      "/repo/wt/already-gone",
      "feature/gone",
    );
    expect(result.safe).toBe(true);
  });

  it("flags uncommitted changes to tracked files", async () => {
    mock_stat.mockImplementation(stat_without_agent_marker);
    setup_git_mocks({
      status_porcelain: " M src/index.ts\n M packages/daemon/src/foo.ts",
      rev_list_unpushed: "",
    });

    const result = await is_worktree_safe_to_remove("/repo", "/repo/wt/dirty", "feature/dirty");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toBe("uncommitted");
      expect(result.detail).toContain("src/index.ts");
    }
  });

  it("flags untracked files separately from uncommitted modifications", async () => {
    mock_stat.mockImplementation(stat_without_agent_marker);
    setup_git_mocks({
      status_porcelain: "?? scratch.md\n?? notes/",
      rev_list_unpushed: "",
    });

    const result = await is_worktree_safe_to_remove(
      "/repo",
      "/repo/wt/untracked",
      "feature/untracked",
    );
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toBe("untracked");
      expect(result.detail).toContain("scratch.md");
    }
  });

  it("prefers the uncommitted reason over untracked when both are present", async () => {
    // A real-world dirty worktree often has both — we want the more urgent
    // signal (lost-on-disk modifications) to win the alert title.
    mock_stat.mockImplementation(stat_without_agent_marker);
    setup_git_mocks({
      status_porcelain: " M src/index.ts\n?? scratch.md",
      rev_list_unpushed: "",
    });

    const result = await is_worktree_safe_to_remove("/repo", "/repo/wt/mixed", "feature/mixed");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toBe("uncommitted");
    }
  });

  it("flags unpushed commits when working tree is otherwise clean", async () => {
    mock_stat.mockImplementation(stat_without_agent_marker);
    setup_git_mocks({
      status_porcelain: "",
      rev_list_unpushed:
        "abc123def456abc123def456abc123def456abcd\n11112222333344445555666677778888aaaabbbb",
    });

    const result = await is_worktree_safe_to_remove("/repo", "/repo/wt/unpushed", "feature/wip");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toBe("unpushed");
      expect(result.detail).toContain("2 unpushed commit");
      expect(result.detail).toContain("abc123de");
    }
  });

  it("reports the true unpushed count even when there are more than 5 commits", async () => {
    // Regression: previously rev-list ran with --max-count=5, so a branch with
    // 50 unpushed commits would be reported as "5 unpushed commit(s)" — a
    // misleading number for Hunter to act on. The fix removes the cap entirely
    // (the list is bounded by branch length and only runs when the branch is
    // already known to be local-only, so the overhead is negligible).
    mock_stat.mockImplementation(stat_without_agent_marker);
    const shas = Array.from(
      { length: 12 },
      (_, i) => `${String(i).padStart(8, "0")}deadbeefdeadbeefdeadbeefdeadbeefdead`,
    );
    setup_git_mocks({
      status_porcelain: "",
      rev_list_unpushed: shas.join("\n"),
    });

    const result = await is_worktree_safe_to_remove("/repo", "/repo/wt/many", "feature/many");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toBe("unpushed");
      // Real count is 12, not capped to 5
      expect(result.detail).toContain("12 unpushed commit");
      // First few SHAs shown
      expect(result.detail).toContain("00000000");
      expect(result.detail).toContain("00000004");
      // "more" indicator should signal there's overflow
      expect(result.detail).toContain("more");
    }

    // The rev-list call must NOT include --max-count
    const rev_list_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "git" && (c[1] as string[])[0] === "rev-list",
    );
    expect(rev_list_calls.length).toBeGreaterThan(0);
    for (const call of rev_list_calls) {
      const args = call[1] as string[];
      const has_max_count = args.some((a) => a.startsWith("--max-count"));
      expect(has_max_count).toBe(false);
    }
  });
});

describe("remove_worktree — issue #27 guardrail", () => {
  it("proceeds with removal when the worktree is clean and pushed", async () => {
    setup_git_mocks({ status_porcelain: "", rev_list_unpushed: "" });
    mock_stat.mockImplementation(stat_without_agent_marker);

    const alert_router = { post_alert: vi.fn() };

    const result = await remove_worktree("/repo", "/repo/wt/clean", "feature/clean", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    expect(result).toBe(true);
    expect(alert_router.post_alert).not.toHaveBeenCalled();
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/wt/clean", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("skips removal and posts an alert for uncommitted changes", async () => {
    setup_git_mocks({ status_porcelain: " M src/work.ts", rev_list_unpushed: "" });
    mock_stat.mockImplementation(stat_without_agent_marker);

    const alert_router = { post_alert: vi.fn() };

    const result = await remove_worktree("/repo", "/repo/wt/dirty", "feature/dirty", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    expect(result).toBe(false);

    // Worktree must NOT have been removed
    const remove_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    );
    expect(remove_calls).toHaveLength(0);

    // Branch must NOT have been deleted
    const branch_delete_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "branch" &&
        (c[1] as string[])[1] === "-d",
    );
    expect(branch_delete_calls).toHaveLength(0);

    // Alert must have fired with action_required tier and recovery hint
    expect(alert_router.post_alert).toHaveBeenCalledTimes(1);
    const payload = alert_router.post_alert.mock.calls[0][0];
    expect(payload.entity_id).toBe("test-entity");
    expect(payload.tier).toBe("action_required");
    expect(payload.title).toContain("Uncommitted");
    expect(payload.body).toContain("/repo/wt/dirty");
    expect(payload.body).toContain("feature/dirty");
    expect(payload.body).toContain("git push -u origin feature/dirty");
  });

  it("skips removal and posts an alert for untracked files", async () => {
    setup_git_mocks({ status_porcelain: "?? scratch.md", rev_list_unpushed: "" });
    mock_stat.mockImplementation(stat_without_agent_marker);

    const alert_router = { post_alert: vi.fn() };

    const result = await remove_worktree("/repo", "/repo/wt/untracked", "feature/notes", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    expect(result).toBe(false);
    expect(alert_router.post_alert).toHaveBeenCalledTimes(1);
    const payload = alert_router.post_alert.mock.calls[0][0];
    expect(payload.title).toContain("Untracked");
    expect(payload.body).toContain("scratch.md");
  });

  it("skips removal and posts an alert for unpushed commits", async () => {
    setup_git_mocks({
      status_porcelain: "",
      rev_list_unpushed: "abc123def456abc123def456abc123def456abcd",
    });
    mock_stat.mockImplementation(stat_without_agent_marker);

    const alert_router = { post_alert: vi.fn() };

    const result = await remove_worktree("/repo", "/repo/wt/unpushed", "feature/wip", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    expect(result).toBe(false);
    expect(alert_router.post_alert).toHaveBeenCalledTimes(1);
    const payload = alert_router.post_alert.mock.calls[0][0];
    expect(payload.title).toContain("Unpushed");
    expect(payload.body).toContain("abc123de");
  });

  it("treats already-removed worktrees as a silent no-op (no alert)", async () => {
    // The worktree directory is gone — stat throws ENOENT
    mock_stat.mockRejectedValue(new Error("ENOENT"));
    // The git worktree remove call should also report "not a working tree"
    setup_git_mocks({
      worktree_remove_error: new Error("fatal: '/repo/wt/gone' is not a working tree"),
    });

    const alert_router = { post_alert: vi.fn() };

    const result = await remove_worktree("/repo", "/repo/wt/gone", "feature/gone", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    // Treated as success (already gone), no alert fired
    expect(result).toBe(true);
    expect(alert_router.post_alert).not.toHaveBeenCalled();
  });

  it("blocks the sweep_repo remote-gone path from nuking unpushed work", async () => {
    // This is the exact bug from issue #27: agent has unpushed commits, sweep
    // sees no origin/<branch> ref, used to call --force remove. Now blocked.
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/wt/wip", branch: "refs/heads/feature/wip" },
    );
    setup_git_mocks({
      worktree_list: porcelain,
      merged_branches: "", // not merged
      rev_parse_missing: ["feature/wip"], // remote ref gone
      status_porcelain: "", // working tree clean
      rev_list_unpushed: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", // but commit is unpushed
    });
    mock_stat.mockImplementation(stat_without_agent_marker);

    const alert_router = { post_alert: vi.fn() };
    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    await sweep_stale_worktrees(registry as any, { alert_router: alert_router as any });

    // Worktree must NOT be removed
    const remove_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    );
    expect(remove_calls).toHaveLength(0);

    // Alert must have fired against the right entity
    expect(alert_router.post_alert).toHaveBeenCalledTimes(1);
    const payload = alert_router.post_alert.mock.calls[0][0];
    expect(payload.entity_id).toBe("test-entity");
    expect(payload.title).toContain("Unpushed");
  });
});

// ── Issue #110: freshly-created worktrees must not be classified as stale ──

describe("is_unstarted_branch", () => {
  const trunk = new Set(["trunk-tip", "trunk-older"]);

  it("treats a branch sitting on the trunk's first-parent history as unstarted", () => {
    expect(is_unstarted_branch("trunk-tip", trunk)).toBe(true);
    expect(is_unstarted_branch("trunk-older", trunk)).toBe(true);
  });

  it("treats a branch tip off the first-parent history as having done work", () => {
    // A branch merged into main via a merge commit lands here: reachable from
    // main, but hanging off a merge's second parent rather than on the chain.
    expect(is_unstarted_branch("side-branch-tip", trunk)).toBe(false);
  });

  it("fails safe when the trunk history is unknown", () => {
    expect(is_unstarted_branch("side-branch-tip", null)).toBe(true);
  });

  it("fails safe when the worktree HEAD is unknown", () => {
    expect(is_unstarted_branch("", trunk)).toBe(true);
  });
});

describe("sweep_stale_worktrees — issue #110 unstarted-branch guardrail", () => {
  const TRUNK = {
    "refs/remotes/origin/main": ["trunk-tip", "trunk-older"],
    "refs/heads/main": ["trunk-tip", "trunk-older"],
  };

  function registry_for(repo = "/repo") {
    return {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: repo, url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };
  }

  it("keeps a brand-new worktree whose branch was never pushed (remote-gone path)", async () => {
    // The incident in #110: worktree created seconds ago, branch tip is still
    // origin/main, `origin/<branch>` has never existed so the remote reads as
    // "gone", and nothing is uncommitted/untracked/unpushed.
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/fresh", branch: "refs/heads/feature/fresh", head: "trunk-tip" },
      ),
      merged_branches: "",
      rev_parse_missing: ["feature/fresh"],
      trunk_first_parent: TRUNK,
    });
    const alert_router = { post_alert: vi.fn() };

    await sweep_stale_worktrees(registry_for() as any, { alert_router: alert_router as any });

    expect(removed_paths()).toHaveLength(0);
    // Not stale-but-unsafe — it is simply not stale, so nobody is paged.
    expect(alert_router.post_alert).not.toHaveBeenCalled();
  });

  it("keeps a brand-new worktree listed as merged into main (merged path)", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/fresh", branch: "refs/heads/feature/fresh", head: "trunk-tip" },
      ),
      // `+ ` — the prefix real git uses for a branch checked out in another
      // worktree, i.e. every agent worktree branch. With the old `^\\* `-only
      // strip this arrived as "+ feature/fresh" and Case 1 never fired at all.
      merged_branches: "+ feature/fresh\n",
      rev_parse_missing: [], // remote ref exists — only the merged test fires
      trunk_first_parent: TRUNK,
    });

    await sweep_stale_worktrees(registry_for() as any);

    expect(removed_paths()).toHaveLength(0);
  });

  it("keeps a worktree created at an older trunk commit after main advanced", async () => {
    // Tip equality alone would not save this one: another team's PR merged
    // after the worktree was created, so the branch is now strictly behind
    // origin/main while still having produced nothing.
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/old", branch: "refs/heads/feature/old", head: "trunk-older" },
      ),
      merged_branches: "+ feature/old\n",
      rev_parse_missing: ["feature/old"],
      trunk_first_parent: TRUNK,
    });

    await sweep_stale_worktrees(registry_for() as any);

    expect(removed_paths()).toHaveLength(0);
  });

  it("still sweeps a merged worktree whose branch has commits of its own", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/done", branch: "refs/heads/feature/done", head: "side-tip" },
      ),
      merged_branches: "  feature/done\n",
      rev_parse_missing: [],
      trunk_first_parent: TRUNK,
    });

    await sweep_stale_worktrees(registry_for() as any);

    expect(removed_paths()).toEqual(["/repo/worktrees/done"]);
  });

  it("still sweeps a remote-gone worktree whose branch has commits of its own", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/orphan", branch: "refs/heads/feature/orphan", head: "side-tip" },
      ),
      merged_branches: "",
      rev_parse_missing: ["feature/orphan"],
      trunk_first_parent: TRUNK,
    });

    await sweep_stale_worktrees(registry_for() as any);

    expect(removed_paths()).toEqual(["/repo/worktrees/orphan"]);
  });

  it("still enforces the #27/#30 preconditions on a worktree that IS stale", async () => {
    // The #110 classifier fix must not become the only line of defense: a
    // branch with its own commits is still classified stale, and the safety
    // guardrail is still what stops the removal.
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/wip", branch: "refs/heads/feature/wip", head: "side-tip" },
      ),
      merged_branches: "",
      rev_parse_missing: ["feature/wip"],
      trunk_first_parent: TRUNK,
      status_porcelain: "?? notes.md\n",
    });
    const alert_router = { post_alert: vi.fn() };

    await sweep_stale_worktrees(registry_for() as any, { alert_router: alert_router as any });

    expect(removed_paths()).toHaveLength(0);
    expect(alert_router.post_alert).toHaveBeenCalledTimes(1);
    expect(alert_router.post_alert.mock.calls[0][0].title).toContain("Untracked");
  });

  it("skips the whole repo when the trunk history cannot be resolved", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/done", branch: "refs/heads/feature/done", head: "side-tip" },
      ),
      merged_branches: "  feature/done\n",
      rev_parse_missing: ["feature/done"],
      trunk_unresolvable: true,
    });

    await sweep_stale_worktrees(registry_for() as any);

    expect(removed_paths()).toHaveLength(0);
  });

  it("spares a .claude/worktrees directory whose own branch has no commits of its own", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({
        path: "/repo",
        branch: "refs/heads/main",
        head: "trunk-tip",
      }),
      merged_branches: "+ feature/fresh\n",
      trunk_first_parent: TRUNK,
      branch_tips: { "feature/fresh": "trunk-tip" },
      worktree_branches: { "/repo/.claude/worktrees/agent-f8e21c04": "feature/fresh" },
    });
    mock_readdir.mockResolvedValue([{ name: "agent-f8e21c04", isDirectory: () => true }]);

    await sweep_stale_worktrees(registry_for() as any);

    expect(removed_paths()).toHaveLength(0);
  });

  it("still sweeps a .claude/worktrees directory whose own branch did work", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({
        path: "/repo",
        branch: "refs/heads/main",
        head: "trunk-tip",
      }),
      merged_branches: "+ feature/done\n",
      trunk_first_parent: TRUNK,
      branch_tips: { "feature/done": "side-tip" },
      worktree_branches: { "/repo/.claude/worktrees/agent-7b4d9a10": "feature/done" },
    });
    mock_readdir.mockResolvedValue([{ name: "agent-7b4d9a10", isDirectory: () => true }]);

    await sweep_stale_worktrees(registry_for() as any);

    expect(removed_paths()).toEqual(["/repo/.claude/worktrees/agent-7b4d9a10"]);
  });

  it("passes the directory's OWN branch to the removal, never the matched one", async () => {
    // The wrong-branch handoff is the load-bearing defect: `remove_worktree`
    // runs #30's unpushed check against whatever branch it is given, so being
    // handed a merged (therefore pushed, therefore "safe") branch while
    // deleting some other branch's directory disables the check entirely.
    setup_git_mocks({
      worktree_list: make_porcelain({
        path: "/repo",
        branch: "refs/heads/main",
        head: "trunk-tip",
      }),
      merged_branches: "+ feature/done\n",
      trunk_first_parent: TRUNK,
      branch_tips: { "feature/done": "side-tip" },
      worktree_branches: { "/repo/.claude/worktrees/agent-7b4d9a10": "feature/done" },
    });
    mock_readdir.mockResolvedValue([{ name: "agent-7b4d9a10", isDirectory: () => true }]);

    await sweep_stale_worktrees(registry_for() as any);

    // The unpushed-commit probe must have been run on the directory's own
    // branch. (Here they coincide by construction — that is the point: the
    // only branch a directory can be removed under is the one it is on.)
    const rev_list_branches = mock_exec_file.mock.calls
      .filter(
        (c: unknown[]) => (c[1] as string[])[0] === "rev-list" && (c[1] as string[])[2] === "--not",
      )
      .map((c: unknown[]) => (c[1] as string[])[1]);
    expect(rev_list_branches).toContain("feature/done");
  });
});

describe("live-agent marker — issue #110 live-session exemption", () => {
  const TRUNK = {
    "refs/remotes/origin/main": ["trunk-tip"],
    "refs/heads/main": ["trunk-tip"],
  };

  it("exports the marker filename so the shield is greppable", () => {
    expect(AGENT_ACTIVE_MARKER).toBe(".lf-agent-active");
  });

  it("detects the marker regardless of git state", async () => {
    mock_stat.mockResolvedValue({ isDirectory: () => false });
    await expect(has_live_agent_marker("/repo/worktrees/held")).resolves.toBe(true);
    expect(mock_stat).toHaveBeenCalledWith("/repo/worktrees/held/.lf-agent-active");
  });

  it("reports no marker when the file is absent", async () => {
    await expect(has_live_agent_marker("/repo/worktrees/free")).resolves.toBe(false);
  });

  it("refuses to remove a marked worktree and posts no alert", async () => {
    setup_git_mocks({});
    mock_stat.mockResolvedValue({ isDirectory: () => true }); // marker present
    const alert_router = { post_alert: vi.fn() };

    const removed = await remove_worktree("/repo", "/repo/worktrees/held", "feature/held", {
      alert_router: alert_router as any,
      entity_id: "test-entity",
    });

    expect(removed).toBe(false);
    expect(removed_paths()).toHaveLength(0);
    // Deliberately held is not stale-but-unsafe — nobody is paged.
    expect(alert_router.post_alert).not.toHaveBeenCalled();
  });

  it("does not relocate tmux panes out of a marked worktree", async () => {
    // Pre-fix the sweep cd'd every live pane out of the directory *first* and
    // only then discovered it could not remove it — a running agent lost its
    // cwd for nothing.
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main", head: "trunk-tip" },
        { path: "/repo/worktrees/held", branch: "refs/heads/feature/held", head: "side-tip" },
      ),
      merged_branches: "+ feature/held\n",
      trunk_first_parent: TRUNK,
      branch_tips: { "feature/held": "side-tip" },
    });
    mock_stat.mockResolvedValue({ isDirectory: () => true }); // marker present
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /repo/worktrees/held\n";
      }
      return "";
    });
    const registry = {
      get_active: vi
        .fn()
        .mockReturnValue([{ entity: { id: "test-entity", repos: [{ path: "/repo", url: "u" }] } }]),
    };

    await sweep_stale_worktrees(registry as any);

    expect(removed_paths()).toHaveLength(0);
    const send_keys = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys).toHaveLength(0);
  });
});
