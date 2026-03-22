---
name: Current work and next steps
description: Active work items and immediate next steps as of 2026-03-22
type: project
---

## Active Work (2026-03-22)

**Claude Code Channels for Commander (Pat):**
The Commander currently runs as one-shot `claude -p` sessions per Discord message, with conversation history injected via temp files. This works but is hacky.

Next step: Replace with Claude Code Channels — a persistent Claude Code session connected directly to Discord #command-center via:
```bash
claude --agent pat --model claude-opus-4-6 --permission-mode bypassPermissions --channels "plugin:discord@claude-plugins-official"
```

This gives Pat:
- Persistent conversation (no history hacking)
- Full tool access interactively
- Real back-and-forth with the user

**Blocker:** The settings.json on the Mac mini has the old hooks format. Need to re-run `lf init` to regenerate with the correct format (matcher + hooks array). The hooks format was fixed in commit cc40e95.

## What's Built and Working
- CLI: lf init, entity create/list, start/stop/status, update
- Daemon: HTTP API, session manager, task queue, feature lifecycle, Discord bot, router, persistence
- Commander (Pat): responds in #command-center, conversation history, full Claude Code sessions
- Discord: bot connects, commands work, agent identity via webhooks, channel scaffolding
- 115 tests passing

## Immediate Next Steps
1. Fix settings.json via `lf init` on Mac mini
2. Test Claude Code Channels for Pat
3. Scaffold first real entity via Pat
4. Run a feature through the full lifecycle

## Future (not started)
- Blueprint system (entity config inheritance)
- YAML-based SOP engine (currently hardcoded TypeScript)
- Embedding-powered semantic search for memory
- Pre-compaction memory flush
- Web dashboard
- Interactive sessions for other agents (not just Commander)

**How to apply:** The new session on the Mac mini should focus on testing Channels and getting the first entity scaffolded through Pat.
