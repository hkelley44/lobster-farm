---
name: Blueprints and Commander archetype
description: Blueprint system for entity inheritance, Commander as global admin agent in #command-center
type: project
---

**Blueprints** are reusable templates that entities inherit from. An entity config gains a `blueprint: software` field. At load time, daemon merges blueprint defaults with entity overrides.

A blueprint defines:
- Active archetypes
- DNA profiles per archetype
- Enabled SOPs
- Default model tiers per task type
- Channel structure
- Any other entity config defaults

Example: `software` blueprint = planner + designer + builder + reviewer + operator, feature-lifecycle/PR-review/secrets-management SOPs, coding/design/planning/review/database DNA.

Updating a blueprint propagates to all entities following it. Entities can override specific settings.

Blueprint files: `~/.lobsterfarm/blueprints/{name}.yaml`

**Commander** is a new global archetype (not per-entity). Lives in the GLOBAL Discord category in `#command-center`. Opus high think. Natural language admin interface.

Commander capabilities:
- Create/manage entities (using blueprints or custom config)
- Modify system config (concurrency, model tiers, etc.)
- Adjust blueprints (changes propagate to all following entities)
- Query system status across all entities
- Create new archetypes and SOPs when needed
- Plan new blueprints for non-software use cases

Commander DNA: `commander-dna` — meta-knowledge about LobsterFarm's own architecture, config schemas, SOP definitions, archetype system. Can also load planning-dna when designing new entity workflows.

**Why:** The Commander makes LobsterFarm manageable from Discord (phone). Without it, admin tasks require SSH + CLI. With it, "set up a new entity for my crypto project" just works.

**How to apply:** Blueprint support needs: blueprint schema, blueprint loading in daemon, entity config inheritance/merge logic, Commander agent definition, commander-dna skill file.
