---
name: Memory system improvements
description: Gaps identified in memory architecture + OpenClaw-inspired enhancements to implement
type: project
---

## Gaps to fix (from spec review)

1. **Session resume for feature continuity** — Use `--resume SESSION_ID` when continuing work on the same feature. Store session ID per feature. Currently every task spawns fresh. With 1M context, we should exploit session history. HIGHEST PRIORITY.

2. **Daily logs: read last N with content, not just today+yesterday** — Gap days lose context. Read the most recent N daily logs that actually have entries.

3. **Stop hook extraction needs careful design** — Haiku prompt, what it sees (full transcript? summary?), append vs replace daily log. This is the primary mechanism for ephemeral→durable knowledge conversion.

4. **context/ directory should have defined structure from day one:**
   - `context/architecture.md` — maintained by planner
   - `context/decisions.md` — append-only decision log
   - `context/gotchas.md` — known issues and workarounds
   Read alongside MEMORY.md at session start.

5. **Cross-entity knowledge path** — `~/.lobsterfarm/global-learnings.md` staging file. Commander reviews and routes to DNA evolution or specific entities.

6. **Entity CLAUDE.md should reference memory paths explicitly** — Daemon writes/maintains entity CLAUDE.md with memory pointers, rather than injecting via --append-system-prompt. Leverages Claude Code's native CLAUDE.md hierarchy.

## OpenClaw-inspired enhancements (Phase 2)

7. **Pre-compaction memory flush** — Before auto-compact truncates context, prompt the agent to write durable memories to daily log. Prevents knowledge loss in long sessions.

8. **Embedding-powered semantic search** — SQLite + sqlite-vec for vector storage, FTS5 for keyword fallback. Hybrid search (70% vector + 30% keyword). Temporal decay (30-day half-life) for daily logs. Tool-based: agent calls `memory_search` when it needs recall. Optional — falls back to keyword-only when no embedding provider configured.

9. **Embedding providers** — OpenAI text-embedding-3-small (default), Gemini, or local GGUF. Auto-select based on available API keys. Setup wizard asks.

10. **Image generation** — Plugin-based. Gemini free tier as default option. Setup wizard asks.

## Setup wizard additions

11. **Check for Claude Code installation** — `which claude`, prompt to install if missing.
12. **Check for embedding provider API key** — optional during setup.
13. **Image generation provider** — optional during setup.

**How to apply:** Items 1-6 should be implemented before Mac Studio deployment or shortly after. Items 7-10 are Phase 2. Items 11-13 are setup wizard enhancements.
