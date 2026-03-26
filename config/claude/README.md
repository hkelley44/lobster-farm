# Claude Code Configuration Templates

Templates for the Claude Code agent configuration files that `lf init` copies to `~/.claude/`. These are not used at runtime directly -- they contain `{{PLACEHOLDER}}` variables that the init wizard resolves with user-specific values (agent names, user name, etc.) before writing the final files.

## Files

- `CLAUDE.md` -- Template for the global `~/.claude/CLAUDE.md`. Defines the shared foundation loaded by every agent session: core truths, session startup protocol, memory system (reading and writing), team roster, handoff boundaries, universal rules (git, secrets, escalation, communication, documentation), and repo locations.

## Directories

- `agents/` -- Archetype soul/personality files. One per agent role. Defines identity, behavior, and allowed tools.
- `skills/` -- DNA, guidelines, and SOPs. Domain knowledge that auto-loads based on task context.
