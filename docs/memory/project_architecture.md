---
name: System architecture
description: Three concerns (execution/orchestration/interaction), archetype system, memory architecture, MCP, tool routing
type: project
---

## Three Concerns

**Execution:** Claude Code is the single execution engine. With the `--chrome` flag, it has both CLI and GUI capabilities in the same session:
- **CLI tools** — Bash, file ops, git, testing, MCP servers, web fetch/search
- **Computer use** — full screen control, mouse, keyboard, screenshots (via `computer` tool)
- **Browser automation** — navigate, read pages, fill forms, run JS, inspect console/network, manage tabs

An agent can write code AND verify it visually AND interact with GUI-only tools — all in one session. No routing between engines needed. The `--chrome` flag enables all GUI tools via the Claude in Chrome MCP server.

Not everything is dev work. Computer use matters for: design verification, QA, content workflows, research, interacting with tools that have no CLI/API.

**Orchestration:** Managing WHAT gets done, by WHOM, in WHAT order. Handoffs, SOPs, progress tracking across entities. Background coordinator. Must route to the right execution engine (Claude Code vs computer use vs both).

**Interaction:** How Jax communicates with agents. Terminal, Discord, Telegram. Jax is the front door; orchestrator is background infrastructure.

## Archetype System

Three components define an agent:
- **Soul (WHO):** Personality, values, approach. Lives in archetype definition. Shared across entities.
- **DNA (HOW):** Domain expertise lens. Composable. Lives as skills. Shared across entities. Auto-loaded by task match.
- **Memory (WHAT IT KNOWS):** Entity-specific accumulated knowledge. Lives in entity layer. Unique per agent instance.

DNA is composable: builder loads `coding-dna + design-dna` for frontend, `coding-dna + database-dna` for schema work. Soul stays constant.

## Memory Architecture

**Single MEMORY.md per entity. No vector store at launch.**

- `MEMORY.md`: long-term curated knowledge (<200 lines). Read every session.
- `daily/` logs: session summaries. Staging area for MEMORY.md promotion.
- `context/` docs: architecture, decision logs, deeper reference material.

Lifecycle: daily logs accumulate, periodic review, promote important items to MEMORY.md, archive old logs. If MEMORY.md outgrows 200 lines: split into index + topic files in context/.

No global memory for archetypes. Universal learnings improve DNA via evolution pipeline. Pat is the sole exception (command-layer memory).

## MCP as Shared Protocol

Both Claude Code and OpenClaw use MCP natively. MCP servers configured once work with either platform. Tool integrations are portable regardless of orchestration approach. 1,000+ community MCP servers available.

## Tool Routing (Open Design Problem)

All work types run through Claude Code. The agent picks the right tools within a single session:

| Work Type | Tools Used |
|-----------|-----------|
| Feature implementation, code review | Bash, Read, Write, Edit, Glob, Grep |
| Planning with codebase context | Read, Grep, Glob (plan mode) |
| Visual QA, browser testing | computer, navigate, read_page, gif_creator |
| Design verification against Figma | computer (screenshot + compare) |
| Desktop app automation | computer, shortcuts_execute |
| Research | WebSearch, WebFetch, navigate, read_page |
| Form filling, web interaction | navigate, form_input, javascript_tool |

No routing between engines. The agent decides which tools to use. Bob writes code then verifies it renders correctly — same session. Pearl builds a component then checks it against a design reference — same session.

For daemon-spawned sessions, add `--chrome` to enable GUI capabilities alongside CLI tools.

## File Structure

Command layer: `~/.lobsterfarm/` (config, user.md, tools.md, sops/, blueprints/, entities/)
Claude Code config: `~/.claude/` (CLAUDE.md, agents/, skills/)
Entity codebases: `~/projects/{entity}/{repo}/`

The "no homeless content" rule: every piece of information belongs in exactly ONE location.

**Why:** Separating execution, orchestration, and interaction allows each to evolve independently. The archetype system gives specialization without duplication.

**How to apply:** When building new features, identify which concern they belong to. Execution changes go through Claude Code config. Orchestration changes go through daemon. Interaction changes go through channel/UI layer.
