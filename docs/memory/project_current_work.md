---
name: Current work and next steps
description: Active work items and immediate next steps as of 2026-03-22
type: project
---

## Completed (2026-03-22)

**Pat on Discord via Claude Code Channels — DONE**
Replaced the one-shot `claude -p` Commander sessions with a persistent Claude Code session connected to Discord #command-center via the native channel plugin. Tested and working.

Architecture:
- Pat's bot: separate Discord application, connected via `claude --channels plugin:discord@claude-plugins-official`
- Daemon bot: unchanged, handles entity channel routing, `!lf` commands, webhooks
- Daemon role for Pat: lifecycle only (spawn, health check, restart on crash)
- Pat queries daemon API (`http://localhost:7749`) for system state on demand
- Access control: `~/.lobsterfarm/channels/pat/access.json` (allowlist + channel opt-in)
- Bot token: `~/.lobsterfarm/channels/pat/.env`
- Pseudo-TTY required: daemon wraps spawn in `script -q /dev/null` since `--channels` needs interactive mode

Key files:
- `commander-process.ts` — persistent process manager (replaced old `commander.ts`)
- `discord.ts` — Commander routing removed, daemon bot ignores #command-center
- `commander.md` — agent definition updated for channel plugin (reply tool, not stdout)
- Setup wizard prompts for two bot tokens (daemon + commander)

## What's Built and Working
- CLI: lf init, entity create/list, start/stop/status, update
- Daemon: HTTP API, session manager, task queue, feature lifecycle, Discord bot, router, persistence
- Commander (Pat): persistent Discord session via Claude Code channels, full tool access, real conversation
- Discord: two-bot architecture (daemon bot + Pat bot), entity channels, webhooks, channel scaffolding
- 62 tests passing
- Discord plugin installed: `discord@claude-plugins-official`
- Bun installed (required by Discord MCP server)

## Immediate Next Steps
1. Scaffold first real entity via Pat in #command-center
2. Run a feature through the full lifecycle
3. Test daemon-managed Pat restart (start daemon with new code, verify Pat auto-starts)

## Future (not started)
- Blueprint system (entity config inheritance)
- YAML-based SOP engine (currently hardcoded TypeScript)
- Embedding-powered semantic search for memory
- Pre-compaction memory flush
- Web dashboard
- Interactive sessions for other agents (not just Commander)

**How to apply:** Next session should focus on scaffolding the first entity through Pat and running a feature end-to-end.
