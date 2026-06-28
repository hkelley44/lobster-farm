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

## Critical — never `cd <path> && git ...` in any step below

PR review and merge is where worktree-touching shell commands cluster: `git worktree list`, `git worktree remove`, `git branch -D`, `git fetch`, `git rebase`, the post-merge cleanup recipe in `MEMORY.md`. Every one of these must run as `git -C <path> <subcommand>`. The `cd <path> && git ...` compound shape is intercepted by the Claude Code harness's bare-repository safety backstop, which always prompts for approval — even under `--permission-mode bypassPermissions` — and unanswered prompts in pool-bot sessions cause the agent to exit and the daemon to crash-loop on restart. Crash data from issue #55 showed these crashes cluster around PR review/merge activity specifically because this is the venue where the bad shape is most likely to be emitted.

The full rationale and the universal `-C` translation rules live in `coding-dna` → "Git in non-cwd directories." Read that section if you haven't. The short version for this SOP: write `git -C worktrees/<slug> status`, never `cd worktrees/<slug> && git status`. Same for every git subcommand used in any step below, including the post-merge cleanup.

## Steps

### 0. Acquire the review lease before spawning a reviewer

**Run this before every reviewer spawn.** Three independent paths spawn reviewer subagents for a PR: the daemon's autonomous review-merge cron, the GitHub webhook handler, and Hunter's manual "review PR <n>" requests routed through Tidus. Without a shared lock, two of them can land on the same PR at once (observed PR #41 2026-05-09 and PR #54 2026-05-11), wasting a cycle and producing conflicting findings comments.

Layer 2 (issue #60) closes the race with a daemon-side **per-PR review mutex**. Before spawning, the orchestrator acquires a lease; whoever holds it owns the review. The cron and webhook paths acquire their own leases in-process — Tidus acquires over the daemon HTTP API (port 7749).

Required actions for Tidus (or whichever orchestrator is about to spawn the reviewer):

1. **Acquire the lease** for the PR (`OWNER/REPO` is the GitHub `owner/repo` slug, `NUM` the PR number):
   ```bash
   curl -fsS -X POST "http://localhost:7749/pr/OWNER/REPO/NUM/review-lease" \
     -H 'Content-Type: application/json' \
     -d '{"holder":"tidus-manual"}' -w '\n%{http_code}'
   ```
2. **On `200`** → you hold the lease. Proceed to step 1 (spawn the reviewer).
3. **On `409`** → another holder (the cron or webhook) is already reviewing this PR. The response body carries the `current_lease` (holder, `acquired_at`, `expires_at`). Do **not** spawn. Surface to Hunter on Discord: "the daemon is reviewing PR #NUM right now (holder X, started Y, expires Z) — watching for completion." Hunter's explicit "fresh pass" instruction is the only thing that overrides this. Optionally confirm the in-flight state with `GET /pr/OWNER/REPO/NUM/review-state`.
4. **After the Reviewer posts its verdict** → release the lease so a legitimate re-review can proceed:
   ```bash
   curl -fsS -X DELETE "http://localhost:7749/pr/OWNER/REPO/NUM/review-lease" \
     -H 'Content-Type: application/json' \
     -d '{"holder":"tidus-manual"}' -w '\n%{http_code}'
   ```
   (A lease also auto-expires after its TTL — 20 min by default, tunable via `pr_cron.review_lease_ttl_ms` — so a crashed orchestrator can never deadlock a PR.)

**FAIL-OPEN.** The mutex must never block all reviews. If the daemon HTTP call errors or times out (`curl` non-zero exit, connection refused, 5xx), **fall back to the Layer 1 pre-flight** and proceed:

```bash
gh pr view <num> --json reviews,latestReviews,state,statusCheckRollup
gh pr view <num> --json comments --jq \
  '[.comments[] | select(.body | startswith("**Verdict:")) | {created: .createdAt, verdict: (.body | split("\n")[0])}] | sort_by(.created) | last'
```

If that shows a reviewer pass within the last ~10 min, surface it to Hunter instead of spawning (Layer 1 behavior). If not, spawn. The cost of one duplicate review is small; the cost of blocking every review because the daemon is briefly unreachable is high — so on doubt, proceed.

### 1. Review

Spawn a reviewer agent scoped to the PR.

The reviewer:
- Loads `review-dna` for our review standards (priority order, comment format, frontend criteria, CI awareness, E2E classification, spec-gap heuristic)
- **Counts prior review cycles** before starting (see the "Cycle cap" block below — multi-dev mode counts formal reviews, single-dev mode counts findings comments). Each prior `Reviewer`-authored review or findings comment with a `**Verdict:` line is a cycle.
- Runs `/ultrareview` (Claude Code's parallel multi-agent PR review) for comprehensive analysis
- Posts the review on the PR via `gh`
- Verdict: **Approved** or **Changes Requested** — never ambiguous

**Cycle cap (hard limit: 3):**

The Reviewer counts prior cycles before starting. The query depends on whether this is a multi-dev or single-dev repo — detect by comparing the Reviewer's GitHub login to the PR author's login:

```bash
REVIEWER_LOGIN=$(gh api user --jq '.login')
PR_AUTHOR=$(gh pr view <n> --json author --jq '.author.login')
```

**Mode 1 — Multi-dev repo (`$REVIEWER_LOGIN` ≠ `$PR_AUTHOR`):** count formal `PullRequestReview` entries authored by the Reviewer.

```bash
gh pr view <n> --json reviews --jq --arg login "$REVIEWER_LOGIN" \
  '[.reviews[] | select(.author.login == $login)] | length'
```

**Mode 2 — Single-dev repo (`$REVIEWER_LOGIN` == `$PR_AUTHOR`, currently all of LobsterFarm):** GitHub blocks `gh pr review --approve` on self-authored PRs, so the Reviewer posts findings comments instead of formal reviews (see "Self-approval blocker" below). Count those findings comments instead.

```bash
gh pr view <n> --json comments --jq \
  '[.comments[] | select(.body | startswith("**Verdict:"))] | length'
```

Whichever count applies, interpret it the same way:

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

After fixes are pushed, loop back to step 1. A fresh reviewer session — no memory of the previous review. Fresh eyes every time. The cycle counter (read per the mode-aware query in step 1) tells the new Reviewer where it sits in the loop budget.

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
3. **Squash-merge the PR into `staging`** — `gh pr merge` has no `--base` flag, so this is two explicit steps:
   ```bash
   # If PR was opened against main, reroute it first:
   gh pr edit {number} --base staging
   # Then merge:
   gh pr merge {number} --squash --delete-branch
   ```
   If the PR is already based on `staging`, skip the `gh pr edit` and run the merge directly.
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
- Count cycles (via `gh pr view --json reviews` in multi-dev mode, `--json comments` in single-dev mode) and enforce the cap
- Detect the staging-vs-main terminal path (via `git ls-remote --heads origin staging`)
- Run the final-iteration E2E pass and classify findings
- Fix review feedback and self-smoke-test before pushing
- Decide what to escalate vs handle autonomously
- Run `/ultrareview`, `/simplify`

Cycle counting and branch detection are agent-side responsibilities for v1. A future v2 may move cycle counts into the daemon (more reliable than `gh` API at scale, and removes the multi-dev/single-dev branching), but `gh`-based counting is fine at LobsterFarm volume today.

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
- Don't spawn a reviewer without first acquiring the review lease (step 0) — the lease is the shared mutex across all three spawn paths (daemon cron, GitHub webhook, this manual SOP); skipping it lets two reviewers collide on the same PR and produce conflicting findings
- Don't emit `cd <path> && git ...` compounds anywhere in this SOP — use `git -C <path> ...` for every git invocation against a non-cwd repo or worktree (the harness backstop crash-loops pool bots; see the "Critical" callout near the top of this file)

## Worked example — the lease catches a duplicate

Hunter posts in Discord: "review PR 41".

Tidus, before spawning a reviewer, tries to acquire the lease (owner/repo `hkelley44/lobster-farm`, PR 41):

```bash
curl -fsS -X POST "http://localhost:7749/pr/hkelley44/lobster-farm/41/review-lease" \
  -H 'Content-Type: application/json' \
  -d '{"holder":"tidus-manual"}'
```

The daemon cron already grabbed the lease four minutes ago, so the POST returns **409** with the current holder:

```json
{ "current_lease": { "holder": "daemon-cron", "expires_at": "2026-06-27T21:36:00Z" } }
```

Tidus does **not** spawn a new reviewer — the cron's reviewer is already (or about to be) in flight. Instead, Tidus replies on Discord:

> A review is already in flight on PR 41 — the daemon cron acquired the review lease ~4 min ago (`daemon-cron`, lease expires 21:36Z). I'm holding off so we don't run two reviewers against the same PR.
>
> I'll let the cron's pass land and report its verdict. Want me to force a fresh pass anyway?

Tidus then waits for the in-flight pass to finish (the cron releases the lease on completion) and surfaces its verdict, or waits for Hunter's explicit "fresh pass" to override.

**Fail-open note:** if the lease POST fails to reach the daemon (connection refused, timeout, non-JSON body), Tidus does **not** block. It falls back to the Layer 1 `gh pr view 41 --json reviews,latestReviews,state` duplicate check and proceeds — a degraded daemon must never freeze all reviews.
