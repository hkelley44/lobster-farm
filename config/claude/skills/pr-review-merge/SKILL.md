---
name: pr-review-merge
description: >
  PR review and merge workflow. Auto-loads when reviewing pull requests,
  handling review feedback, merging code, or resolving merge conflicts.
  Works for any PR on any entity repo.
---

# PR Review-Merge SOP

_How pull requests get reviewed, fixed, and merged in LobsterFarm._

---

## Overview

Any PR on any entity repo triggers this SOP — whether from a planned feature, a manual push, or an external contributor.

```
PR opened → Review → Changes needed? → Fix → Re-review → E2E → Merge
                         │                        ↑
                         └── Loop until clean ─────┘
                            (cap: 3 cycles)
```

The full loop runs autonomously by default. Hunter is pulled in only at the staging gate (when `origin/staging` exists) or via the standing escalation rules (production, money, auth, irreversible, security). The cycle cap is hard at 3 — a 4th iteration triggers an escalation instead of another round.

## Trigger

The daemon monitors entity repos for open PRs via a periodic check (cron). For each entity, for each repo in `entity.repos`, it runs:

```bash
gh pr list --repo {url} --state open --json number,title,headRefName,updatedAt
```

When a new or updated PR is found that isn't already being processed, the daemon triggers this SOP.

## Steps

### 1. Review

Spawn a reviewer agent scoped to the PR.

The reviewer:
- Loads `review-dna` for our review standards (priority order, comment format, frontend criteria, CI awareness, E2E classification, spec-gap heuristic)
- **Counts prior review cycles** via `gh pr view <n> --json reviews` before starting. Each prior `Reviewer`-authored review (or findings comment with a `Verdict:` line) is a cycle.
- Runs `/ultrareview` (Claude Code's parallel multi-agent PR review) for comprehensive analysis
- Posts the review on the PR via `gh`
- Verdict: **Approved** or **Changes Requested** — never ambiguous

**Cycle cap (hard limit: 3):**

```bash
gh pr view <n> --json reviews --jq '[.reviews[] | select(.author.login == "<reviewer-login>")] | length'
```

- `0` prior cycles → this is cycle 1, proceed normally
- `1` prior → cycle 2, proceed normally
- `2` prior → cycle 3, this is the last allowed Changes Requested round; if it would request changes, the next iteration will escalate
- `3` prior → **do not run another review round.** Post an escalation to #alerts pinging Hunter with: PR link, summary of the disagreement, both positions, recommended path forward. Then stop. Wait for Hunter to break the tie.

**Spec-gap pause does not count as a cycle.** If the reviewer flags a spec gap (per the `review-dna` heuristic) instead of requesting changes, the loop pauses pending Tidus's clarification. The cycle counter is unchanged.

**Self-approval blocker — single-dev repos:** GitHub blocks `gh pr review --approve` on PRs the reviewer authored. In single-committer repos (currently all of LobsterFarm), the Reviewer cannot post a formal Approved review. Instead, post a **findings comment** with the verdict line `**Verdict: Approved**` (or `**Verdict: Changes Requested**`) as the first line. The merge step (4) treats a findings-comment Approved verdict as a valid signal — no formal GitHub approval is required for the autonomous loop to proceed. If a second human committer ever joins and the gh path unblocks, switch back to `gh pr review --approve`.

**Escalation:** If the reviewer has questions about intent or requirements that can't be answered from the spec, follow the spec-gap escalation in `review-dna` (ping Tidus, do not increment cycle). If the question is operational (production, money, auth, etc.), escalate to Hunter in #alerts and wait.

### 2. Fix (if changes requested)

If the review requests changes, spawn a builder agent (Ben) on the PR branch.

Ben:
- Reads the review comments
- Addresses each blocking issue
- Runs `/simplify` to clean up the code
- **Self-smoke-tests before pushing** (see `coding-dna` → "Self-smoke-test before every push"). Canonical command for this repo: `scripts/run-tests-isolated.sh pnpm -r test`. Do not push a known-broken state — burning a Reviewer cycle on a red suite is the cheapest mistake to avoid.
- Commits and pushes

**Escalation:** If a review comment requires a design decision or scope change, Ben escalates to #alerts rather than guessing. Wait for input, then continue.

### 3. Re-review

After fixes are pushed, loop back to step 1. A fresh reviewer session — no memory of the previous review. Fresh eyes every time. The cycle counter (read from `gh pr view --json reviews`) tells the new Reviewer where it sits in the loop budget.

The loop continues until the Reviewer would post Approved — at which point step 3.5 fires before the merge.

### 3.5. E2E (final iteration only)

This step runs **once**, at the moment the Reviewer would otherwise post the final Approved verdict. It does not run on every loop iteration — that would 3× the cost of every feature for no benefit. The deep pass happens at the end.

The Reviewer:

- Detects the repo's E2E surface:
  - Playwright: presence of `playwright.config.{ts,js}` or a `playwright/` directory
  - Other E2E suites: `cypress/`, `e2e/`, or a `pnpm test:e2e` script in `package.json`
- Runs all E2E suites it found (under `scripts/run-tests-isolated.sh` if available, to avoid the macOS coalition kill)
- Exercises the feature end-to-end with the available access tools — playwright MCP for browser flows, direct DB queries for persistence checks, `curl` or HTTP clients for API surfaces, whatever the feature actually touches
- Classifies findings using the E2E rubric in `review-dna` (blocking vs. non-blocking)
- Posts the E2E results as a single PR comment with both lists clearly headed

**If any blocking finding:** flip the verdict to **Changes Requested**. This counts as a cycle (subject to the cap). Loop back to step 2.

**If no blocking findings:** post the final Approved verdict (findings comment with `**Verdict: Approved**` per the self-approval workaround in step 1). Daemon proceeds to step 4.

**E2E flake policy:** if a test fails, re-run that single test once. If it passes on the second run, treat the first failure as flake — note it in the E2E comment but don't block. If it fails twice, treat it as real and classify per the rubric.

### 4. Merge — terminal step (branch-aware)

The terminal step depends on whether the repo has a staging branch. Detect with:

```bash
git ls-remote --heads origin staging | grep -q refs/heads/staging
```

Branch existence is the only signal — no per-repo config flag. If the repo grows a staging branch later, the loop picks it up automatically on the next run.

#### 4a. Repo has `origin/staging` — staging gate applies

1. **Check for conflicts** — `gh pr view {number} --json mergeable`
2. **Resolve conflicts** if needed (per the rebase rules in 4b below)
3. **Squash-merge the PR into `staging`:**
   ```bash
   gh pr merge {number} --squash --delete-branch --base staging
   ```
   (If the PR was opened against `main`, change its base to `staging` first: `gh pr edit {number} --base staging`.)
4. **Post step-by-step test instructions** in two places — same content, two formats:
   - **Discord post in #work-log:**
     ```
     Feature <title> is on staging. Test plan:
     1. <first concrete step — open URL, run command, etc.>
     2. <second step>
     3. <verify W>
     ...
     PR: <link>
     ```
   - **PR comment** — same steps, formatted as a markdown checklist Hunter can tick through:
     ```markdown
     ## Staging test plan
     - [ ] <step 1>
     - [ ] <step 2>
     - [ ] <verify W>
     ```
5. **Post in #alerts** pinging Hunter: "Feature <title> ready for staging test — see #work-log and PR <link>"
6. **Wait for Hunter's ✅** (or explicit "go" / "ship it" / "hold" message in #alerts). 24h re-ping rule applies — if no response in 24h, re-ping once with the same content.
7. **Never auto-promote.** No timeout, no default-to-yes. Hunter's explicit signal is the only thing that advances to step 4a.next.

##### 4a.next. Promote staging → main (after Hunter's ✅)

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git merge --ff-only origin/staging
git push origin main
```

Fast-forward only — if `main` has diverged from `staging` and a fast-forward isn't possible, escalate to #alerts with the divergence details and wait. Don't merge with a merge commit, don't rebase, don't force-push.

After the promotion:
- Notify #work-log: "Feature <title> shipped to main."
- The GitHub issue auto-closes via the PR's `Closes #<issue>` line (which followed the PR through both merges).

#### 4b. Repo has only `origin/main` — autonomous merge

1. **Check for conflicts** — `gh pr view {number} --json mergeable`
2. **If clean** — squash merge: `gh pr merge {number} --squash --delete-branch`
3. **If conflicts:**
   - Attempt a clean rebase: `git rebase main` on the PR branch
   - If the rebase is straightforward (no manual resolution needed), push and merge
   - If the rebase requires decisions (conflicting changes in the same area), escalate to #alerts with the conflict details and wait for guidance
4. **Post-merge** — notify #work-log

The autonomous loop completes here for main-only repos. No further steps required.

## Agent Behavior During Build

This applies to the fix step above:

**Agents should surface discoveries.** Plans drift during implementation. New information emerges. When an agent discovers something that could affect a decision or the outcome — a gotcha, a better approach, a dependency that changes the scope — it should ask, not assume.

This isn't about asking permission for every line of code. It's about being a collaborator. If the agent has a genuine question, it surfaces it via #alerts. If it doesn't, it keeps building.

**Before pushing, run `/simplify`** to catch cleanup opportunities. Less noise for the reviewer.

## What the Daemon Does vs What Agents Do

**Daemon (deterministic):**
- Poll repos for open PRs
- Trigger review-merge SOP for new/updated PRs
- Spawn reviewer and builder agents
- Track which PRs are being processed
- Handle merge mechanics (squash, rebase)

**Agents (intelligent):**
- Review code against standards
- Count cycles (via `gh pr view --json reviews`) and enforce the cap
- Detect the staging-vs-main terminal path (via `git ls-remote --heads origin staging`)
- Run the final-iteration E2E pass and classify findings
- Fix review feedback and self-smoke-test before pushing
- Decide what to escalate vs handle autonomously
- Run `/ultrareview`, `/simplify`

Cycle counting and branch detection are agent-side responsibilities for v1. A future v2 may move cycle counts into the daemon (more reliable than `gh` API at scale), but `gh`-based counting is fine at LobsterFarm volume today.

## What NOT to Do

- Don't merge without a passing review — even for "trivial" changes
- Don't skip the re-review after fixes — the reviewer needs to confirm
- Don't skip the final E2E pass — the deep pass is what catches the bugs unit tests miss
- Don't run E2E on every iteration — it's the final-step gate, not a per-cycle tax
- Don't force-merge past conflicts without understanding them
- Don't auto-resolve merge conflicts that touch the same logic — escalate
- Don't hold a PR open waiting for a response longer than 24h without re-pinging
- Don't loop past 3 cycles — escalate to Hunter instead, the loop has exhausted its budget
- Don't auto-promote staging → main — Hunter's ✅ is the only valid signal, no timeout fallback
