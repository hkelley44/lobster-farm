---
name: LobsterFarm is broader than software
description: Platform is for any structured work with Claude Code, not just software development. Software consultancy is the first instantiation.
type: project
---

LobsterFarm is NOT just a software consultancy tool. It's a structured orchestration platform for ANY work done with Claude Code — software, content, research, business operations, etc.

The software consultancy framing is the first use case. The architecture supports arbitrary entity types, archetypes, DNA profiles, and SOPs.

**Why:** Jax builds primarily software, so the initial SOPs and DNA are software-focused. But the core platform (entities, archetypes, DNA, SOPs, session management, queue, Discord routing) is domain-agnostic.

**How to apply:** When building new features, ensure they're not software-specific unless they're in the SOP/DNA layer. Core daemon, CLI, session manager, queue, router, Discord bot — all should remain domain-agnostic. Software-specific logic lives in SOP definitions and DNA files, not in platform code.

**Command center vision:** A persistent Opus session in #command-center that understands the entire LobsterFarm system. Natural language admin interface — creates entities, modifies config, queries status, manages the system. Not a command parser, but an actual admin agent (potentially a new archetype: Commander/Admin).
