# Daemon Source

The LobsterFarm daemon process. Manages entities, spawns Claude Code agent sessions, routes Discord messages, and exposes an HTTP API for the CLI and Commander to interact with. Runs as a macOS launchd service.

## Files

- `index.ts` -- Entrypoint. Wires up all subsystems (registry, sessions, queue, Discord, Commander, pool) and handles graceful shutdown.
- `config.ts` -- Loads and validates the global `~/.lobsterfarm/config.yaml` file.
- `registry.ts` -- `EntityRegistry` class. Scans `~/.lobsterfarm/entities/` on startup, validates each entity's `config.yaml`, and provides lookup by ID.
- `session.ts` -- `ClaudeSessionManager`. Spawns Claude Code as child processes with the correct agent, model, DNA, permissions, and entity context. Tracks active sessions, captures output, emits lifecycle events.
- `queue.ts` -- `TaskQueue`. Priority-ordered queue that feeds sessions to the session manager, respecting the configured concurrency limit. Processes next task when a slot opens.
- `server.ts` -- HTTP API server. Routes for status, entities, tasks, pool management, entity scaffolding, reload, webhook endpoints, and the per-PR review-lease API (`GET review-state`, `POST`/`DELETE review-lease`).
- `router.ts` -- Discord message router. Deterministic rules: channel-type routing (alerts, general), keyword-based intent classification. Legacy `!lf` prefix parsing retained for test coverage.
- `discord.ts` -- `DiscordBot` class. Connects to Discord via discord.js, builds a channel-to-entity index from entity configs, handles incoming messages via the router, sends messages as webhooks for agent identity, and scaffolds new entity Discord categories/channels.
- `commander-process.ts` -- `CommanderProcess`. Manages Pat (the Commander) as a persistent Claude Code session inside a tmux session with the Discord channel plugin. Health-checks every 10s (tmux death + MCP plugin-liveness deafness, issue #77), auto-restarts with exponential backoff, and resumes the persisted session on recovery.
- `pool.ts` -- `BotPool`. Manages a pool of Discord bot accounts (pool-0 through pool-N) for assigning to channels. Handles assignment, release, LRU eviction, parking (session preservation), nickname setting, pre-assignment of planners to entity #general channels, and the MCP plugin-liveness deafness probe (issue #73).
- `plugin-liveness.ts` -- Shared MCP plugin-liveness probe logic (issues #73, #77). `evaluate_plugin_liveness` is a pure verdict function comparing inbound/processing timestamps against tmux pane-idle state to detect a "deaf but alive" session; `is_tmux_session_idle` reads the pane. Consumed by both `pool.ts` and `commander-process.ts` (re-exported from `pool.ts` for existing importers).
- `actions.ts` -- Side-effect functions: git worktree create/cleanup, GitHub PR create/merge via `gh`, test runner, and Discord notification dispatch.
- `review-utils.ts` -- Utility functions for PR review feedback: fetch review comments from GitHub and build fix prompts for the auto-fix loop.
- `hooks.ts` -- Post-session hooks. Extracts session learnings via Haiku and appends them to daily logs. Also manages the global learnings file.
- `models.ts` -- Maps abstract model tiers (opus/sonnet/haiku + think level) to Claude CLI flags.
- `persistence.ts` -- JSON file persistence for PR review state and pool state. Saves to and loads from `~/.lobsterfarm/state/`.
- `pid.ts` -- PID file management. Write, read, remove, and check if the daemon is already running.
- `pr-cron.ts` -- `PRReviewCron`. Polls entity repos for open PRs, spawns headless reviewer sessions, and routes outcomes (approve/merge, fix, escalate). Acquires a `ReviewLeaseStore` lease (`daemon-cron`) before spawning so it never collides with the webhook or manual review paths.
- `webhook-handler.ts` -- GitHub webhook handler. Receives PR events, verifies signatures, maps repos to entities, and spawns reviewer/fixer sessions. Acquires a review lease (`daemon-webhook`) before spawning; releases it before any SHA-move requeue.
- `review-lease.ts` -- `ReviewLeaseStore`. In-memory per-PR review mutex (issue #60). A lease (key `owner/repo#num`) is acquired by one of three holders -- `daemon-cron`, `daemon-webhook`, `tidus-manual` -- before a reviewer spawns, so two reviewers never run on the same PR. Lazy TTL expiry (20 min default, tunable via `pr_cron.review_lease_ttl_ms`); no disk persistence, no background sweeper.

## Key Concepts

- **Session spawning**: The daemon never runs Claude Code interactively. It spawns headless sessions with `--output-format stream-json` and pipes the prompt via stdin.
- **Bot pool**: Discord bot accounts are a limited resource. The pool assigns them to channels on demand, evicts via LRU when full, and parks sessions for later resume.
- **Commander (Pat)**: The only agent that runs persistently. Lives in a tmux session, connected to Discord via the channel plugin, operating at the platform level rather than entity level.
- **PR review loop**: PRs are reviewed by spawning headless reviewer sessions. If changes are requested, a builder is spawned to fix. GitHub issues and PRs are the source of truth.
