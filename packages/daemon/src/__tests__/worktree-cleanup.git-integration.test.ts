/**
 * Real-git integration tests for the stale-worktree sweep.
 *
 * Every other test in this area mocks `execFile`, which means it tests our
 * *model* of git rather than git. That is exactly how issue #110 shipped: the
 * mocked suite asserted the sweep removed "merged" and "remote-gone"
 * worktrees, and both of those predicates silently also match a worktree that
 * was created thirty seconds ago. This file builds throwaway repositories on
 * disk and runs the real sweep against them, so the classification is checked
 * against git's actual behavior.
 *
 * Scope: one fixture repo covering every case, one sweep run, assertions per
 * case. Nothing here touches any repo outside its own temp directory.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweep_stale_worktrees } from "../worktree-cleanup.js";

/** Hermetic git env — ignore the host's global/system config and identity. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
}

function commit(cwd: string, name: string, body: string): void {
  writeFileSync(join(cwd, name), `${body}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `add ${name}`);
}

interface AlertPayload {
  entity_id: string;
  tier: string;
  title: string;
  body: string;
}

let root: string;
let repo: string;
const alerts: AlertPayload[] = [];

/** Absolute path of a fixture worktree. */
function wt(name: string): string {
  return join(root, name);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lf-sweep-integration-"));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");

  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  git(repo, "remote", "add", "origin", origin);

  // Trunk: three commits.
  commit(repo, "one.txt", "1");
  commit(repo, "two.txt", "2");
  commit(repo, "three.txt", "3");
  git(repo, "push", "-q", "-u", "origin", "main");
  const older_trunk_commit = git(repo, "rev-parse", "HEAD~2").trim();

  // ── Genuinely stale: committed, pushed, merged into main, remote deleted ──
  git(repo, "worktree", "add", "-q", wt("merged"), "-b", "feature/merged", "origin/main");
  commit(wt("merged"), "merged-work.txt", "shipped");
  git(wt("merged"), "push", "-q", "-u", "origin", "feature/merged");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/merged", "feature/merged");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/merged");

  // ── Issue #110: brand-new worktree at origin/main, nothing written yet ──
  git(repo, "worktree", "add", "-q", wt("fresh"), "-b", "feature/fresh", "origin/main");

  // ── Issue #110 variant: created at an older trunk commit, trunk has since
  // advanced (the merge above). Tip equality alone would not save this one. ──
  git(repo, "worktree", "add", "-q", wt("oldbase"), "-b", "feature/oldbase", older_trunk_commit);

  // ── #30 guardrail: own commit, never pushed ──
  git(repo, "worktree", "add", "-q", wt("unpushed"), "-b", "feature/unpushed", "origin/main");
  commit(wt("unpushed"), "wip.txt", "in progress");

  // ── #30 guardrail: pushed-then-deleted branch, plus an untracked file ──
  git(repo, "worktree", "add", "-q", wt("untracked"), "-b", "feature/untracked", "origin/main");
  commit(wt("untracked"), "untracked-branch-work.txt", "shipped");
  git(wt("untracked"), "push", "-q", "-u", "origin", "feature/untracked");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/untracked", "feature/untracked");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/untracked");
  writeFileSync(join(wt("untracked"), "scratch-notes.md"), "not committed\n");

  // ── #30 guardrail: pushed-then-deleted branch, plus a modified tracked file ──
  git(repo, "worktree", "add", "-q", wt("dirty"), "-b", "feature/dirty", "origin/main");
  commit(wt("dirty"), "dirty-branch-work.txt", "shipped");
  git(wt("dirty"), "push", "-q", "-u", "origin", "feature/dirty");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/dirty", "feature/dirty");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/dirty");
  writeFileSync(join(wt("dirty"), "dirty-branch-work.txt"), "edited after merge\n");

  git(repo, "fetch", "-q", "--prune");

  const registry = {
    get_active: () => [{ entity: { id: "fixture-entity", repos: [{ path: repo, url: origin }] } }],
  };
  const alert_router = {
    post_alert: (payload: AlertPayload) => {
      alerts.push(payload);
      return Promise.resolve();
    },
  };

  await sweep_stale_worktrees(registry as unknown as Parameters<typeof sweep_stale_worktrees>[0], {
    alert_router: alert_router as unknown as never,
  });
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The reason recorded in the unsafe-skip alert for a given worktree, if any. */
function alert_for(name: string): AlertPayload | undefined {
  return alerts.find((a) => a.body.includes(wt(name)));
}

describe("sweep_stale_worktrees against real git — issue #110", () => {
  it("keeps a brand-new worktree whose branch is still at origin/main", () => {
    // Pre-fix this directory was deleted: `git branch --merged main` lists the
    // branch, `origin/feature/fresh` has never existed so the remote looks
    // "gone", and there is nothing uncommitted/untracked/unpushed for the #30
    // guardrail to catch.
    expect(existsSync(wt("fresh"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(wt("fresh"));
  });

  it("keeps a new worktree created at an older trunk commit after main advanced", () => {
    expect(existsSync(wt("oldbase"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(wt("oldbase"));
  });

  it("does not alert about the worktrees it keeps — they are not stale-but-unsafe", () => {
    expect(alert_for("fresh")).toBeUndefined();
    expect(alert_for("oldbase")).toBeUndefined();
  });
});

describe("sweep_stale_worktrees against real git — genuinely stale worktrees", () => {
  it("still sweeps a merged, pushed, remote-deleted worktree", () => {
    expect(existsSync(wt("merged"))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wt("merged"));
  });
});

describe("sweep_stale_worktrees against real git — #30 safety preconditions", () => {
  it("still refuses to remove a worktree with unpushed commits", () => {
    expect(existsSync(wt("unpushed"))).toBe(true);
    expect(alert_for("unpushed")?.title).toContain("Unpushed");
  });

  it("still refuses to remove a stale worktree holding untracked files", () => {
    expect(existsSync(wt("untracked"))).toBe(true);
    expect(alert_for("untracked")?.title).toContain("Untracked");
  });

  it("still refuses to remove a stale worktree holding uncommitted changes", () => {
    expect(existsSync(wt("dirty"))).toBe(true);
    expect(alert_for("dirty")?.title).toContain("Uncommitted");
  });
});
