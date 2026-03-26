---
name: Current work and next steps
description: Active work items and immediate next steps as of 2026-03-25
type: project
---

## Completed

**Pat on Discord via Claude Code Channels — DONE (2026-03-22)**
Persistent Claude Code session connected to Discord #command-center via native channel plugin. Daemon manages lifecycle (spawn in tmux, health check, restart on crash).

**Architecture docs — DONE (2026-03-24)**
Comprehensive architecture documentation at `docs/architecture/`.

**Repo location cutover — DONE (2026-03-25)**
Repo moved to `~/.lobsterfarm/entities/lobster-farm/repos/lobster-farm/`. Old `src` symlink removed. Memory symlink updated. Entities live inside the instance directory.

**Entity scaffolding — DONE (2026-03-25)**
- Entity scaffold SOP tested end-to-end with Pat (twice — lobster-farm + bayview)
- `POST /scaffold/entity` and `POST /reload` daemon endpoints built
- Schema cleaned up: `repos` array (multi-repo support), `channels` with `category_id`, dropped `active_sops`/`budget`/`agent_mode`/`models`
- Software blueprint at `~/.lobsterfarm/blueprints/software/blueprint.yaml`

**Guidelines — DONE (2026-03-25)**
- `secrets-guideline` — op run patterns, vault structure, never handle raw secrets
- `readme-guideline` — per-directory README standards
- `discord-guideline` — Discord server management (renamed from discord-guide)
- Taxonomy established: DNA (expertise), Guidelines (operational requirements), SOPs (procedures)

**Two entities live:**
- `lobster-farm` — entity zero, the platform itself
- `bayview` — first real entity, small business lending brokerage (lead gen engine)

## Next Steps

1. **Feature lifecycle end-to-end** — run a feature through plan → build → review on a real entity. This is the core value prop. Tests the session manager, feature state machine, and agent handoffs.
2. **1Password integration** — move Discord tokens from .env files into 1Password vaults. Currently tokens are in plain text on disk.
3. **Feature lifecycle SOP** — exists as hardcoded TypeScript in features.ts. Should become a skill so agents understand the workflow.

## What's Built and Working
- CLI: lf init, entity create/list, start/stop/status, update
- Daemon: HTTP API (status, entities, features, tasks, scaffold, reload), session manager, task queue, feature lifecycle, Discord bot, router, persistence
- Commander (Pat): persistent Discord session, full tool access
- Discord: two-bot architecture, entity channels, webhooks, channel scaffolding
- Skills: 5 DNA + 3 guidelines + 1 SOP (entity-scaffold)
- Blueprint: software blueprint
- 115 tests passing

## Future (not started)
- YAML-based SOP engine (currently hardcoded TypeScript)
- Entity-level orchestrator (open question)
- Web dashboard
- Interactive sessions for entity agents (drop into a running build)
- DNA evolution pipeline
- Hook-based secret leak prevention (PreToolUse scanning)
