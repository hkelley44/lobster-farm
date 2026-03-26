# PreToolUse Hooks

Claude Code hook scripts that run before tool invocations. Registered in `~/.claude/settings.json` under `hooks.PreToolUse` with a tool name matcher. Exit code 0 allows the tool call, exit code 2 blocks it with an error message on stderr.

## Files

- `scan-bash-secrets.sh` -- Scans Bash tool commands for leaked secrets before execution. Pattern-matches for Discord bot tokens, known API key prefixes (sk-, ghp_, AKIA, xox, etc.), hardcoded Authorization headers, `op read` in command substitutions, and private key material. Allowlists `op run` and `op item/vault` commands. Fails open if jq is missing or input is malformed.

### tests/

- `test-scan-bash-secrets.sh` -- Test suite for the secret scanner. Exercises each pattern category with both positive (should block) and negative (should allow) cases.
