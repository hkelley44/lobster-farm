# LobsterFarm

Autonomous orchestration platform built on Claude Code. Turns a single machine into a structured consultancy with specialized agents, deterministic workflows, and project isolation.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ultim88888888/lobster-farm/main/install.sh | bash
```

Then run the setup wizard:

```bash
lf init
```

The wizard checks for prerequisites (Claude Code, 1Password, sudo), configures your user profile and agent names, sets up Discord, and generates all config files.

### Manual install

```bash
git clone https://github.com/ultim88888888/lobster-farm.git ~/.lobsterfarm/src
cd ~/.lobsterfarm/src
pnpm install && pnpm build
chmod +x $(pwd)/packages/cli/dist/index.js
ln -sf $(pwd)/packages/cli/dist/index.js ~/.local/bin/lf
lf init
```

**Prerequisites:** Node.js 22+, pnpm, Claude Code, 1Password CLI

## Pre-commit Hooks

The repo uses [Husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged) to enforce Biome lint/format checks before each commit. Hooks are installed automatically via the `prepare` script when you run `pnpm install`.

Staged files matching `*.{ts,tsx,js,jsx,json,jsonc}` are run through `biome check --write`, which auto-fixes formatting and lint issues before the commit goes through. If Biome finds unfixable errors, the commit is blocked.

The `--relative` flag is used in the hook to pass relative paths to Biome, which is required for compatibility with git worktrees (Biome's `files.ignore` patterns match against absolute paths).

## Usage

```bash
lf start          # Start the daemon
lf stop           # Stop the daemon
lf restart        # Hot-restart (preserves sessions)
lf status         # Show daemon status
```

Discord slash commands (after setup):

| Command | Description |
|---------|-------------|
| `/status` | Daemon and session status |
| `/scaffold` | Create entity with Discord channels |
| `/swap` | Switch agent archetype in a work room |
| `/room` | Create a new work room |
| `/close` | Close and archive a work room session |
| `/resume` | Restore an archived session |
| `/archives` | List archived sessions |
| `/reset` | Release current bot, fresh assignment on next message |

## Architecture

```
CLI (lf)                   Daemon (always-on)              Claude Code CLI
  init                       HTTP API (:7749)                Agents (Gary, Pearl, Bob...)
  start/stop/restart         Session Manager                 Skills (DNA profiles)
  entity create/list         Task Queue                      Hooks (SOP enforcement)
                             Discord Bot + Pool              CLAUDE.md hierarchy
                             AutoReviewer (GitHub App)
                             Persistence
```

**Entities** — isolated projects with their own repos, memory, and Discord channels

**Archetypes** — specialized agent identities (planner, designer, builder, reviewer, operator)

**DNA** — composable domain expertise (coding standards, design principles, review criteria)

**AutoReviewer** — GitHub App that auto-reviews PRs, auto-merges on approval, and spawns fix sessions on rejection

## Project Structure

```
packages/
  shared/     Config schemas, path resolver, template engine, YAML loader
  cli/        lf init, entity create/list, start/stop/restart/status
  daemon/     HTTP server, session manager, task queue, Discord bot,
              pool manager, AutoReviewer, webhook handler, persistence
config/       Default templates (agents, skills, user/tools configs)
docs/         Architecture specs
```

## License

Private.
