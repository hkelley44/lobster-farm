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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_ACTIVE_MARKER,
  remove_worktree,
  sweep_stale_worktrees,
} from "../worktree-cleanup.js";

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

/**
 * Absolute path of a fixture worktree under the repo's `.claude/worktrees/`.
 *
 * Names here are deliberately the real shape produced by the Claude Code
 * harness's `EnterWorktree` tool: `agent-<random hex8>`, with no relationship
 * to the branch checked out in them. Each contains one of the merged issue
 * numbers below, which is what the old slug-substring matcher keyed on.
 */
function claude_wt(name: string): string {
  return join(repo, ".claude", "worktrees", name);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lf-sweep-integration-"));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");

  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  git(repo, "remote", "add", "origin", origin);

  // Trunk: a .gitignore plus three commits.
  //
  // `.lf-agent-active` is gitignored HERE, and only here, on purpose. In the
  // real repo it is deliberately NOT ignored, but as long as it is untracked
  // #30's untracked-file check spares a marked worktree all by itself — which
  // is exactly the accident the marker used to rely on, and it would make the
  // marker test below vacuous. Ignoring it in the fixture removes that crutch
  // so the marked worktree survives on the strength of the marker check or
  // not at all.
  writeFileSync(join(repo, ".gitignore"), `.claude/\n${AGENT_ACTIVE_MARKER}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "add .gitignore");
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

  // ── Issue #110 review, finding 1: the `.claude/worktrees/` wrong-branch path.
  //
  // `fix/27` and `fix/30` are real merged branches with real commits — pushed,
  // `--no-ff` merged, remote-deleted, local refs kept so `git branch --merged
  // main` still lists them. Their slugs are "27" and "30", and under this
  // project's `{type}/{issue#}-{slug}` convention a slug that begins with an
  // issue number is the norm; a bare issue number is what a quick local branch
  // looks like. Each one is a substring of exactly one of the harness
  // directory names below — which is all the old matcher needed — and neither
  // directory is on either branch. One merged branch per directory, so the
  // branch-ref deletion that follows one removal cannot accidentally change
  // the verdict on the other.
  for (const [branch, file] of [
    ["fix/27", "twentyseven.txt"],
    ["fix/30", "thirty.txt"],
  ] as const) {
    git(repo, "checkout", "-q", "-b", branch);
    commit(repo, file, "shipped");
    git(repo, "push", "-q", "-u", "origin", branch);
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "push", "-q", "origin", "--delete", branch);
  }

  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });

  // Brand-new harness worktree, nothing written yet — the #110 shape, in the
  // one place the #110 fix did not reach. Spared by the main loop, then
  // deleted by the slug-matched sweep three lines later. Matched by "27".
  git(
    repo,
    "worktree",
    "add",
    "-q",
    claude_wt("agent-9c27a1b5"),
    "-b",
    "feature/live-fresh",
    "origin/main",
  );

  // Harness worktree holding a real, never-pushed commit. #30's unpushed check
  // would catch this — except the old code evaluated it against the matched
  // branch (merged, therefore pushed, therefore "safe") while deleting this
  // directory, so the check reported safe and the work's only checkout went
  // with it. The tracked state is clean, so nothing else protects it. Matched
  // by "30".
  git(
    repo,
    "worktree",
    "add",
    "-q",
    claude_wt("agent-30fe4d82"),
    "-b",
    "feature/live-work",
    "origin/main",
  );
  commit(claude_wt("agent-30fe4d82"), "live-agent-work.txt", "hours of work");

  // ── Issue #110 review, finding 2: the `.lf-agent-active` live-agent shield.
  //
  // Genuinely sweepable in every respect — own commit, pushed, `--no-ff`
  // merged, remote branch deleted, working tree clean — so every other
  // guardrail in the module says "go ahead". The marker is the only thing
  // standing between it and deletion, and it is gitignored (see .gitignore
  // above) so #30's untracked check cannot stand in for it.
  git(repo, "worktree", "add", "-q", wt("marked"), "-b", "feature/marked", "origin/main");
  commit(wt("marked"), "marked-branch-work.txt", "shipped");
  git(wt("marked"), "push", "-q", "-u", "origin", "feature/marked");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/marked", "feature/marked");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/marked");
  writeFileSync(join(wt("marked"), AGENT_ACTIVE_MARKER), "session=live\n");

  // ── Issue #110 review, finding 3: the `+ ` prefix in `git branch --merged`.
  //
  // Merged into main via `--no-ff`, but the remote branch is deliberately NOT
  // deleted, so "remote gone" (Case 2) cannot fire and Case 1 — "branch
  // merged" — is the only route to sweeping it. Since the branch is checked
  // out in a worktree, git lists it as "+ feature/caseone"; stripping only
  // "* " left the marker in the string and Case 1 could never match.
  //
  // Named "caseone" rather than anything containing another fixture's name:
  // several assertions here are substring checks against `git worktree list`,
  // so a fixture whose path contains another's would cross-trip them.
  git(repo, "worktree", "add", "-q", wt("caseone"), "-b", "feature/caseone", "origin/main");
  commit(wt("caseone"), "caseone-work.txt", "shipped");
  git(wt("caseone"), "push", "-q", "-u", "origin", "feature/caseone");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature/caseone", "feature/caseone");
  git(repo, "push", "-q", "origin", "main");

  // ── Issue #110 review, finding 5: squash merge, the project's actual mode.
  //
  // Documents a known pre-existing limitation, not a regression — behavior is
  // identical before and after this change set. See the test body.
  git(repo, "worktree", "add", "-q", wt("squashed"), "-b", "feature/squashed", "origin/main");
  commit(wt("squashed"), "squashed-work.txt", "shipped");
  git(wt("squashed"), "push", "-q", "-u", "origin", "feature/squashed");
  git(repo, "merge", "-q", "--squash", "feature/squashed");
  git(repo, "commit", "-q", "-m", "squash merge feature/squashed");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "--delete", "feature/squashed");

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

/** The unsafe-skip alert mentioning an absolute path, if any. */
function alert_for_path(path: string): AlertPayload | undefined {
  return alerts.find((a) => a.body.includes(path));
}

/** The reason recorded in the unsafe-skip alert for a given worktree, if any. */
function alert_for(name: string): AlertPayload | undefined {
  return alert_for_path(wt(name));
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

describe("sweep_stale_worktrees against real git — .claude/worktrees/ wrong-branch deletion", () => {
  // Review finding 1. `cleanup_claude_worktrees` matched directories by
  // substring of the *target* branch's slug and then handed `remove_worktree`
  // that target branch — a branch with no necessary relationship to the
  // directory being destroyed. The fix matches on each directory's own
  // checked-out branch instead, so the name is never consulted.

  it("keeps a brand-new harness worktree whose name merely contains a merged branch's slug", () => {
    expect(existsSync(claude_wt("agent-9c27a1b5"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(claude_wt("agent-9c27a1b5"));
    expect(alert_for_path(claude_wt("agent-9c27a1b5"))).toBeUndefined();
  });

  it("keeps a harness worktree holding unpushed work that a merged branch's slug matched", () => {
    // The wrong-branch handoff defeated #30 outright here: the unpushed check
    // ran against `fix/30` (pushed) while this directory, on an entirely
    // different branch with a never-pushed commit, was the one deleted.
    expect(existsSync(claude_wt("agent-30fe4d82"))).toBe(true);
    expect(existsSync(join(claude_wt("agent-30fe4d82"), "live-agent-work.txt"))).toBe(true);
    // It IS classified stale by the main loop (its remote never existed), and
    // there #30 sees the right branch and blocks with the right reason.
    expect(alert_for_path(claude_wt("agent-30fe4d82"))?.title).toContain("Unpushed");
  });

  it("had genuinely-merged branches to act on, so the directories were spared on their merits", () => {
    // If `fix/27`/`fix/30` were not merged branches with commits of their own,
    // the two cases above would pass for the wrong reason — the sweep would
    // simply never have considered either directory. Asserted against main's
    // log rather than `git branch --merged`, because the branch refs are
    // themselves collateral: pre-fix, destroying these directories deleted
    // them.
    const trunk_log = git(repo, "log", "--oneline", "main");
    expect(trunk_log).toContain("merge fix/27");
    expect(trunk_log).toContain("merge fix/30");
  });
});

describe("sweep_stale_worktrees against real git — .lf-agent-active shield", () => {
  // Review finding 2, and issue #110's "live-session exemption" acceptance
  // criterion. This worktree is sweepable by every other measure; the marker
  // is the whole reason it survives.

  it("keeps a genuinely sweepable worktree that holds the live-agent marker", () => {
    expect(existsSync(wt("marked"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(wt("marked"));
  });

  it("does not alert about a marked worktree — it is held, not stuck", () => {
    expect(alert_for("marked")).toBeUndefined();
  });

  it("keeps the marker's branch intact", () => {
    // `remove_worktree` deletes the branch after removing the directory, so a
    // surviving branch ref is independent evidence it never got that far.
    expect(git(repo, "branch", "--list", "feature/marked")).toContain("feature/marked");
  });
});

describe("sweep_stale_worktrees against real git — genuinely stale worktrees", () => {
  it("still sweeps a merged, pushed, remote-deleted worktree", () => {
    expect(existsSync(wt("merged"))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wt("merged"));
  });

  it("sweeps a merged worktree whose remote branch still exists (Case 1 only)", () => {
    // Review finding 3. `git branch --merged` prefixes "+ " for a branch
    // checked out in another worktree, so this branch arrived as
    // "+ feature/caseone", `merged_branches.has(...)` was always false, and
    // Case 1 was dead for every worktree-held branch. Nothing else can reach
    // this fixture: its remote ref is intact, so Case 2 does not fire.
    expect(git(repo, "rev-parse", "--verify", "refs/remotes/origin/feature/caseone")).toBeTruthy();
    expect(existsSync(wt("caseone"))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(wt("caseone"));
  });
});

describe("sweep_stale_worktrees against real git — known limitation: squash merge", () => {
  it("does NOT sweep a squash-merged worktree, and alerts about it every run", () => {
    // Review finding 5. This project merges with `gh pr merge --squash`, which
    // rewrites the branch's commit into a new one on main. The branch's own
    // commit is then unreachable from every remote ref, so #30 reports it
    // unpushed and blocks the removal — forever, re-alerting on every hourly
    // sweep. Pre-existing and unchanged by this work (already logged in
    // MEMORY.md as the healthydogs alert-spam gap); asserted here so the
    // limitation lives in the suite instead of only in a memory file.
    expect(existsSync(wt("squashed"))).toBe(true);
    expect(alert_for("squashed")?.title).toContain("Unpushed");
  });
});

describe("resolve_worktree_branch against real git — what `symbolic-ref` actually answers", () => {
  // Issue #110 review round 2, finding N1.
  //
  // `symbolic-ref --short HEAD` does not report the branch checked out in the
  // directory you hand it. It reports the branch of whatever repository
  // *encloses* that directory, because git walks up the tree. Two shapes
  // therefore resolve to a branch that is not checked out where we are
  // pointing — which is the wrong-branch handoff finding 1 was about,
  // reappearing inside the function written to fix it:
  //
  //   - a plain leftover directory  -> the enclosing repo's current branch
  //   - an unrelated nested repo    -> that repo's own branch
  //
  // Neither is hypothetical: `.claude/worktrees/` is a plain directory that
  // the harness fills, and a directory left behind by a crashed `git worktree
  // add`, or a vendored checkout parked there by hand, is exactly shape one
  // and shape two. The mocked suite could not catch this, because it was
  // mocking `symbolic-ref` to throw for both — asserting our *belief* about
  // git rather than git. Hence a real repository.
  //
  // This fixture is deliberately separate from the one above: it needs the
  // main checkout to sit on a merged feature branch (that is what makes the
  // plain-directory shape reachable), which would perturb every assertion in
  // the shared fixture.

  let n1_root: string;
  let n1_repo: string;
  const n1_alerts: AlertPayload[] = [];

  /** A directory under this fixture's `.claude/worktrees/`. */
  function entry(name: string): string {
    return join(n1_repo, ".claude", "worktrees", name);
  }

  beforeAll(async () => {
    // `realpathSync` deliberately. `sweep_repo` identifies the main working
    // tree by string-comparing the configured repo path against the path in
    // `git worktree list --porcelain`, and git answers in *physical* form — so
    // under a symlinked root (macOS `/var` -> `/private/var`) that comparison
    // misses and the main checkout is treated as a sweepable worktree. That is
    // a pre-existing defect, byte-identical on `main`, and it only becomes
    // visible when the main checkout is on a non-`main` branch — which this
    // fixture needs. It is not this fixture's subject, so it is normalized away
    // here rather than silently steering the assertions below.
    n1_root = realpathSync(mkdtempSync(join(tmpdir(), "lf-sweep-resolve-")));
    const origin = join(n1_root, "origin.git");
    n1_repo = join(n1_root, "repo");

    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { env: GIT_ENV });
    execFileSync("git", ["init", "-q", "-b", "main", n1_repo], { env: GIT_ENV });
    git(n1_repo, "remote", "add", "origin", origin);

    // No `.gitignore` for `.claude/` here, on purpose: it is what makes the
    // plain-directory shape's damage observable. Pre-fix, the #27 status probe
    // for that directory runs in the *enclosing* working tree, so it reports
    // the enclosing repo's untracked files and an alert fires naming a
    // directory that was never a worktree. Post-fix there is no alert at all.
    commit(n1_repo, "base.txt", "base");
    git(n1_repo, "push", "-q", "-u", "origin", "main");

    // `feature/target` — merged, pushed, remote ref retained, and NOT checked
    // out anywhere, so `git branch -d` would succeed on it. This is the ref
    // the nested-repo shape destroys.
    git(n1_repo, "checkout", "-q", "-b", "feature/target");
    commit(n1_repo, "target-work.txt", "shipped");
    git(n1_repo, "push", "-q", "-u", "origin", "feature/target");
    git(n1_repo, "checkout", "-q", "main");
    git(n1_repo, "merge", "-q", "--no-ff", "-m", "merge feature/target", "feature/target");

    // `feature/enclosing` — merged with commits of its own (so the sweep
    // considers it a removal target) and left checked out in the main working
    // tree, which is what a plain subdirectory's HEAD resolves to.
    git(n1_repo, "checkout", "-q", "-b", "feature/enclosing");
    commit(n1_repo, "enclosing-work.txt", "shipped");
    git(n1_repo, "push", "-q", "-u", "origin", "feature/enclosing");
    git(n1_repo, "checkout", "-q", "main");
    git(n1_repo, "merge", "-q", "--no-ff", "-m", "merge feature/enclosing", "feature/enclosing");
    git(n1_repo, "push", "-q", "origin", "main");
    git(n1_repo, "checkout", "-q", "feature/enclosing");

    mkdirSync(join(n1_repo, ".claude", "worktrees"), { recursive: true });

    // Shape A — a plain directory. `git -C <dir> symbolic-ref --short HEAD`
    // here prints `feature/enclosing`.
    mkdirSync(entry("plain-leftover"), { recursive: true });
    writeFileSync(join(entry("plain-leftover"), "leftover.txt"), "someone's notes\n");

    // Shape E — an independent repository whose own branch happens to be
    // named like one of ours. Nothing about it belongs to this repo.
    execFileSync("git", ["init", "-q", "-b", "feature/target", entry("vendored")], {
      env: GIT_ENV,
    });
    commit(entry("vendored"), "vendored.txt", "not ours");

    // Shape C — a real worktree whose metadata has been pruned out from under
    // it. Every git command inside it fails.
    git(n1_repo, "worktree", "add", "-q", entry("agent-pruned"), "-b", "feature/pruned", "main");
    rmSync(join(n1_repo, ".git", "worktrees", "agent-pruned"), { recursive: true, force: true });

    // Shape D — detached HEAD. `symbolic-ref` genuinely fails here.
    git(n1_repo, "worktree", "add", "-q", "--detach", entry("agent-detached"), "main");

    git(n1_repo, "fetch", "-q", "--prune");

    const registry = {
      get_active: () => [{ entity: { id: "n1-entity", repos: [{ path: n1_repo, url: origin }] } }],
    };
    const alert_router = {
      post_alert: (payload: AlertPayload) => {
        n1_alerts.push(payload);
        return Promise.resolve();
      },
    };

    await sweep_stale_worktrees(
      registry as unknown as Parameters<typeof sweep_stale_worktrees>[0],
      {
        alert_router: alert_router as unknown as never,
      },
    );
  }, 60_000);

  afterAll(() => {
    if (n1_root) rmSync(n1_root, { recursive: true, force: true });
  });

  it("had both shapes reachable, so the cases below are not passing by default", () => {
    // Without this, every assertion here would be satisfied by a sweep that
    // simply never looked. Both resolvable shapes point at a branch the sweep
    // is genuinely targeting this run: `feature/enclosing` (what the plain
    // directory resolves to) and `feature/target` (the nested repo's branch).
    // Both are merged into main with commits of their own, so both survive the
    // #110 unstarted-branch filter and reach `cleanup_claude_worktrees`.
    const merged = git(n1_repo, "branch", "--merged", "main").split("\n");
    const names = merged.map((line) => line.trim().replace(/^[*+]\s+/, ""));
    expect(names).toContain("feature/enclosing");
    expect(names).toContain("feature/target");
    expect(git(n1_repo, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature/enclosing");
    // And git really does answer for the enclosing repo, not the directory.
    expect(git(entry("plain-leftover"), "symbolic-ref", "--short", "HEAD").trim()).toBe(
      "feature/enclosing",
    );
    expect(git(entry("vendored"), "symbolic-ref", "--short", "HEAD").trim()).toBe("feature/target");
  });

  it("leaves a plain directory alone, and never treats it as a worktree", () => {
    expect(existsSync(entry("plain-leftover"))).toBe(true);
    expect(existsSync(join(entry("plain-leftover"), "leftover.txt"))).toBe(true);
    // Pre-fix this directory was matched and handed to `remove_worktree`,
    // which refused it only because the #27 probe — running in the enclosing
    // working tree — found the repo's untracked files and alerted about a
    // directory that is not a worktree at all. git's own refusals (`worktree
    // remove` declines a non-worktree) were the rest of the safety. Now the
    // directory is never considered, so there is nothing to alert about.
    expect(n1_alerts.find((a) => a.body.includes(entry("plain-leftover")))).toBeUndefined();
  });

  it("leaves an unrelated nested repo alone, and keeps OUR branch of the same name", () => {
    expect(existsSync(join(entry("vendored"), "vendored.txt"))).toBe(true);
    // The load-bearing assertion. Pre-fix, the nested repo's `feature/target`
    // matched our merged `feature/target`, the #27/#30 probes ran against the
    // nested repo's clean tree and our pushed branch, `git worktree remove`
    // no-op'd with "not a working tree" — and then `git branch -d
    // feature/target` deleted OUR ref. git refuses that one only when the
    // branch is checked out somewhere, and this one is not.
    expect(git(n1_repo, "branch", "--list", "feature/target")).toContain("feature/target");
  });

  it("leaves pruned-metadata and detached-HEAD directories alone", () => {
    expect(existsSync(entry("agent-pruned"))).toBe(true);
    expect(existsSync(entry("agent-detached"))).toBe(true);
  });

  it("raises no alerts at all — nothing here is stale-but-unsafe", () => {
    expect(n1_alerts).toEqual([]);
  });
});

describe("remove_worktree against real git — the branch-identity invariant", () => {
  // `remove_worktree` is exported and its contract says `branch` must be the
  // branch checked out in `worktree_path`, because #30's unpushed check is
  // evaluated against `branch` while the directory destroyed is
  // `worktree_path`. Every caller in this module is correct, so the invariant
  // used to hold by convention alone — at an exported boundary, for the exact
  // parameter whose misuse destroyed work (#110 review, finding 1). It is now
  // enforced in the function. Both directions in one test, against real git.

  let inv_root: string;

  afterAll(() => {
    if (inv_root) rmSync(inv_root, { recursive: true, force: true });
  });

  it("refuses a mismatched branch, and still removes on a correct one", async () => {
    inv_root = realpathSync(mkdtempSync(join(tmpdir(), "lf-invariant-")));
    const origin = join(inv_root, "origin.git");
    const inv_repo = join(inv_root, "repo");

    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], { env: GIT_ENV });
    execFileSync("git", ["init", "-q", "-b", "main", inv_repo], { env: GIT_ENV });
    git(inv_repo, "remote", "add", "origin", origin);
    commit(inv_repo, "base.txt", "base");
    git(inv_repo, "push", "-q", "-u", "origin", "main");

    // Two worktrees, both sweepable on their own merits: own commit, pushed,
    // merged into main, clean tree, no marker. Nothing but the invariant
    // stands between either of them and removal.
    for (const name of ["live", "done"] as const) {
      git(inv_repo, "worktree", "add", "-q", join(inv_root, name), "-b", `feature/${name}`, "main");
      commit(join(inv_root, name), `${name}.txt`, "shipped");
      git(join(inv_root, name), "push", "-q", "-u", "origin", `feature/${name}`);
      git(inv_repo, "merge", "-q", "--no-ff", "-m", `merge feature/${name}`, `feature/${name}`);
    }
    git(inv_repo, "push", "-q", "origin", "main");

    // Direction A: name the wrong branch. `feature/done` is merged and pushed,
    // so #30 would wave this through — which is precisely why being handed the
    // wrong branch is dangerous rather than merely untidy.
    const refused = await remove_worktree(inv_repo, join(inv_root, "live"), "feature/done");

    expect(refused).toBe(false);
    expect(existsSync(join(inv_root, "live", "live.txt"))).toBe(true);
    expect(git(inv_repo, "worktree", "list")).toContain(join(inv_root, "live"));
    // Neither branch may be touched: not the directory's own, not the one the
    // caller wrongly named.
    expect(git(inv_repo, "branch", "--list", "feature/live")).toContain("feature/live");
    expect(git(inv_repo, "branch", "--list", "feature/done")).toContain("feature/done");

    // Direction B: name the right branch for the same shape of worktree, so
    // the refusal above cannot be some unrelated guardrail firing.
    const removed = await remove_worktree(inv_repo, join(inv_root, "done"), "feature/done");

    expect(removed).toBe(true);
    expect(existsSync(join(inv_root, "done"))).toBe(false);
    expect(git(inv_repo, "branch", "--list", "feature/done")).toBe("");
  }, 60_000);
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
