# LobsterFarm File Boundary Map v2

## Purpose

Every piece of context an agent consumes lives in exactly ONE file type. This document defines the boundary for each file, what belongs in it, what does NOT, and a litmus test for resolving ambiguity.

---

## File 1: Global CLAUDE.md
**Path:** `~/.claude/CLAUDE.md`
**Scope:** Global — loaded for every Claude Code session, every entity
**Update frequency:** Moderate

### Contains:
- **Shared soul foundation:** Core truths all agents inherit (partner not tool, have opinions, be resourceful, take your time, earn trust). Written ONCE here, never repeated in archetype souls.
- **Session startup procedure:** Read MEMORY.md, check daily logs, read feature spec
- **Memory routing:** Where to read, where to write, rules
- **Role map:** Which archetype does what, handoff boundaries (not personalities — just labor division)
- **Universal rules:** Git workflow, secrets management, escalation triggers, communication patterns, documentation expectations
- **Pointers:** References to user.md, tools.md, and entity memory paths

### Does NOT contain:
- ❌ Archetype-specific personality (that's the Soul)
- ❌ Domain standards or preferences (that's DNA)
- ❌ Project-specific facts (that's Entity CLAUDE.md)
- ❌ Entity isolation instructions (architecture handles this — sessions run in entity worktrees)
- ❌ SOP workflow details (daemon executes those — CLAUDE.md just says "declare work complete")

### Litmus test:
> "Is this a rule or orientation that applies to EVERY session, regardless of which archetype, entity, or task?"
> If YES → Global CLAUDE.md.

---

## File 2: Agent Definition (Archetype)
**Path:** `~/.claude/agents/{name}.md`
**Scope:** Global — available to all entities
**Update frequency:** Rarely

### Contains:
- **Frontmatter (Identity):** name, description trigger phrases, model default, tool permissions
- **Body (Soul):** Personality. Values. How this agent UNIQUELY thinks and approaches problems. Vibe. Domain perspective. What makes Pearl different from Bob.

### Does NOT contain:
- ❌ Shared core truths (those are in global CLAUDE.md — don't repeat)
- ❌ Technical standards (that's DNA)
- ❌ Workflow steps (that's SOPs / global CLAUDE.md)
- ❌ Project facts (that's Entity CLAUDE.md)
- ❌ Information about Jax (that's USER.md)
- ❌ Team roster details (global CLAUDE.md has the role map)

### Litmus test:
> "Would this be true if the agent switched from a TypeScript project to a Python project?"
> If YES → Soul.
> If NO → DNA or Entity CLAUDE.md.

> "Is this shared with all agents?"
> If YES → Global CLAUDE.md, not here.

---

## File 3: DNA Profile
**Path:** `~/.claude/skills/{dna-name}/SKILL.md`
**Scope:** Global — composable, auto-loaded by task matching
**Update frequency:** Evolves over time (assisted-evolution pipeline)

### Contains:
- **Standards:** Concrete quality bars for a specific domain. What "good" looks like. With examples.
- **Preferences:** Opinionated tool/pattern/approach defaults.
- **Anti-patterns:** What to avoid and why.
- **Inspiration** (optional): Reference projects, studios, exemplars.
- **Process** (domain-specific): How to approach brand kit creation, how to structure a review, etc.

### Does NOT contain:
- ❌ Personality or communication style (that's Soul)
- ❌ Workflow orchestration steps (that's SOPs)
- ❌ Project-specific facts (that's Entity CLAUDE.md)
- ❌ Universal rules like git workflow (that's Global CLAUDE.md)

### Litmus test:
> "Is this a preference, standard, or pattern that defines HOW to do work in a specific domain?"
> If YES → DNA.
> "Is this about WHO the agent is?"
> If YES → Soul.

---

## File 4: USER.md
**Path:** `~/.lobsterfarm/user.md`
**Scope:** Global — referenced from global CLAUDE.md, read every session
**Update frequency:** Rarely

### Contains:
- Who Jax is (name, background, working style)
- Communication preferences (directness, show-don't-tell, no filler)
- Decision-making preferences (when to ask vs act autonomously)
- What frustrates him (repeated context, generic output, cutting corners)
- Contact information

### Does NOT contain:
- ❌ Project facts, entity details, technical standards
- ❌ Agent personality or rules

### Litmus test:
> "Is this about the HUMAN, not the agent or the project?"
> If YES → USER.md.

---

## File 5: Tools Config
**Path:** `~/.lobsterfarm/tools.md`
**Scope:** Global — machine-specific infrastructure
**Update frequency:** When infrastructure changes

### Contains:
- Account credentials (by reference, not values)
- Service locations (URLs, ports, IPs)
- CLI tool access patterns (1Password usage, Supabase CLI, etc.)
- Network configuration (Tailscale, SSH)
- Machine details (hardware, permissions status)

### Does NOT contain:
- ❌ How to USE tools (that's skills/documentation)
- ❌ Entity-specific infrastructure (that's entity config or entity CLAUDE.md)

### Litmus test:
> "Is this a fact about OUR machine setup that any agent might need?"
> If YES → tools.md.

---

## File 6: Entity CLAUDE.md
**Path:** `/repos/{entity}/CLAUDE.md` (repo root)
**Scope:** One entity
**Update frequency:** As project evolves

### Contains:
- Project description (one paragraph)
- Tech stack (specific technologies, versions)
- Architecture overview (directory structure, key patterns)
- Build/test/run commands (exact commands)
- Environment setup (required env vars, referencing .env.example)
- Pointer to MEMORY.md path
- Entity-specific conventions that DIFFER from global DNA

### Does NOT contain:
- ❌ Universal coding standards (that's DNA — only note DEVIATIONS here)
- ❌ Agent personality, user preferences, universal rules
- ❌ Memory/knowledge (that's MEMORY.md)

### Litmus test:
> "Is this a FACT about this specific project that a new developer joining needs to know?"
> If YES → Entity CLAUDE.md.

---

## File 7: SOPs
**Path:** `~/.lobsterfarm/sops/{name}.yaml`
**Scope:** Global — executed by daemon for all entities (unless entity opts out)
**Update frequency:** As processes improve

### Contains:
- Deterministic state machines: phases, transitions, conditions, actions
- Guardrails: hard rules enforced by hooks and daemon
- Automation triggers: what happens on PR creation, Sentry alert, merge, etc.

### Does NOT contain:
- ❌ Agent personality, domain standards, project facts

### Key property:
SOPs are executed by the daemon, NOT read by Claude Code. Agents see the RESULT ("you're in build phase, here's the spec") not the workflow definition.

### Litmus test:
> "Is this a PROCESS that should happen the same way every time, regardless of who executes it?"
> If YES → SOP.
> "Is this JUDGMENT about how to do something well?"
> If YES → DNA.

---

## File 8: Entity Config
**Path:** `~/.lobsterfarm/entities/{id}/config.yaml`
**Scope:** One entity — daemon configuration
**Update frequency:** At entity creation, occasionally after

### Contains:
- Entity metadata (name, description, status)
- Repo path and structure
- Discord channel mappings
- Agent mode preference
- Model tier defaults
- Budget settings
- Active SOP list

### Does NOT contain:
- ❌ Project architecture (that's Entity CLAUDE.md)
- ❌ Accumulated knowledge (that's MEMORY.md)

---

## File 9: MEMORY.md (Entity)
**Path:** `~/.lobsterfarm/entities/{id}/MEMORY.md`
**Scope:** One entity
**Update frequency:** Continuously

### Contains:
- Architectural decisions and rationale
- Known gotchas and workarounds
- Patterns that worked (or failed)
- Integration details, external service quirks
- Important context future sessions need

### Does NOT contain:
- ❌ Project description or tech stack (that's Entity CLAUDE.md)
- ❌ Coding standards (that's DNA)
- ❌ Daily session details (that's daily logs — only PROMOTED items here)

### Format:
Single markdown file. Aim for <200 lines. Read in full every session. If it outgrows 200 lines, split into MEMORY.md (index) + topic files in `context/`.

### Litmus test:
> "If an agent started a new session tomorrow with no prior context, would they need this to avoid mistakes or repeated decisions?"
> If YES → MEMORY.md.
> If it's just what happened today → daily log.

---

## File 10: Daily Logs
**Path:** `~/.lobsterfarm/entities/{id}/daily/YYYY-MM-DD.md`
**Scope:** One entity, one day
**Update frequency:** Every session (stop hook appends)

### Contains:
- Session summaries: what was worked on, accomplished
- Decisions made during session
- Questions that arose and how resolved
- Items that MIGHT be worth promoting to MEMORY.md

### Does NOT contain:
- ❌ Full conversation transcripts
- ❌ Permanent knowledge (promote to MEMORY.md)

### Lifecycle:
Staging area. Weekly: review → promote to MEMORY.md → archive. Old logs (30+ days) archived or deleted.

---

## File 11: Entity Files
**Path:** `~/.lobsterfarm/entities/{id}/files/`
**Scope:** One entity
**Update frequency:** As needed

### Contains:
- Arbitrary files the entity needs: presentations, brand kits, data files, documents
- Claude Code can read, create, and modify these (PPTX, PDF, XLSX, images, etc.)

### Litmus test:
> "Is this a file that belongs to this entity/project but isn't code?"
> If YES → entity files directory.

---

## The Boundary Matrix

| Question | File |
|---|---|
| Shared truths for ALL agents? Universal rules? | **Global CLAUDE.md** |
| WHO is this agent? Unique personality? | **Soul** (agents/{name}.md body) |
| Agent name, model, tools, trigger phrases? | **Identity** (agents/{name}.md frontmatter) |
| HOW should work be done in this domain? | **DNA** (skills/{dna}/SKILL.md) |
| WHO is the human? | **USER.md** |
| What's our machine setup? Accounts? Services? | **Tools config** |
| Facts about THIS specific project? | **Entity CLAUDE.md** |
| How should a PROCESS work, deterministically? | **SOP** |
| Entity registration, channels, budgets? | **Entity config** |
| What has this entity LEARNED over time? | **MEMORY.md** |
| What happened TODAY? | **Daily log** |
| Non-code files for this entity? | **Entity files** |

## The "No Homeless Content" Rule

Every piece of information belongs in exactly ONE file type. If it fits two places, either split it into specific parts or you've found a boundary that needs a decision.

Run the litmus tests in order:
1. Is it a shared truth or universal rule? → Global CLAUDE.md
2. Is it unique agent personality? → Soul
3. Is it domain expertise? → DNA
4. Is it about the human? → USER.md
5. Is it machine infrastructure? → Tools
6. Is it a project fact? → Entity CLAUDE.md
7. Is it a deterministic process? → SOP
8. Is it entity config for the daemon? → Entity config
9. Is it accumulated project knowledge? → MEMORY.md
10. Is it recent session activity? → Daily log

---

*File Boundary Map v2 — Definitive Guide*
*Aligned with Architecture v0.3 and Final File Specs*
