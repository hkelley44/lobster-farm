#!/usr/bin/env bash
# scan-bash-secrets.sh — PreToolUse hook for Claude Code Bash tool calls.
#
# Reads hook event JSON from stdin, extracts the command, and pattern-matches
# for leaked secrets. Blocks execution (exit 2 + stderr) if a secret is found.
# Fails open (exit 0) if jq is missing or input is malformed — a broken hook
# must never block all Bash commands.
#
# Install: cp config/hooks/scan-bash-secrets.sh ~/.claude/hooks/
# Register in ~/.claude/settings.json under hooks.PreToolUse with matcher "Bash"

set -euo pipefail

# --- Dependency check ---
if ! command -v jq &>/dev/null; then
  echo "WARNING: jq not found — secret scanning disabled" >&2
  exit 0
fi

# --- Read and parse stdin ---
INPUT="$(cat)" || exit 0
if [ -z "$INPUT" ]; then
  exit 0
fi

COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
if [ -z "$COMMAND" ]; then
  exit 0
fi

# --- Allowlist: known-safe commands exit immediately ---
# op run is the safe path for secret injection.
# op item / op vault are 1Password CLI management (metadata, not secrets).
# Only check the first line — a multi-line command with op run on a later line
# could still have secrets on earlier lines.
FIRST_LINE="$(echo "$COMMAND" | head -1)"
if echo "$FIRST_LINE" | grep -qE '^\s*op (run|item|vault) '; then
  exit 0
fi

# --- Pattern checks ---
# Each pattern has a specific block message with actionable guidance.

# 1. Discord bot tokens: base64-encoded user ID . timestamp . HMAC
#    Format: <24+ chars>.<6+ chars>.<27+ chars> (all base64url alphabet)
if echo "$COMMAND" | grep -qE '[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}'; then
  cat >&2 <<'MSG'
BLOCK: Command contains what appears to be a Discord bot token.
→ Use 'op run --env-file .env.op -- <command>' to inject secrets as environment variables.
→ See the secrets-guideline skill for details.
MSG
  exit 2
fi

# 2. Known API key prefixes
#    Each prefix has a minimum length to avoid false positives on short strings
#    like `grep -r "sk-"` or variable names.
if echo "$COMMAND" | grep -qE '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[bpras]-[a-zA-Z0-9-]{10,}|whsec_[a-zA-Z0-9]{20,})'; then
  cat >&2 <<'MSG'
BLOCK: Command contains a hardcoded API key.
→ Store the key in 1Password and use 'op run --env-file .env.op -- <command>' instead.
MSG
  exit 2
fi

# 3. Hardcoded Authorization Bearer headers
#    Matches literal tokens (starts with alphanumeric, 10+ chars).
#    Does NOT match $ENV_VAR or ${ENV_VAR} references.
if echo "$COMMAND" | grep -qE 'Authorization:.*Bearer [a-zA-Z0-9][a-zA-Z0-9_./-]{10,}'; then
  # But allow env var references — if the Bearer value starts with $, it's safe
  if ! echo "$COMMAND" | grep -qE 'Authorization:.*Bearer \$'; then
    cat >&2 <<'MSG'
BLOCK: Command contains a hardcoded Authorization header value.
→ Use 'op run --env-file .env.op -- curl -H "Authorization: Bearer $ENV_VAR" ...' instead.
MSG
    exit 2
  fi
fi

# 4. op read in command substitution — outputs secrets to stdout where they
#    get captured in session JSONL files. The safe path is op run --env-file.
if echo "$COMMAND" | grep -qE '(\$\(op read |`op read )'; then
  cat >&2 <<'MSG'
BLOCK: Command uses 'op read' in a command substitution which expands the secret into stdout where it gets logged.
→ Use 'op run --env-file .env.op -- <command>' instead — secrets stay in env vars, never visible.
MSG
  exit 2
fi

# 5. Private key material
if echo "$COMMAND" | grep -qE '\-\-\-\-\-BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY\-\-\-\-\-'; then
  cat >&2 <<'MSG'
BLOCK: Command contains private key material.
→ Private keys should never appear in commands. Store in 1Password and reference via op run.
MSG
  exit 2
fi

# --- All checks passed ---
exit 0
