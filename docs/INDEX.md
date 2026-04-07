# LobsterFarm — Specification Index

## Architecture & Reference
- `lobsterfarm-architecture-v0.3.md` — Full system architecture (components, data model, SOPs, governance, roadmap)
- `lobsterfarm-file-boundary-map-v2.md` — What content goes in which file (definitive guide)

## Default Configuration Templates (../config/)

### ~/.claude/ (Global Claude Code Configuration)
- `config/claude/CLAUDE.md` — Shared soul foundation, session startup, role map, universal rules
- `config/claude/agents/planner.md` — Planner archetype (soul + identity)
- `config/claude/agents/designer.md` — Designer archetype (soul + identity)
- `config/claude/agents/builder.md` — Builder archetype (soul + identity)
- `config/claude/agents/reviewer.md` — Reviewer archetype (ephemeral, unnamed)
- `config/claude/agents/operator.md` — Operator archetype (soul + identity)
- `config/claude/skills/coding-dna/SKILL.md` — Engineering standards
- `config/claude/skills/design-dna/SKILL.md` — Design standards
- `config/claude/skills/planning-dna/SKILL.md` — Spec writing and discovery standards
- `config/claude/skills/review-dna/SKILL.md` — Code review standards
- `config/claude/skills/database-dna/SKILL.md` — Schema and query standards

### ~/.lobsterfarm/ (LobsterFarm User Configuration)
- `config/lobsterfarm/user.md` — User profile template (preferences, style, contact)
- `config/lobsterfarm/tools.md` — Machine infrastructure template (accounts, services, paths)

All config templates use `{{PLACEHOLDER}}` syntax. The setup wizard (`lobsterfarm init`) populates these during onboarding.
