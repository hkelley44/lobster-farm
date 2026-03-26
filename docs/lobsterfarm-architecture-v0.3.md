# LobsterFarm

## System Architecture Specification — v0.3

---

## 1. What LobsterFarm Is

LobsterFarm is an orchestration platform that turns a single developer's Mac into an autonomous software consultancy. It is built entirely on Claude Code as the sole execution runtime, extended with native CLI tools, and governed by a custom orchestration daemon that enforces deterministic workflows (SOPs), agent specialization (Archetypes + DNA), and project isolation (Entities).

The core thesis: Claude is capable of excellent work across planning, design, engineering, operations, and research. What it lacks out of the box is **structure** — the institutional knowledge, workflows, quality standards, and isolation boundaries that make a real consultancy reliable. LobsterFarm provides that structure.

### 1.1 Design Principles

1. **Determinism over intelligence for process.** Workflows, routing, and quality gates are code — not LLM decisions. The LLM does creative and analytical work. The system does plumbing.
2. **Autonomy with circuit breakers.** Agents operate independently by default. Confidence thresholds determine when to ask the human. Starts conservative, loosens as DNA matures.
3. **Same brain, different lenses.** One model. Specialization comes from DNA (composable domain expertise) layered onto Archetypes (soul + identity). All agents share a soul foundation of core truths.
4. **Entity isolation is structural, not instructional.** Each Claude Code session is spawned in a specific entity's worktree by the daemon. Agents cannot see other entities' files because they're not in that directory. No isolation rules in prompts needed.
5. **Modular and extensible.** New archetypes, SOPs, DNA profiles, tool integrations, and entity types can be added without modifying core architecture.
6. **One runtime, one subscription.** Everything runs through Claude Code CLI on a Max subscription. No secondary runtimes, no API billing for core work.
7. **Full machine access.** Claude Code operates with sudo, Full Disk Access, Screen Recording, and Accessibility permissions. Safety comes from SOPs and workflow controls, not OS-level restrictions.

---

## 2. System Components

### 2.1 Component Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INTERACTION LAYER                            │
│                                                                     │
│   Discord / Telegram (via Claude Code Channels)                    │
│   Terminal (direct Claude Code sessions)                           │
│   Voice (native Claude Code) · Web Dashboard (Phase 1)             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     LOBSTERFARM DAEMON                              │
│                     (always-on Node.js service)                    │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐             │
│  │  Router   │ │  Task    │ │   SOP    │ │ Archetype │             │
│  │(determ-  │ │  Queue & │ │  Engine  │ │ & DNA     │             │
│  │ inistic) │ │ Scheduler│ │          │ │ Manager   │             │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘             │
│                                                                     │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐        │
│  │  Entity    │ │  Webhook   │ │   Cron     │ │  Cost    │        │
│  │  Registry  │ │  Receiver  │ │ Scheduler  │ │ Tracker  │        │
│  └────────────┘ └────────────┘ └────────────┘ └──────────┘        │
│                                                                     │
│  ┌────────────┐ ┌────────────┐                                     │
│  │  Audit     │ │  Session   │                                     │
│  │  Logger    │ │  Manager   │                                     │
│  └────────────┘ └────────────┘                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ spawns and manages
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     CLAUDE CODE CLI                                  │
│                     (sole execution runtime)                        │
│                                                                     │
│  Max Subscription · Full sudo · Full Disk Access                   │
│  bypassPermissions: true                                           │
│                                                                     │
│  Native:  File ops · Git · Bash · Web search · Subagents ·        │
│           Skills · Hooks · CLAUDE.md hierarchy · Channels ·        │
│           Voice input · Auto-compact                               │
│                                                                     │
│  CLI Tools:  Peekaboo (macOS UI automation) · gh (GitHub CLI) ·    │
│              op (1Password CLI) · curl · docker · aws · vercel ·   │
│              Any brew/npm/pip installable tool                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

#### 2.2.1 Claude Code CLI (EXISTING — sole execution runtime)

Everything executes through Claude Code. Three operating modes:

**Interactive Mode** — Human collaborating in real-time:
```bash
# Terminal — direct session in a worktree
cd /repos/alpha/worktrees/42-feature && claude --resume $SESSION_ID

# Discord/Telegram — Channels deliver messages to a running session
# Daemon keeps sessions alive in tmux panes with --channels flag
claude --channels plugin:telegram@claude-plugins-official \
       plugin:discord@claude-plugins-official
```

**Autonomous Mode** — Agent working independently:
```bash
# Daemon spawns a task
claude -p "Implement feature #42 per spec in the GitHub issue." \
  --model claude-opus-4-6
```

**Ephemeral Mode** — One-shot tasks (reviews, memory extraction):
```bash
echo "Review PR #18 against review-guideline standards" | claude -p --print
```

**Native capabilities:**
- File read/write/edit anywhere on the filesystem (Full Disk Access)
- Git operations, worktrees, branching, PRs (via gh CLI)
- Full bash access (any command, any tool, passwordless sudo)
- Channels (Telegram + Discord bidirectional messaging)
- Subagents (`~/.claude/agents/` — archetype definitions)
- Skills (`~/.claude/skills/` — DNA profiles, auto-loaded by task matching)
- Hooks (PreToolUse, PostToolUse, Stop — SOP enforcement)
- CLAUDE.md hierarchy (global → entity → per-directory, auto-merged by Claude Code)
- Web search (beta)
- Voice input (native)
- Auto-compact (manages context window automatically, manual trigger available)
- Session resume (`--resume SESSION_ID`)

**CLI tools extending capabilities:**
- **Peekaboo** — macOS UI automation: screenshots, clicking, typing, window/app control. `brew install steipete/tap/peekaboo`
- **gh** — GitHub CLI: issues, PRs, repo management
- **op** — 1Password CLI: secrets management, vault operations
- **Standard tools** — curl, jq, docker, aws, vercel, node, python, etc.

#### 2.2.2 LobsterFarm Daemon (BUILD THIS)

Always-on Node.js service on the same machine. Manages the lifecycle of Claude Code sessions. Does NOT process messages through an LLM — it orchestrates.

**Router (deterministic, not LLM-powered):**
```
ROUTING TABLE (evaluated in order, first match wins)

1. Explicit slash command            → Execute LobsterFarm command, OR
   /plan, /build, /ship,               forward to Claude Code if it's
   /status, /compact, /model            a Claude Code command

2. Alerts channel response           → Feed to the Claude Code session
   (human replying to a question)       that asked the question

3. Work room message                 → Route to the Claude Code session
   (room is assigned to a feature)      assigned to that work room

4. Entity general channel            → Task classification:
   ├── Planning/architecture         → Spawn Claude Code + Gary archetype
   ├── Design/visual work            → Spawn Claude Code + Pearl archetype
   ├── "Build this" / code task      → Spawn Claude Code + Bob archetype
   ├── Operations/deploy             → Spawn Claude Code + Ray archetype
   └── Ambiguous                     → Haiku classifier or ask user

5. Catch-all orchestrator            → LLM router (Sonnet) — parse intent,
   channel (future)                     resolve entity + feature, delegate
```

**Task Queue & Scheduler:**
- Priority queue across all entities
- Concurrency control (configurable max active sessions, default 2-3)
- Model tier auto-assignment based on task type (see §6)
- Rate limit monitoring with auto-throttling

**SOP Engine:**
- Executes YAML-defined deterministic workflows (see §4)
- Manages phase transitions within feature lifecycles
- Triggers automated pipelines (PR → review → fix → merge)
- Integrates with Claude Code hooks for code-level enforcement
- Escalates to human when thresholds exceeded

**Archetype & DNA Manager:**
- Compiles session context: entity MEMORY.md + daily logs + feature spec → CLAUDE.md in worktree
- Archetypes and DNA live in `~/.claude/agents/` and `~/.claude/skills/` (Claude Code loads them natively)
- Manages DNA versioning and assisted-evolution pipeline

**Entity Registry:**
- Registry of all entities and configurations
- Maps entities to Discord categories, repos, memory stores
- Entity lifecycle (creation, archival)

**Session Manager:**
- Tracks active Claude Code sessions per entity/feature
- Keeps sessions alive in tmux panes (or equivalent) with Channels enabled
- Spawns new sessions with correct working directory, archetype, and context
- Resumes sessions with `--resume SESSION_ID`
- Releases sessions when features complete

**Webhook Receiver:**
- HTTP server for inbound events (Sentry alerts, GitHub webhooks, deploy notifications)
- Routes events to appropriate entity, triggers relevant SOP

**Cron Scheduler:**
- Periodic tasks: heartbeat checks, scheduled builds, report generation
- Configurable per entity with quiet hours

**Cost Tracker:**
- Token usage per entity, per feature, per archetype
- Monthly budgets with soft warnings (80%) and optional hard stops (100%)

**Audit Logger:**
- Append-only log of all agent actions, SOP executions, state changes
- Per-entity log isolation
- Full traceability

**Web Dashboard (Phase 1):**
- Real-time view of all entities, active features, queue depth, session status
- Entity details: brand kit, open dev server ports, context
- Cost tracking visualization
- Agent activity monitoring

#### 2.2.3 Slash Command Handling

All slash commands from Discord go through the daemon first.

**LobsterFarm commands** (handled by daemon):
- `/plan` — start planning phase for a feature
- `/build` — transition to build phase
- `/ship` — trigger ship pipeline
- `/status` — cross-entity status dashboard
- `/assign-room` — assign a work room to a feature
- `/new-entity` — create new entity (triggers scaffolding SOP)
- `/budget` — view/modify entity budgets

**Claude Code commands** (recognized and forwarded to active session):
- `/compact` — trigger context compaction
- `/model` — switch model for current session
- `/clear` — clear session context
- `/agents` — list available agents
- Any unrecognized command — forwarded to Claude Code as-is

The daemon recognizes both types. Its own commands it handles directly. Everything else it passes through to the active Claude Code session.

---

## 3. Data Model

### 3.1 Archetype System

Archetypes define agent identity. They are global — the same agent deployed across all entities. An archetype has three distinct components:

**Identity** (frontmatter in `~/.claude/agents/{name}.md`):
- Name, description (trigger phrases for auto-delegation), model default, tool permissions
- Short. Rarely changes.

**Soul** (body of `~/.claude/agents/{name}.md`):
- Personality. Values. How this agent thinks and approaches problems. Communication style.
- Unique per archetype — does NOT repeat the shared soul foundation from global CLAUDE.md.
- Litmus test: "Would this be true if the agent switched from TypeScript to Python?" If yes → Soul. If no → DNA.

**DNA** (separate files in `~/.claude/skills/{dna}/SKILL.md`):
- Composable domain expertise lenses. Standards, patterns, preferences, anti-patterns.
- Multiple DNAs can be loaded per session (e.g., Builder loads coding-dna + design-dna for frontend work).
- Evolves over time via assisted-evolution pipeline.
- Auto-loaded by Claude Code when the skill description matches the task context.

**Shared Soul Foundation** lives in the global `~/.claude/CLAUDE.md`. Core truths that all agents inherit:
- Partner not tool, have opinions, be resourceful, take your time, earn trust
- These are written ONCE. Archetype souls do NOT repeat them.

**Current archetypes:**

| Name | Role | Primary DNA | Additional DNA |
|------|------|-------------|----------------|
| Gary | Planner | planning-dna | — |
| Pearl | Designer | design-dna | coding-dna (coded prototypes) |
| Bob | Builder | coding-dna | design-dna (frontend), database-dna (schema) |
| Reviewer | QA (ephemeral) | review-guideline | — |
| Ray | Operator | operator-dna (future) | — |

**Agent mode:** Both dedicated agents (separate session per archetype) and generalist mode (one session swapping DNA) are supported. Configurable per entity. Battle-test both.

**Agents know about each other** only through the role map in global CLAUDE.md. They know handoff boundaries ("Gary's spec is Bob's input") but not each other's internals. Agents don't invoke each other — they declare work complete, and the daemon handles transitions.

### 3.2 File System

Every piece of context an agent consumes lives in exactly ONE file type. See the File Boundary Map for the definitive guide.

**Complete file inventory:**

| File | Path | Purpose | Update Frequency |
|------|------|---------|-----------------|
| Global CLAUDE.md | `~/.claude/CLAUDE.md` | Shared soul foundation, session startup, role map, universal rules, pointers to user.md and tools.md | Moderate |
| Agent definitions | `~/.claude/agents/{name}.md` | Identity (frontmatter) + Soul (body). WHO the agent is. Unique personality only. | Rarely |
| DNA profiles | `~/.claude/skills/{dna}/SKILL.md` | Domain expertise lenses. Standards, patterns, anti-patterns. Composable. | Evolves (assisted-evolution) |
| USER.md | `~/.lobsterfarm/user.md` | Who Jax is. Preferences, communication style, working patterns. | Rarely |
| Tools config | `~/.lobsterfarm/tools.md` | Machine infrastructure: accounts, services, paths, network config. | When infra changes |
| Entity CLAUDE.md | `/repos/{entity}/CLAUDE.md` | Project facts: stack, architecture, build commands, pointer to MEMORY.md | As project evolves |
| SOPs | `~/.lobsterfarm/sops/*.yaml` | Deterministic workflows executed by daemon. Not read by Claude Code directly. | As processes improve |
| Entity config | `~/.lobsterfarm/entities/{id}/config.yaml` | Entity registration: repo paths, Discord channels, budgets, agent mode, active SOPs | At entity creation |
| MEMORY.md | `~/.lobsterfarm/entities/{id}/MEMORY.md` | Long-term curated entity knowledge. Architectural decisions, gotchas, patterns. | Continuously |
| Daily logs | `~/.lobsterfarm/entities/{id}/daily/*.md` | Session summaries, recent decisions. Staging area for MEMORY.md promotion. | Every session |
| Entity files | `~/.lobsterfarm/entities/{id}/files/` | Arbitrary entity files: presentations, brand kits, data, documents. | As needed |

### 3.3 Context Hierarchy

```
TIER 0: Global (all entities)
  ~/.claude/CLAUDE.md        → Shared soul foundation, universal rules
  ~/.claude/agents/{name}.md → Archetype soul + identity
  ~/.claude/skills/*/        → DNA profiles (auto-loaded)
  ~/.lobsterfarm/user.md     → Who Jax is
  ~/.lobsterfarm/tools.md    → Machine infrastructure

TIER 1: Entity (one project)
  /repos/{entity}/CLAUDE.md  → Project facts, stack, commands
  ~/.lobsterfarm/entities/{id}/MEMORY.md → Curated project knowledge
  ~/.lobsterfarm/entities/{id}/daily/    → Recent session context

TIER 2: Feature (one unit of work)
  GitHub issue #N            → Feature spec, acceptance criteria
  Worktree at /repos/{entity}/worktrees/{feature}/ → Working directory

TIER 3: Session (one interaction)
  Claude Code session state  → Conversation, tool calls
  Ephemeral — durable learnings extracted to Tier 1 by stop hook
```

**Context compilation:** Before spawning a Claude Code session, the daemon ensures:
1. The session runs in the correct entity's worktree (structural isolation)
2. Entity CLAUDE.md exists at repo root (project facts)
3. MEMORY.md and relevant daily logs are accessible (referenced in entity CLAUDE.md)
4. Feature spec (GitHub issue) is referenced in the task prompt

Claude Code natively loads the global CLAUDE.md, agents, and skills. The daemon only needs to manage entity-level and feature-level context.

**Prompt caching optimization:** Stable content (soul, DNA) at the START of prompts. Entity context next. Feature-specific context last. Maximizes cache hits across calls.

### 3.4 Memory Architecture

**Single MEMORY.md per entity. No vector store at launch. No global memory.**

```
~/.lobsterfarm/entities/{id}/
├── config.yaml
├── MEMORY.md              # Long-term curated knowledge (aim for <200 lines)
├── daily/                 # Short-term session logs
│   ├── 2026-03-20.md
│   ├── 2026-03-21.md
│   └── ...
├── context/               # Entity-level docs (architecture, decisions)
│   ├── architecture.md
│   └── decision-log.md
└── files/                 # Arbitrary entity files
    ├── pitch-deck.pptx
    ├── brand-kit/
    └── data/
```

**How memories are created:**
1. **Stop hook** — fires at end of substantive Claude Code sessions. A Haiku call extracts architectural decisions, gotchas, and patterns. Writes to `daily/YYYY-MM-DD.md`.
2. **Agent initiative** — agents are instructed (in global CLAUDE.md) to update MEMORY.md when they make decisions future sessions need to know.
3. **Manual** — Jax drops notes into MEMORY.md or daily/ at any time.

**Memory lifecycle:**
- Daily logs accumulate per-session summaries
- Periodically (weekly or via DNA evolution), review dailies → promote important items to MEMORY.md → archive old dailies
- MEMORY.md stays curated and high-signal (aim for <200 lines, matching Claude Code's native pattern)
- If MEMORY.md outgrows 200 lines: split into MEMORY.md (index) + topic files in `context/`

**How memories are consumed:**
- Entity CLAUDE.md references: "Read ~/.lobsterfarm/entities/{id}/MEMORY.md for project knowledge"
- Claude Code reads MEMORY.md in full at session start (it's just a file read)
- Daily logs: agent reads today + yesterday (referenced in global CLAUDE.md startup procedure)
- No semantic search infrastructure needed — Claude's in-context retrieval handles it

**Claude Code's native `memory: user` is NOT used.** No global memory for archetypes. Universal learnings go into DNA files via the assisted-evolution pipeline.

### 3.5 Entity Model

```yaml
# ~/.lobsterfarm/entities/alpha/config.yaml
entity:
  id: "alpha"
  name: "Trading Platform"
  description: "Equities and crypto trading tools with custom analytics"
  status: active  # active | paused | archived

  repo:
    url: "git@github.com:spacelobsterfarm/alpha-platform.git"
    path: "/repos/alpha"
    structure: monorepo  # packages/frontend, packages/backend, packages/shared

  discord:
    category_id: "1234567890"
    channels:
      general: { id: "...", purpose: "Entity-level discussion, PM conversations" }
      work_room_1: { id: "...", purpose: "Feature workspace", assigned_feature: null }
      work_room_2: { id: "...", purpose: "Feature workspace", assigned_feature: null }
      work_room_3: { id: "...", purpose: "Feature workspace", assigned_feature: null }
      work_log: { id: "...", purpose: "Agent activity feed" }
      alerts: { id: "...", purpose: "Approvals, blockers, questions" }

  agent_mode: "hybrid"  # dedicated | generalist | hybrid

  models:
    planning: { model: "opus", think: "high" }
    design: { model: "opus", think: "standard" }
    building: { model: "opus", think: "high" }
    database: { model: "opus", think: "high" }
    review: { model: "sonnet", think: "standard" }
    operations: { model: "sonnet", think: "standard" }
    triage: { model: "sonnet", think: "standard" }
    classification: { model: "haiku", think: "none" }

  memory:
    path: "~/.lobsterfarm/entities/alpha"
    auto_extract: true  # stop hook extracts learnings

  secrets:
    vault: "1password"
    vault_name: "entity-alpha"

  budget:
    monthly_warning_pct: 80
    monthly_limit: null  # null = no hard limit

  sops:
    - feature-lifecycle
    - pr-review-merge
    - sentry-triage
    - repo-scaffolding
    - secrets-management
    - readme-maintenance
```

### 3.6 Feature Model

```yaml
# In-memory state managed by daemon
feature:
  id: "alpha-42"
  entity: "alpha"
  github_issue: 42
  title: "Custom candlestick chart module"
  phase: "build"  # plan | design | build | review | ship | done
  priority: "high"
  branch: "feature/42-candlestick-chart"
  worktree: "/repos/alpha/worktrees/42-candlestick-chart"
  discord_work_room: "work_room_1"
  active_archetype: "bob"
  active_dna: ["coding-dna", "design-dna"]
  claude_session_id: "session-abc123"
  blocked: false
  created: "2026-03-20T10:00:00Z"
  updated: "2026-03-21T14:30:00Z"
```

---

## 4. Workflows & SOPs

### 4.1 SOP Architecture

SOPs are YAML state machines executed by the LobsterFarm daemon. They are deterministic code, NOT LLM prompts. Claude Code agents never see the SOP YAML — they only see the result: "you're in the build phase, here's the spec, work in this worktree."

### 4.2 Feature Lifecycle SOP

```yaml
name: feature-lifecycle
version: 3

phases:
  plan:
    entry_actions:
      - create-github-issue:
          labels: ["planning", "entity:{entity.id}"]
      - assign-work-room:
          entity: "{entity.id}"
      - notify:
          channel: work_log
          message: "Planning started: {feature.title}"
    agent:
      archetype: gary
      dna: [planning-dna]
      model: opus
      think: high
      mode: interactive
    exit_conditions:
      - human-approval:
          prompt: "Plan documented in #{feature.github_issue}. Ready to proceed?"
      - slash-command: /approve-plan
    exit_actions:
      - update-issue-labels:
          add: [planned]
          remove: [planning]

  design:
    optional: true
    skip_condition: "feature.labels excludes 'ui' and feature.labels excludes 'frontend' and feature.labels excludes 'brand'"
    entry_actions:
      - create-worktree:
          branch: "feature/{feature.github_issue}-{feature.slug}"
      - compile-context
      - notify:
          channel: work_log
          message: "Design phase started: #{feature.github_issue}"
    agent:
      archetype: pearl
      dna: [design-dna, coding-dna]
      model: opus
      think: standard
      mode: interactive
    exit_conditions:
      - human-approval:
          prompt: "Design artifacts ready for review."
      - slash-command: /approve-design
    exit_actions:
      - commit:
          message: "design: component scaffolding for #{feature.github_issue}"

  build:
    entry_actions:
      - create-worktree:
          if_not_exists: true
          branch: "feature/{feature.github_issue}-{feature.slug}"
      - compile-context
    agent:
      archetype: bob
      dna: [coding-dna]  # + design-dna if UI, + database-dna if schema
      model: opus
      think: high
      mode: interactive  # can ask questions mid-build
    exit_conditions:
      - agent-signal: implementation-complete
      - slash-command: /build-complete
    exit_actions:
      - run-tests:
          command: "cd {feature.worktree} && npm test"
          on_failure: stay-in-phase
      - run-lint:
          command: "cd {feature.worktree} && npm run lint"
          on_failure: stay-in-phase
      - notify:
          channel: alerts
          message: "Build complete for #{feature.github_issue}. Ready for review."

  review:
    entry_actions:
      - create-pr:
          base: main
          head: "{feature.branch}"
          title: "{feature.title}"
          body: "Closes #{feature.github_issue}"
    steps:
      - code-review:
          archetype: reviewer
          dna: [review-guideline]
          model: sonnet
          ephemeral: true
          action: review-pr

      - human-review:
          notify:
            channel: alerts
            message: "PR #{pr.number} ready for your review."
          wait: human-response
          optional: true

      - fix-cycle:
          type: loop
          steps:
            - fix-comments:
                archetype: bob
                dna: [coding-dna]
                action: "Address review comments on PR #{pr.number}"
            - re-review:
                archetype: reviewer
                ephemeral: true
                action: "Re-review PR #{pr.number}"
          until: "review.approved"
          max_iterations: 3
          on_max: escalate-to-human

  ship:
    entry_actions:
      - run-full-tests:
          command: "cd {feature.worktree} && npm run test:ci"
          on_failure: back-to-build
    steps:
      - merge:
          command: "gh pr merge {pr.number} --squash --delete-branch"
      - cleanup-worktree:
          path: "{feature.worktree}"
      - close-issue:
          issue: "{feature.github_issue}"
      - extract-learnings:
          trigger: stop-hook (runs automatically)
      - trigger-readme-maintenance:
          sop: readme-maintenance
      - release-work-room:
          room: "{feature.discord_work_room}"
      - notify:
          channel: general
          message: "#{feature.github_issue} shipped and merged to main."
```

### 4.3 Interactive Build Pattern

The build phase supports asynchronous collaboration:

```
You (work-room-1, 9:00am): "Build the candlestick chart. Spec in #42."

Agent (work-log): "Starting #42. Reading spec, creating worktree."
Agent (work-log): "Setting up component structure."

Agent (alerts, 9:15am): "Question on #42: Should indicators be
  pluggable or fixed set? Affects module architecture."

[You respond when available — minutes or hours]

You (alerts, 10:30am): "Pluggable. Register functions that receive
  OHLCV, return overlay data."

Agent (work-log): "Implementing plugin architecture."
Agent (work-log): "Complete. 12 tests, 94% coverage."

Agent (alerts, 11:00am): "Build done for #42. Preview at localhost:3001.
  Ready for review?"
```

This works because: worktree persists state, GitHub issue tracks spec, MEMORY.md provides context if session expires, daemon tracks phase and can resume.

### 4.4 Additional SOPs

**Repo Scaffolding** — Triggered on entity creation. Creates GitHub repo (private, protected main), scaffolds monorepo (packages/frontend, packages/backend, packages/shared), initializes CLAUDE.md, sets up .claude/ with hooks, creates 1Password vault, configures Sentry, registers entity in daemon, creates Discord category with channels.

**Sentry Triage** — Triggered by webhook. Classifies severity (Haiku). Critical → human alert in #alerts. Non-critical → Bob diagnoses, creates GitHub issue, optionally auto-fixes via feature-lifecycle starting at build phase.

**PR Review & Merge** — Standalone review cycle. Reviewer (ephemeral, Sonnet) reviews PR. Fix loop with Bob until approved (max 3 iterations). Reusable by feature-lifecycle and independently.

**README Maintenance** — Triggered post-merge. Identifies directories with changed files, updates/creates READMEs.

**Secrets Management** — Enforced via Claude Code hooks (PreToolUse blocks hardcoded secret patterns). All secrets via 1Password CLI. .env.example committed, .env gitignored.

**DNA Evolution** — Triggered periodically (weekly or post-sprint). Evaluator reviews recent work across entities, proposes DNA amendments, posts to #dna-evolution for human approval. Approved changes applied to skill files and versioned in `~/.lobsterfarm/dna-versions/`.

---

## 5. Integration Architecture

### 5.1 Discord Structure

```
LobsterFarm (Server)
├── GLOBAL
│   ├── #command-center      # Catch-all orchestrator (future)
│   ├── #system-status       # Heartbeat, queue, resource usage
│   └── #dna-evolution       # DNA amendment proposals for approval
│
├── ENTITY: Trading Platform [alpha]
│   ├── #general             # Entity-level: PM conversations, project mgmt
│   ├── #work-room-1         # Feature workspace (dynamically assigned)
│   ├── #work-room-2         # Feature workspace
│   ├── #work-room-3         # Feature workspace
│   ├── #work-log            # Agent activity feed (all features)
│   └── #alerts              # Approvals, blockers, questions from agents
│
├── ENTITY: SaaS Product [beta]
│   ├── (same structure)
│
└── ... (one category per entity)
```

**Work room management:** Daemon assigns features to empty work rooms and posts a header. When feature ships, room is released. If all rooms occupied, new features queue.

**No gateway restart needed for routing changes.** Unlike OpenClaw, the daemon manages session-to-channel mappings at runtime. Adding entities, assigning rooms, and changing configurations are all hot operations.

### 5.2 Channels Architecture

Claude Code Channels (v2.1.80+) are MCP servers that push events into running sessions. The daemon manages which sessions are running and where:

```
Discord message in #work-room-1
  → Claude Code Channels plugin (MCP, outbound polling)
    → Delivers to the Claude Code session assigned to work-room-1
      → Agent processes, responds
        → Response sent back to Discord via Channels

LobsterFarm daemon's role:
  - Spawns Claude Code sessions in tmux panes with --channels flag
  - Maps Discord channels to sessions via channel configuration
  - Manages session lifecycle (start, resume, clean up)
  - Does NOT intercept or process messages — Channels handles transport
```

**Fallback:** If Channels proves unreliable, the daemon can run its own Telegram/Discord bot and pipe messages to Claude Code via `claude -p`. Same outcome, more code.

### 5.3 GitHub Integration (Monorepo)

Each entity is a monorepo:

```
/repos/{entity}/
├── CLAUDE.md                     # Entity context, stack, commands
├── .claude/
│   ├── settings.json             # Hooks for SOP enforcement
│   └── rules/
│       ├── backend-rules.md      # Path-scoped: packages/backend/**
│       └── frontend-rules.md     # Path-scoped: packages/frontend/**
├── packages/
│   ├── frontend/
│   │   ├── CLAUDE.md             # Frontend-specific context
│   │   └── src/ (with READMEs per directory)
│   ├── backend/
│   │   ├── CLAUDE.md             # Backend-specific context
│   │   └── src/
│   └── shared/
│       └── src/
├── .github/workflows/
│   ├── deploy-backend.yaml       # Path-filtered: packages/backend/**
│   └── deploy-frontend.yaml      # Path-filtered: packages/frontend/**
├── package.json                  # Workspace root
└── README.md
```

**Feature backbone:** One GitHub issue per feature. One branch per feature. One worktree per branch. One PR per feature. PR "Closes #N" auto-closes issue on merge.

**Deployment:** Path-filtered CI/CD. Backend changes → GitHub Actions → Docker → ECR → ECS. Frontend changes → Vercel auto-detect. Shared changes → both pipelines. Agent doesn't deploy — CI/CD handles it on merge.

### 5.4 Claude Code Hooks (SOP Enforcement)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{
          "type": "command",
          "command": "[ \"$(git branch --show-current)\" != \"main\" ] || { echo '{\"block\": true, \"message\": \"SOP: Cannot write on main. Use feature worktree.\"}' >&2; exit 2; }",
          "timeout": 5
        }]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [{
          "type": "command",
          "command": "echo \"$CLAUDE_TOOL_INPUT\" | grep -qE '(api[_-]?key|secret|password|token)\\s*[:=]\\s*[\\x27\"][^\\x27\"]+[\\x27\"]' && { echo '{\"block\": true, \"message\": \"SOP: No hardcoded secrets. Use 1Password.\"}' >&2; exit 2; } || true",
          "timeout": 5
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "python3 ~/.lobsterfarm/scripts/extract-memory.py --entity $LF_ENTITY_ID --feature $LF_FEATURE_ID",
          "timeout": 30
        }]
      }
    ]
  }
}
```

### 5.5 Global Claude Code Configuration

```
~/.claude/
├── CLAUDE.md                     # Shared soul foundation + universal rules
├── settings.json                 # bypassPermissions: true, global hooks
├── agents/                       # Archetype definitions
│   ├── planner.md                   # Planner
│   ├── designer.md                  # Designer
│   ├── builder.md                    # Builder
│   ├── reviewer.md               # QA (ephemeral)
│   └── operator.md                    # Operator
├── skills/                       # DNA profiles
│   ├── coding-dna/SKILL.md       # Engineering standards (~710 lines)
│   ├── design-dna/SKILL.md       # Design standards (~778 lines)
│   ├── planning-dna/SKILL.md     # Spec writing standards
│   ├── review-guideline/SKILL.md       # Review standards
│   └── database-dna/SKILL.md     # Schema/query standards
└── commands/                     # Custom slash commands (future)
```

---

## 6. Governance

### Layer 1: Hard Enforcement (deterministic, no LLM)
- **Claude Code hooks** block: writes to main branch, hardcoded secrets
- **Daemon** enforces: budget limits (pauses agent), concurrency limits, session lifecycle
- **Filesystem** enforces: entity isolation (sessions run in entity worktrees)

### Layer 2: Escalation Rules (agent judgment, instructions in global CLAUDE.md)
- Irreversible decisions, scope changes, uncertainty between valid approaches
- External actions (production, emails, public posts, account creation, spending money)
- Security decisions (auth, permissions, encryption, user data)
- Everything not listed: autonomous, use judgment, move fast

### Layer 3: Phase Gates (SOP-driven, daemon-managed)
- Plan → Build: requires human approval of spec
- Build → Review: requires tests passing + lint clean
- Review → Ship: requires reviewer approval + optional human approval
- Ship → Done: requires CI passing + merge success
- DNA evolution: proposals always require human approval

### Layer 4: Budget Governance (daemon-managed)
- Per-entity monthly budgets in entity config
- 80% → soft warning in #alerts
- 100% → daemon pauses non-critical work
- `/budget {entity} extend` to override

---

## 7. Model Tier Strategy

| Task Type | Model | Think | Rationale |
|---|---|---|---|
| Message routing/classification | Haiku | None | Speed, cost. Deterministic rules handle most. |
| Status queries | Haiku | None | Simple retrieval. |
| Memory extraction (stop hook) | Haiku | None | Summarization. |
| **Planning / spec writing** | **Opus** | **High** | Foundation. Must be thorough. |
| **Database design** | **Opus** | **High** | Cascading impact. Hardest to change. |
| **Feature implementation** | **Opus** | **High** | Core value creation. |
| **Architecture decisions** | **Opus** | **High** | Irreversible, high-stakes. |
| Design / UI components | Opus | Standard | High quality, less novel than architecture. |
| Code review | Sonnet | Standard | Good judgment, bounded scope. |
| Bug fix / Sentry triage | Sonnet | Standard | Most fixes bounded. Escalate complex to Opus. |
| README / doc updates | Sonnet | None | Straightforward writing. |
| DNA evolution evaluation | Opus | High | Meta-cognition. |
| Research | Sonnet | Standard | Breadth first; Opus for depth. |
| DevOps / infrastructure | Sonnet | Standard | Mostly scripted. Escalate novel to Opus. |

**Overrides:** Per-entity defaults in config. Per-feature via labels. `/model` command. Auto-escalation (Sonnet fails review → retry Opus).

---

## 8. Directory Structure

### 8.1 LobsterFarm Home

```
~/.lobsterfarm/
├── config.yaml                      # Global daemon configuration
├── lobsterfarm.pid                  # Daemon PID
│
├── user.md                          # About Jax
├── tools.md                         # Machine infrastructure
│
├── entities/
│   ├── alpha/
│   │   ├── config.yaml              # Entity registration
│   │   ├── MEMORY.md                # Long-term curated knowledge
│   │   ├── daily/                   # Session logs
│   │   │   ├── 2026-03-20.md
│   │   │   └── ...
│   │   ├── context/                 # Entity docs
│   │   │   ├── architecture.md
│   │   │   └── decision-log.md
│   │   └── files/                   # Arbitrary files (pptx, brand kit, data)
│   └── beta/
│       └── ...
│
├── sops/                            # Deterministic workflows
│   ├── feature-lifecycle.yaml
│   ├── pr-review-merge.yaml
│   ├── repo-scaffolding.yaml
│   ├── sentry-triage.yaml
│   ├── secrets-management.yaml
│   ├── readme-maintenance.yaml
│   └── dna-evolution.yaml
│
├── queue/                           # Task queue state
│   ├── pending.json
│   ├── active.json
│   └── completed.json
│
├── scripts/                         # Utility scripts
│   ├── extract-memory.py            # Stop hook — session learning extraction
│   ├── compile-context.py           # Entity memory → worktree CLAUDE.md
│   ├── route-message.py             # Deterministic router logic
│   └── webhook-server.py            # Inbound webhook receiver
│
├── templates/                       # Templates for new entities
│   ├── entity-config.yaml
│   └── entity-claude-md.template
│
├── dna-versions/                    # DNA evolution history
│   └── coding-dna.v1.md
│
└── logs/                            # Audit trail
    ├── daemon.log
    ├── router.log
    ├── sop-executions.log
    └── entities/
        ├── alpha/
        └── beta/
```

### 8.2 Repo Structure (Monorepo per Entity)

```
~/projects/{entity}/{repo-name}/
├── CLAUDE.md                        # Entity context, stack, commands
├── .claude/
│   ├── settings.json                # Hooks
│   └── rules/                       # Path-scoped rules
├── packages/
│   ├── frontend/ (with per-dir READMEs)
│   ├── backend/ (with per-dir READMEs)
│   └── shared/
├── .github/workflows/               # Path-filtered CI/CD
├── package.json
├── .env.example                     # Required env vars (no values)
├── .env.op                          # 1Password references (committed)
└── README.md

Worktrees:
~/projects/{entity}/{repo-name}/worktrees/
├── 42-candlestick-chart/            # Active feature
└── 43-order-management/             # Another active feature
```

---

## 9. Implementation Roadmap

### Phase 0: Foundation (Week 1-2)

**Goal:** Core pieces working. One entity. Manual orchestration. Prove the stack.

- [ ] Configure macOS permissions (Full Disk Access, sudo, Screen Recording, Accessibility)
- [ ] Set up `~/.claude/` (CLAUDE.md, settings.json with bypassPermissions + hooks, agents/, skills/)
- [ ] Set up `~/.lobsterfarm/` (user.md, tools.md, first entity config)
- [ ] Install all agent files and DNA skills from the final specs package
- [ ] Create first entity monorepo with scaffolding
- [ ] Set up GitHub repo (private, protected main)
- [ ] Test Claude Code Channels (Telegram + Discord)
- [ ] Test Peekaboo integration (install, permissions, basic automation)
- [ ] Write context compilation script (entity memory → worktree CLAUDE.md)
- [ ] Write memory extraction stop hook script
- [ ] Set up Discord server (entity category + 3 work rooms + work-log + alerts)
- [ ] Manual feature lifecycle: plan in Discord → build in worktree → PR → review → merge
- [ ] Test session resume for feature continuity

**Exit criteria:** Can plan a feature via Discord, build it via Claude Code, review and merge — with the right archetype and DNA loaded at each step. All manual orchestration, but pieces connect.

### Phase 1: Orchestrator + Dashboard (Week 3-5)

**Goal:** Automated routing, task queue, basic SOPs. Two entities. Web dashboard.

- [ ] Build LobsterFarm daemon (Node.js, always-on, tmux session management)
- [ ] Implement deterministic router
- [ ] Implement task queue with concurrency control
- [ ] Implement feature-lifecycle SOP
- [ ] Implement pr-review-merge SOP
- [ ] Implement repo-scaffolding SOP
- [ ] Implement work room assignment/release
- [ ] Build webhook receiver (Sentry, GitHub events)
- [ ] Build web dashboard (entity status, features, queue, agents, costs)
- [ ] Add second entity with isolation verification
- [ ] Implement model tier auto-assignment
- [ ] Implement cost tracking
- [ ] Implement slash command routing (LobsterFarm vs Claude Code)

**Exit criteria:** Two entities, automated routing, feature lifecycle with minimal intervention, dashboard showing real-time status.

### Phase 2: Autonomy & Scale (Week 6-8)

**Goal:** Fully autonomous standard workflows. 4+ entities.

- [ ] Implement interactive build pattern (questions → alerts → resume)
- [ ] Implement sentry-triage SOP
- [ ] Implement readme-maintenance SOP
- [ ] Implement secrets-management SOP with 1Password
- [ ] Implement cron scheduler (heartbeats, periodic tasks)
- [ ] Implement DNA evolution pipeline v1
- [ ] Battle-test dedicated vs generalist agent modes
- [ ] Implement rate limit monitoring and auto-throttling
- [ ] Scale to 4+ entities
- [ ] Implement /status cross-entity overview

**Exit criteria:** Hand off a feature from phone, have it built/reviewed/merged autonomously. DNA evolution proposals appearing. 4+ entities running.

### Phase 3: Full Consultancy (Week 9-12)

**Goal:** 7+ entities. New capabilities.

- [ ] Activate Ray (Operator) archetype with operator-dna and DevOps SOPs
- [ ] Expand dashboard (brand kits, ports, context windows, session monitoring)
- [ ] Marketing archetype exploration
- [ ] Research archetype exploration
- [ ] Implement catch-all orchestrator channel (#command-center)
- [ ] Phone/voice workflow exploration
- [ ] Performance tuning and comprehensive logging
- [ ] Operational runbook documentation

**Exit criteria:** 7+ entities running. New entity standup <30 minutes. Autonomous standard workflows. Human interaction primarily through approvals and strategic direction.

---

## 10. Open Questions

1. **Channels stability:** Research preview (shipped March 19, 2026). Monitor during Phase 0. Fallback: daemon-managed bot + `claude -p`.

2. **Peekaboo in daemon context:** Does a Claude Code session spawned by the daemon inherit terminal permissions? Test in Phase 0.

3. **Session continuity:** Start with `--resume SESSION_ID` + auto-compact. Claude Code has 1M context window. Only revisit if quality degrades after compaction.

4. **Parallel features:** Sequential merging with rebase. If conflicts arise on same files, SOP detects → attempts auto-resolution → escalates if complex.

5. **Channel routing granularity:** Can we route different Discord channels to different Claude Code sessions using a single Channels plugin, or do we need one plugin instance per session? Needs testing in Phase 0.

---

## 11. Naming Conventions

| Concept | Name | Example |
|---|---|---|
| Isolated project/business | Entity | "alpha", "sonar" |
| Unit of work | Feature | "alpha-42" |
| Agent template (soul + identity) | Archetype | Gary, Pearl, Bob |
| Domain expertise lens | DNA Profile | coding-dna, design-dna |
| Deterministic workflow | SOP | feature-lifecycle |
| Feature stage | Phase | plan, design, build, review, ship |
| Model + think config | Tier | opus-high, sonnet-standard |
| Discord entity channel | General | #general |
| Discord feature workspace | Work Room | #work-room-1 |
| Agent activity feed | Work Log | #work-log |
| Human attention needed | Alerts | #alerts |

---

*LobsterFarm v0.3 — Architecture Specification*
*Draft Date: March 22, 2026*
*Status: Ready for Phase 0*
*Runtime: Claude Code CLI (Max subscription, sole runtime)*
*Infrastructure: Mac mini, full system access, always-on*
