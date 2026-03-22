---
name: LobsterFarm vision and deployment model
description: Orchestration platform built on Claude Code CLI - designed as a service anyone can run, not just Jax-specific
type: project
---

LobsterFarm is an orchestration platform that turns a machine into an autonomous software consultancy, built entirely on Claude Code CLI as sole execution runtime.

**Key architectural decision:** Build as a runnable service (like OpenClaw), not a personal tool. Anyone should be able to run a setup command and have LobsterFarm running on their machine/VPS.

**What's rigid (same for all instances):** Archetypes (Gary, Pearl, Bob, Reviewer, Ray) and SOPs. Workflow rigidity is the core value proposition.

**What's user-configurable (setup wizard):** DNA files, USER.md, user-specific info in TOOLS.md. These depend on whose LobsterFarm instance it is.

**For Jax's instance:** Use his data in user.md and tools.md — those are his actual preferences/info.

**Deployment target:** Separate machine from daily driver. Jax's instance runs on a Mac mini.

**Why:** Structure is what makes Claude reliable — institutional knowledge, workflows, quality standards, isolation boundaries. LobsterFarm provides that structure.

**How to apply:** All implementation decisions should consider multi-tenancy/portability. Hardcoded paths, personal info, and user preferences should flow through config, not be baked into the platform code.
