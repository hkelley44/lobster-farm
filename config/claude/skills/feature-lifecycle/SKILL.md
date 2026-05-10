---
name: feature-lifecycle
description: >
  The feature lifecycle — how features move from idea to shipped.
  Auto-loads when creating features, planning work, managing the build loop,
  or understanding how work flows through the system.
---

# Feature Lifecycle SOP

_How a feature moves from idea to shipped code in LobsterFarm._

---

## Overview

The planner (Tidus) is the orchestrator for each entity. Features start as conversations — you riff with Tidus in #general or a work room. When a feature is ready to build, Tidus creates the GitHub issue, hands off to Ben (builder) as a subagent, and the team runs the build → review → fix → E2E → merge loop autonomously by default. You stay in Discord for everything — the planning conversation, the staging gate (when applicable), and any escalation.

```
Riff with Tidus → spec ready → GitHub issue created → Ben builds (subagent) →
  PR opened → autonomous build-review-merge loop → shipped
```

The loop is hands-off by default. Hunter is pulled in only at the staging gate (for repos with `origin/staging`) or via the standing escalation rules — not on every feature, not on every cycle.

## How It Works

### 1. Discovery (in Discord)

You describe what you want in #general or a work room. Tidus does socratic discovery — asks questions, proposes approaches, scopes the work. This is a conversation, not a form to fill out.

When the spec is solid, Tidus creates a GitHub issue as the record. The issue is the OUTPUT of planning, not the input.

### 2. Approval (legacy / optional)

The autonomous loop is the default. The pre-PR approval gate described here is **legacy** — kept for situations where you genuinely want a human-in-the-loop preview before code goes up for review.

**Use the legacy gate only when:**
- The work is **visual** (UI, design, brand) and you want to see a screenshot or live preview before the PR opens
- The spec explicitly opts in via a `verification: user` declaration in the GitHub issue (see `coding-dna` → "PR Workflow")
- You're testing a new pattern and want a checkpoint mid-build

**Otherwise, skip approval entirely.** Tidus hands the issue to Ben, Ben opens the PR, and the autonomous loop takes over from there. The Reviewer's verdict is the quality gate; the staging-test step (when applicable) is the product gate.

If the legacy gate is in use:
- For visual work: Tidus or Ben shows a screenshot/preview in the work room and waits for "looks good" before opening the PR
- For `verification: user`: Ben pushes the branch, posts test instructions, and waits per the `coding-dna` PR Workflow rules

### 3. Build (subagent)

Tidus spawns Ben as a subagent within his session. Ben inherits full context from the planning conversation — no information loss. Ben:
- Creates a feature branch
- Implements the feature following the spec
- Writes tests
- **Self-smoke-tests before every push** (per `coding-dna` → "Self-smoke-test before every push") — don't burn a Reviewer cycle on a known-broken state
- Runs `/simplify` to clean up
- Commits and pushes
- Creates a PR with `Closes #{issue}` in the body

Tidus reports the result back to you in Discord.

### 4. The autonomous loop

This is the default path from PR-open to merged. The full mechanics — cycle counting, E2E gating, branch-aware terminal step — live in `pr-review-merge`. This section is the lifecycle-level summary.

**Trigger:** the daemon's PR poll detects the open PR and spawns the Reviewer (existing behavior, no change).

> **Current state (as of this writing):** the daemon already auto-spawns the Reviewer on PR-open. It does **not** yet auto-spawn Ben for fix cycles after a Changes Requested verdict — that piece is pending daemon implementation. Until it ships, fix cycles still require manual orchestration via Tidus (or a direct `!lf swap ben` in the relevant work room). The DNA below describes the intended steady state; the cycle-2 pickup is the gap to be aware of.

**The loop:**

```
PR opened
  ↓
Reviewer reviews (cycle 1, 2, or 3)
  ├─ Spec gap?      → pause, ping Tidus in #alerts (does NOT count as cycle)
  ├─ Changes needed → Ben fixes + smoke-tests + pushes → cycle++
  └─ Approved       → break to E2E
  ↓
4th cycle would trigger? → escalate to Hunter in #alerts, stop
  ↓
Reviewer runs full E2E (final iteration only)
  ├─ Blocking finding → flip to Changes Requested, counts as cycle (subject to cap)
  └─ Clean           → final approval → terminal step
  ↓
Terminal step (branch-aware):
  ├─ origin/staging exists:
  │    1. Squash-merge to staging
  │    2. Post test plan in #work-log AND as PR comment
  │    3. Ping Hunter in #alerts
  │    4. On Hunter's ✅ → fast-forward staging → main
  │
  └─ Only origin/main:
       Squash-merge straight to main, post completion in #work-log
```

**Loop cap (3 cycles).** The Reviewer counts prior verdicts on the PR. If a 4th iteration would trigger, escalate to Hunter in #alerts instead — PR link, summary of disagreement, both positions, recommended path forward. Don't loop past the cap.

**E2E happens once.** Not on every iteration. The deep pass (playwright + access-tool exercise of the feature) runs at the moment the Reviewer would otherwise post the final Approved verdict. If E2E surfaces a blocker, it flips to Changes Requested and counts as a cycle. If clean, the loop terminates.

**Spec-gap pauses don't burn cycles.** When the Reviewer can't tell whether something is a bug (Ben implemented the wrong thing) or a spec gap (the spec didn't say), they apply the heuristic in `review-dna`. Spec gaps pause the loop and ping Tidus in #alerts, not Hunter. The cycle counter is unchanged. When Tidus amends the issue and replies with the clarification, Ben implements against the updated spec and the loop resumes from where it paused.

**Staging gate (when `origin/staging` exists).** After the Reviewer's final approval, the PR is squash-merged into `staging`. A step-by-step test plan goes to **both** #work-log (Discord prose) and the PR (markdown checklist). Hunter is pinged in #alerts. **No auto-promotion** — Hunter's explicit ✅ is the only signal that fast-forwards `staging` → `main`. The 24h re-ping rule applies (per the standing pr-review-merge SOP).

**Main-only repos.** No staging gate. After the Reviewer's final approval, the PR is squash-merged directly into `main` and a completion notice goes to #work-log. Done.

**Escalation rules (unchanged).** Anything touching production, money, emails, auth, security, or anything irreversible still pings Hunter in #alerts regardless of where the loop is. The autonomous default never overrides those rules.

**Hunter can still intervene.** Mid-loop, at any time, for any reason — drop a message in #alerts and the loop pauses. The autonomy is a default, not a lock.

### 5. Design (when needed)

For visual work, Tidus can spawn Helen (designer) as a subagent, or you can ask to talk to Helen directly via `!lf swap helen`. Helen creates design artifacts — brand kits, component libraries, UI prototypes. Swap back to Tidus when done.

## Agent Model

**Tidus is the front door for each entity.** One Tidus session per entity #general channel, always available. You riff with Tidus, Tidus delegates.

**Subagents, not phase cycling.** Tidus spawns Ben, Helen, or Karim as subagents within his session. No pool bot cycling, no cold starts, no context loss. The subagent inherits Tidus's full conversation context.

**Direct agent access via swap.** If you want to riff directly with Helen on design or Ben on implementation, use `!lf swap helen` or `!lf swap ben` in a work room. The daemon swaps the pool bot's archetype.

**Reviewer is independent.** The Reviewer agent is spawned fresh per review iteration by the daemon's PR poll, not by Tidus. Fresh eyes every time, no memory of the last cycle. Cycle state is read from `gh pr view` (`--json reviews` in multi-dev repos, `--json comments` in single-dev repos — see `pr-review-merge` for the exact queries), not carried in agent memory.

## Agent Behavior

**Agents are collaborators, not task executors.** During any phase, agents should surface discoveries that could affect decisions. Plans drift during implementation — new information should be communicated, not suppressed. Ask genuine questions. Don't assume.

**PR bodies must include `Closes #{issue}`.** This auto-closes the GitHub issue on merge. The spec, the PR, and the issue are linked.

**Run `/simplify` before pushing.** Less noise for the reviewer.

**Self-smoke-test before pushing in the loop.** Burning a Reviewer cycle on a red suite is the cheapest mistake to avoid. See `coding-dna` for the canonical command and fallbacks.

**Update daily logs.** After completing work, write to `daily/YYYY-MM-DD.md` with what was done, decisions made, and any open questions.

## Work Room Management

- **Channel topics:** each work room's topic shows current status, updated by the daemon
  - `🟢 Available`
  - `🔵 Secret Scanning Hook — Plan`
  - `🟡 Secret Scanning Hook — Build`
- **Auto-assignment:** messaging an empty work room auto-assigns a planner
- **Room release:** when a feature ships, the room status resets to available

## What NOT to Do

- Don't skip the planning conversation for non-trivial features
- Don't create PRs without `Closes #{issue}` in the body
- Don't merge PRs outside the review-merge SOP — it tracks PR state, cycle count, and the terminal-step routing
- Don't loop past 3 cycles — escalate to Hunter
- Don't auto-promote staging → main — Hunter's ✅ is the only valid signal, no timeout fallback
- Don't run E2E on every iteration — it's the final-step gate, not a per-cycle tax
- Don't suppress discoveries — if you learned something that matters, say it
