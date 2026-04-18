# Per-Entity Claude Max Subscriptions

## What This Does

By default, all entities share a single Claude Max subscription via `~/.claude`. This creates two problems:

1. **Billing** -- no way to attribute costs to individual entities/products
2. **Rate limits** -- one busy entity can starve another

This feature adds an optional `subscription.claude_config_dir` field to entity config. When set, the daemon injects `CLAUDE_CONFIG_DIR=<path>` into every session spawned for that entity. Each config directory holds its own OAuth credentials, so sessions authenticate against separate Claude Max subscriptions.

## How CLAUDE_CONFIG_DIR Works

Claude Code uses `~/.claude` for all config, credentials, and state. The `CLAUDE_CONFIG_DIR` environment variable overrides this location entirely. When set, the CLI reads auth tokens, settings, and session state from the specified directory instead.

**What's isolated (per-entity config dir):**
- OAuth credentials (separate subscription identity)
- Session state files
- Any config that differs between subscriptions

**What's shared (via symlinks from `~/.claude`):**
- `CLAUDE.md` -- global instructions
- `rules/` -- global rules
- `settings.json` -- shared settings
- `agents/` -- agent definitions
- `skills/` -- skill definitions

## One-Time Setup for a New Subscription

### 1. Create the config directory

```bash
mkdir -p ~/.lobsterfarm/entities/<entity-id>/.claude-config
```

### 2. Authenticate the new subscription

```bash
CLAUDE_CONFIG_DIR=~/.lobsterfarm/entities/<entity-id>/.claude-config claude auth login
```

Follow the OAuth flow to authenticate with the Claude Max account you want this entity to use.

### 3. Symlink shared config files

```bash
cd ~/.lobsterfarm/entities/<entity-id>/.claude-config

# Shared instructions and rules
ln -s ~/.claude/CLAUDE.md CLAUDE.md
ln -s ~/.claude/rules rules
ln -s ~/.claude/settings.json settings.json
ln -s ~/.claude/settings.local.json settings.local.json
ln -s ~/.claude/agents agents
ln -s ~/.claude/skills skills
```

### 4. Add to entity config

Edit `~/.lobsterfarm/entities/<entity-id>/config.yaml`:

```yaml
entity:
  # ... existing fields ...
  subscription:
    claude_config_dir: ~/.lobsterfarm/entities/<entity-id>/.claude-config
```

### 5. Restart the daemon

```bash
kill $(cat ~/.lobsterfarm/lobsterfarm.pid)
# launchd auto-restarts the daemon
```

## How Injection Works

The daemon injects `CLAUDE_CONFIG_DIR` at two spawn points:

1. **Pool bots (tmux path)** -- `pool.ts` adds it to `extra_env` alongside `GH_TOKEN`. Injected as both a tmux command prefix and a spawn env var.

2. **Queue sessions (direct spawn)** -- `session.ts` resolves it from the entity registry and merges it into the spawn environment.

Both paths log which config dir is being used at spawn time. If no subscription is configured, sessions use the default `~/.claude` -- zero behavior change.

## Troubleshooting

### Verify which subscription a session is using

Check the daemon logs for spawn-time messages:

```
[pool] Assigning bot pool-3 to #general (entity: foo, claude_config: ~/.lobsterfarm/entities/foo/.claude-config)
[session] Spawning session for foo with CLAUDE_CONFIG_DIR=~/.lobsterfarm/entities/foo/.claude-config
```

If no custom config dir is set, you'll see:

```
[pool] Assigning bot pool-3 to #general (entity: foo, claude_config: default)
[session] Spawning session for foo with CLAUDE_CONFIG_DIR=default (~/.claude)
```

### Auth errors after setup

If the session fails with auth errors, verify the credentials are valid:

```bash
CLAUDE_CONFIG_DIR=~/.lobsterfarm/entities/<entity-id>/.claude-config claude auth status
```

If expired, re-authenticate:

```bash
CLAUDE_CONFIG_DIR=~/.lobsterfarm/entities/<entity-id>/.claude-config claude auth login
```

### Symlinked files not found

Ensure symlinks point to actual files. Test with:

```bash
ls -la ~/.lobsterfarm/entities/<entity-id>/.claude-config/
```

Broken symlinks show as red in most terminals. Re-create them if the source moved.

### Config dir doesn't exist

The daemon does not validate that the config directory exists at startup. If the path is wrong, the Claude CLI will fail at session start. Check the entity config path matches the actual directory.
