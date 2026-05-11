# Skills

DNA, guidelines, and SOPs that agents load as context. Each skill is a directory containing a `SKILL.md` file with YAML frontmatter (name, description) and markdown body. Claude Code auto-loads skills based on task keyword matching against the description.

Skills fall into three categories:

- **DNA** -- Deep domain knowledge. How we write code, design interfaces, plan features, manage databases. Loaded by the primary archetype for that domain.
- **Guidelines** -- Operational requirements. Secret handling, code review standards, README maintenance, Discord management. Loaded across archetypes as needed.
- **SOPs** -- Step-by-step procedures. PR review-merge workflow, entity scaffolding process. Loaded when executing a specific process.

## Canonical source rule

**This directory (`config/claude/skills/`) is the single source of truth for every skill.** The Claude Code harness only auto-discovers skills under `~/.claude/skills/`, so each shared skill is published to that load path as a **symlink** pointing at the repo file here. Never edit a user-global `~/.claude/skills/<name>/SKILL.md` directly — edit the repo file in this directory, commit it through a PR, and the symlinked user-global copy reflects the change immediately (the harness picks it up on the next session start).

When adding a new shared skill:

1. Create `config/claude/skills/<name>/SKILL.md` here and commit it through a PR.
2. After merge, publish to the user-global load path on each machine:
   ```bash
   mkdir -p ~/.claude/skills/<name>
   ln -s ~/.lobsterfarm/src/config/claude/skills/<name>/SKILL.md \
         ~/.claude/skills/<name>/SKILL.md
   ```
3. Verify with `realpath ~/.claude/skills/<name>/SKILL.md` — it must resolve back into `~/.lobsterfarm/src/config/claude/skills/...`.

Repo-only skills (no user-global presence needed) are loaded by agents that explicitly `Skill`-invoke them — they don't need to be published to `~/.claude/skills/`.

If a SKILL.md is ever found as a regular file (not a symlink) under `~/.claude/skills/`, it is drift — replace it with a symlink to the repo file rather than editing in place.

## Directories

- `coding-dna/` -- Engineering standards and architectural preferences. The foundational DNA for all code work.
- `database-dna/` -- Database design, schema architecture, query optimization. PostgreSQL/Prisma/SQLAlchemy patterns.
- `design-dna/` -- Visual systems, UI implementation, animation, and design-in-code principles.
- `planning-dna/` -- Spec writing, scope management, socratic discovery methodology.
- `review-dna/` -- Code review standards, priority order, frontend criteria, CI awareness.
- `secrets-guideline/` -- 1Password-based secret management. The "never handle raw secrets" rule.
- `readme-guideline/` -- Directory documentation standards. When and how to write READMEs.
- `discord-guideline/` -- Discord server management. Channel scaffolding, bot architecture, webhook patterns.
- `tech-standards/` -- Architectural best practices and team technology standards. Shared decision guide for planners, builders, and reviewers.
- `pr-review-merge/` -- SOP for the PR review, feedback, and merge workflow.
- `feature-lifecycle/` -- SOP for how features move from idea to shipped, including the autonomous build-review-merge loop.
- `entity-scaffold/` -- SOP for standing up a new entity from a blueprint.
