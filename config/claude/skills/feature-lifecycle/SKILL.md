---
name: feature-lifecycle
description: >
  The autonomous feature lifecycle — how features move from idea to shipped.
  Auto-loads when creating features, advancing phases, managing the build loop,
  or understanding how work flows through the system.
---

# Feature Lifecycle SOP

_How a feature moves from idea to shipped code in LobsterFarm._

---

## Overview

Features flow through a deterministic phase sequence. The daemon orchestrates — spawning agents, managing state, enforcing gates. You make decisions at approval gates. Everything else is autonomous.

```
plan → [design] → build → PR created → review-merge SOP → ship → done
```

Design is optional — skipped unless the feature has UI/frontend/brand/design labels. Review is handled by the separate `pr-review-merge` SOP — the feature lifecycle creates the PR and waits for it to merge.

## Creating a Feature

A feature requires:
- **Entity ID** — which project this is for
- **Title** — what the feature is
- **GitHub issue number** — the spec lives on the issue

Via Discord:
```
!lf plan {entity} "Feature title"
```

Via HTTP API:
```bash
curl -s -X POST http://localhost:7749/features \
  -H 'Content-Type: application/json' \
  -d '{"entity_id": "{entity}", "title": "Feature title", "github_issue": 42}'
```

Optional fields: `priority` (critical/high/medium/low), `labels` (array of strings — include "ui" or "frontend" to trigger the design phase).

## Phases

### Plan

**Who:** Gary (planner)
**DNA:** planning-dna
**Model:** opus, high effort
**Approval gate:** Yes — you must approve the spec before build begins

Gary reads the GitHub issue and writes a detailed spec as an issue comment: acceptance criteria, technical approach, scope boundaries. When he's done, you get pinged in #alerts.

**To approve:**
```
!lf approve {feature-id}
```
or `POST /features/{id}/approve`

**To advance after approval:**
```
!lf advance {feature-id}
```
or `POST /features/{id}/advance`

### Design (optional)

**Who:** Pearl (designer)
**DNA:** design-dna, coding-dna
**Model:** opus, standard effort
**Approval gate:** Yes
**Skipped unless:** feature has labels: ui, frontend, brand, or design

Pearl creates coded prototypes using the entity's design system. Pinged in #alerts when done.

### Build

**Who:** Bob (builder)
**DNA:** coding-dna
**Model:** opus, high effort
**Approval gate:** No — auto-creates PR when Bob finishes

The daemon creates a git worktree on a feature branch (`feature/{issue#}-{slug}`). Bob implements the feature following the spec, writes tests, runs `/simplify` to clean up, commits and pushes.

**Agent behavior during build:** Plans drift. New information emerges. When an agent discovers something that could affect a decision or the outcome, it should surface it via #alerts — not assume. This isn't about asking permission for every line of code. It's about being a collaborator. Genuine questions get asked. Everything else, keep building.

When the session completes, the daemon auto-creates a PR. The PR triggers the `pr-review-merge` SOP, which handles review, fixes, and merge independently.

### Review (handed off to pr-review-merge SOP)

The feature lifecycle does not manage review directly. Once the PR is created, the `pr-review-merge` SOP takes over:
- Reviewer reviews the PR
- If changes needed, Bob fixes and re-pushes
- Loop until review passes
- Merge

See the `pr-review-merge` skill for full details.

The feature lifecycle watches for the PR to merge. When it does, the feature advances to ship.

### Ship

**Who:** No agent — deterministic actions only
**What happens:**
1. Clean up the git worktree
2. Release the Discord work room
3. Post confirmation to #general

Auto-advances to done.

### Done

Terminal state. Feature is complete.

## State Management

Features are persisted to `~/.lobsterfarm/state/features.json` on every state change. The daemon reloads them on startup.

**Feature state includes:**
- Current phase, approval status, blocked status
- Active session ID (which Claude Code process is working on it)
- Worktree path, PR number, branch name
- Priority, labels, timestamps

## Blocking and Unblocking

If a session fails (Claude Code crashes, timeout, etc.), the feature is automatically blocked. You'll be notified in #alerts.

To unblock and retry:
```
!lf unblock {feature-id}
!lf advance {feature-id}
```

## Notifications

- **#work-log** — phase transitions, agent activity
- **#alerts** — approval requests, blocks, errors, agent questions
- **#general** — feature shipped confirmation

## What the Daemon Does vs What Agents Do

**Daemon (deterministic):**
- Create/advance features through phases
- Spawn agents with the right archetype, DNA, and model
- Create worktrees and PRs
- Enforce approval gates
- Track state, persist to disk
- Route notifications to Discord
- Detect PR merge and advance feature to ship

**Agents (intelligent):**
- Write specs, designs, code
- Make technical decisions within their scope
- Ask questions via #alerts when they have genuine questions
- Surface discoveries that could affect decisions
- Run `/simplify` before pushing code
- Commit and push code

## What NOT to Do

- Don't skip approval gates — they exist for a reason
- Don't manually advance a blocked feature without understanding why it blocked
- Don't create features without a GitHub issue — the issue is the spec's home
- Don't merge PRs outside the review-merge SOP — the daemon tracks PR state
