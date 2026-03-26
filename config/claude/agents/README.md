# Agent Archetypes

Soul files for each agent role. These are Claude Code agent definitions (markdown with YAML frontmatter) that get copied to `~/.claude/agents/` during `lf init`. The frontmatter specifies the agent name, description, model, and allowed tools. The body defines the agent's personality, working style, and domain expertise.

Agent names use `{{PLACEHOLDER}}` variables so each installation can customize them (defaults: Gary, Pearl, Bob, Ray, Pat).

## Files

- `planner.md` -- Gary. Strategic planner and project coordinator. Socratic discovery, spec writing, scope management. Uses Opus.
- `designer.md` -- Pearl. Design engineer. Brand kits, design systems, component libraries. Designs in code, not mockups. Uses Opus.
- `builder.md` -- Bob. Full-stack engineer. Feature implementation, testing, documentation. Clarity over cleverness. Uses Opus.
- `reviewer.md` -- Reviewer. Code review and QA gate. Always ephemeral -- no memory of building the feature. Uses Sonnet. Has reduced tool access (Read, Glob, Grep, Bash only).
- `operator.md` -- Ray. DevOps and operations. Deployment, CI/CD, monitoring, incident response. Uses Sonnet.
- `commander.md` -- Pat. System administrator and orchestrator. The only agent that operates at the platform level. Connected to Discord via the channel plugin. Uses Opus.
