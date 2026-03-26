---
name: Current work and next steps
description: Active work items and immediate next steps as of 2026-03-26
type: project
---

## Completed (2026-03-26)

**Feature lifecycle tested end-to-end**
- Gary (planner) in Discord work room, riffed with user, created GitHub issues #2 and #3
- Gary spawned Bob as subagent (not pool cycling — subagents are the pattern)
- Bob implemented PreToolUse Bash secret scanning hook (64 tool uses, 10 min)
- PR #4 created: 362 additions, 35 tests, hook installed and live
- Daily log updated by Gary automatically

**Bot pool manager built**
- 5 pool bots (lf-0 through lf-4), daemon assigns dynamically
- Channel-level scoping via access.json `groups` field (accepts channel IDs)
- Pre-assigns Gary to all entity #general channels on daemon startup
- Auto-assigns on first message in unassigned channels (bridge via tmux send-keys)
- LRU eviction for when pool is full, park/resume for session preservation
- Nickname setting via Discord API (@me endpoint)
- `!lf swap <agent>` command for manual agent switching

**Key architectural discovery: subagents > pool cycling**
- Gary spawns Bob/Pearl/Ray as subagents within his session
- No pool cycling needed for plan → build transitions
- No cold starts, no token waste on hops, context shared naturally
- Pool is for channel assignment (which Gary is where), not archetype cycling
- Only exception: explicit agent swap (design riffing with Pearl directly)

## Open Items (for next session)

1. **READMEs** — add per-directory READMEs following readme-guideline. None exist yet.
2. **Status pins** — pin status messages in all work rooms (needs Manage Messages permission for bots)
3. **Git author per agent** — set GIT_AUTHOR_NAME/EMAIL per agent session so commits show agent identity, not the machine user
4. **Settings.json approval routing** — agents can't auto-approve settings.json edits (Claude Code safety). Pre-install hooks before builds, or find a way to route approvals to Discord.
5. **Update feature-lifecycle SOP** — reflect subagent model (Gary orchestrates, spawns Bob/Pearl/Ray) instead of daemon-managed phase cycling
6. **PR review-merge cron** — daemon polls entity repos for open PRs, triggers review. PR #4 needs review.
7. **Commit session work** — pool manager, daemon updates, design decisions all need committing

## What's Built and Working
- CLI: lf init, entity create/list, start/stop/status, update
- Daemon: HTTP API, pool manager (5 bots), session manager, task queue, feature lifecycle, Discord bot, router, persistence, scaffold/reload endpoints, pool assign/release/status endpoints
- Commander (Pat): persistent Discord session in #command-center
- Agent pool: 5 bots (lf-0 through lf-4), pre-assigned to entity #general channels, auto-assign on first message with tmux bridge
- Feature lifecycle: Gary → subagent Bob, tested e2e, PR created
- PreToolUse Bash secret scanning hook: LIVE and active
- Skills: 4 DNA + 4 guidelines + 3 SOPs
- Rules: 4 global rules (secrets, git, collaboration, escalation)
- Blueprint: software blueprint
- Entities: lobster-farm (entity zero), bayview
