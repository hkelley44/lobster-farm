---
name: Architecture design decisions
description: Key design decisions made during initial planning - GitHub per-entity, shared vaults, no contact in user.md
type: project
---

**GitHub accounts are per-entity, not global.** Jax uses different GitHub orgs/accounts for different entities. GitHub config belongs in entity config, not tools.md.

**Why:** User may have separate GitHub orgs for separate businesses/projects. Global tools.md is machine-level only.

**Shared services vault pattern.** Some services (Vercel, Sentry, domain registrar) operate at the account level managing multiple entities. These get a master 1Password vault (`lobsterfarm`). Entity-specific secrets get per-entity vaults (`entity-{id}`).

**Why:** One Vercel account deploys all entity frontends. One Sentry org tracks errors across all entities. Duplicating these per-entity is wasteful.

**user.md has no contact info.** Contact details (email, phone, GitHub) don't belong in the user profile — the agent doesn't need them to do its job. Account identifiers belong in tools.md (shared services) or entity config (per-entity accounts).

**Sudo and permissions are setup steps, not defaults.** tools.md should not assume passwordless sudo or Full Disk Access. The setup wizard configures or guides the user through these.

**How to apply:** When building entity config schema, include a `accounts` section for GitHub org, repo URL, and entity-specific service accounts. When building setup wizard, include permission configuration steps.
