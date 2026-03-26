---
name: pr-review-merge
description: >
  PR review and merge workflow. Auto-loads when reviewing pull requests,
  handling review feedback, merging code, or resolving merge conflicts.
  Independent of the feature lifecycle — works for any PR on any entity repo.
---

# PR Review-Merge SOP

_How pull requests get reviewed, fixed, and merged in LobsterFarm._

---

## Overview

This SOP runs independently of the feature lifecycle. Any PR on any entity repo triggers it — whether the PR came from the feature lifecycle, a manual push, or an external contributor.

```
PR opened → Review → Changes needed? → Fix → Re-review → Merge
                         │                        ↑
                         └── Loop until clean ─────┘
```

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
- Loads `review-guideline` for our review standards (priority order, comment format, quality bars)
- Runs `/review` (Claude Code's built-in PR review) for comprehensive analysis
- Posts the review on the PR via `gh`
- Verdict: **Approved** or **Changes Requested** — never ambiguous

**Escalation:** If the reviewer has questions about intent or requirements that can't be answered from the spec, escalate to #alerts and wait for a response before completing the review.

### 2. Fix (if changes requested)

If the review requests changes, spawn a builder agent (Bob) on the PR branch.

Bob:
- Reads the review comments
- Addresses each blocking issue
- Runs `/simplify` to clean up the code
- Commits and pushes

**Escalation:** If a review comment requires a design decision or scope change, Bob escalates to #alerts rather than guessing. Wait for input, then continue.

### 3. Re-review

After fixes are pushed, loop back to step 1. A fresh reviewer session — no memory of the previous review. Fresh eyes every time.

The loop continues until the review passes with no blocking issues.

### 4. Merge

When the review is approved:

1. **Check for conflicts** — `gh pr view {number} --json mergeable`
2. **If clean** — squash merge: `gh pr merge {number} --squash --delete-branch`
3. **If conflicts:**
   - Attempt a clean rebase: `git rebase main` on the PR branch
   - If the rebase is straightforward (no manual resolution needed), push and merge
   - If the rebase requires decisions (conflicting changes in the same area), escalate to #alerts with the conflict details and wait for guidance
4. **Post-merge** — notify #general

### 5. Notify Feature Lifecycle (if applicable)

If this PR belongs to a feature managed by the feature lifecycle (tracked in `features.json`), the daemon advances the feature from "review" to "ship" upon merge.

For PRs not associated with a feature, the SOP completes after merge.

## Agent Behavior During Build

This applies to both the build phase of the feature lifecycle and the fix step above:

**Agents should surface discoveries.** Plans drift during implementation. New information emerges. When an agent discovers something that could affect a decision or the outcome — a gotcha, a better approach, a dependency that changes the scope — it should ask, not assume.

This isn't about asking permission for every line of code. It's about being a collaborator. If the agent has a genuine question, it surfaces it via #alerts. If it doesn't, it keeps building.

**Before pushing, run `/simplify`** to catch cleanup opportunities. Less noise for the reviewer.

## What the Daemon Does vs What Agents Do

**Daemon (deterministic):**
- Poll repos for open PRs
- Trigger review-merge SOP for new/updated PRs
- Spawn reviewer and builder agents
- Track which PRs are being processed
- Detect merge and notify feature lifecycle
- Handle merge mechanics (squash, rebase)

**Agents (intelligent):**
- Review code against standards
- Fix review feedback
- Decide what to escalate vs handle autonomously
- Run `/review`, `/simplify`

## What NOT to Do

- Don't merge without a passing review — even for "trivial" changes
- Don't skip the re-review after fixes — the reviewer needs to confirm
- Don't force-merge past conflicts without understanding them
- Don't auto-resolve merge conflicts that touch the same logic — escalate
- Don't hold a PR open waiting for a response longer than 24h without re-pinging
