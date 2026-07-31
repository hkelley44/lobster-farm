# CLI Source

The `lf` command-line tool for managing the LobsterFarm daemon and entities. Built with Commander.js for command parsing and @clack/prompts for interactive wizards.

## Files

- `index.ts` -- Entrypoint. Registers all subcommands and invokes Commander's parser.

### commands/

- `init.ts` -- `lf init`. Interactive setup wizard that detects the machine environment, prompts for user/agent names and integrations, generates config files (config.yaml, CLAUDE.md, settings.json, agent files, skills), and creates the full directory structure.
- `start.ts` -- `lf start`. Resolves the daemon entry point, generates a macOS launchd plist, and loads it via `launchctl bootstrap`.
- `stop.ts` -- `lf stop`. Unloads the launchd service via `launchctl bootout`.
- `status.ts` -- `lf status`. Checks the PID file, verifies the process is alive, and queries the daemon's `/status` HTTP endpoint for runtime details.
- `entity.ts` -- `lf entity list` and `lf entity create`. Lists configured entities by scanning `~/.lobsterfarm/entities/`, or creates a new entity with interactive prompts (ID, name, repo, Discord channels) and scaffolds its directory structure and config.
- `update.ts` -- `lf update`. Pulls latest code, rebuilds, and relinks the CLI binary.

### commands/init/

- `detect.ts` -- Machine environment detection: hostname, hardware, platform, and availability checks for sudo, 1Password CLI, Claude Code, Bun, tmux, and GitHub CLI.
- `generate.ts` -- File generation for `lf init`. Copies and resolves templates for agent files, skills, CLAUDE.md, settings.json, user.md, tools.md, and creates the full `~/.lobsterfarm/` directory tree.
- `prompts.ts` -- Interactive prompt functions for `lf init`: user name, agent names (with defaults), Discord server ID, and GitHub username/org.

### lib/

- `launchd.ts` -- macOS launchd integration. Generates the wrapper script (`op inject` + `exec node`, never `op run -- node`, so node is never orphaned holding the port -- issue #97), plist XML, loads/unloads the service via `launchctl`, and reads job state (`get_launchd_job_state`).
- `daemon-health.ts` -- Reconciles the PID file against launchd's view (issue #97). `parse_launchd_print` extracts state/pid/runs/last-exit; `classify_daemon_health` labels the daemon `healthy` / `crash_looping` / `split_brain` / `stopped` / `not_managed` so `lf status` and `lf start` surface crash loops instead of reporting a false "running". Pure and unit-tested.
- `process.ts` -- Process utilities: PID file reading, process liveness check (signal 0), and shell command execution via the user's login shell.
