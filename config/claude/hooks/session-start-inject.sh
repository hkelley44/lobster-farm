#!/usr/bin/env bash
#
# SessionStart hook — inject a pending Discord message as initial context.
#
# The LobsterFarm daemon writes a pending-message JSON file to disk before
# spawning `claude`, and passes its path via the LF_PENDING_FILE env var.
# This hook reads that file during Claude's SessionStart event (fires on
# both fresh sessions and --resume), emits the message as additionalContext
# via hookSpecificOutput, and unlinks the file.
#
# Replaces the old tmux send-keys "bridge" approach which raced against the
# MCP plugin's subscription readiness. Hooks fire deterministically during
# Claude init, eliminating the race entirely.
#
# Contract:
#   - Read LF_PENDING_FILE (path to JSON file). No-op if unset or missing.
#   - File format: {"user": "...", "channel_id": "...", "message_id": "...",
#                   "content": "...", "ts": "..."}
#   - Emit {"hookSpecificOutput": {"hookEventName": "SessionStart",
#           "additionalContext": "<formatted message>"}} on stdout.
#   - Unlink the file after successful read.
#   - Exit 0 always — never block session start.
#
# Requires: jq (present in every lobster-farm environment).

set -u

PENDING_FILE="${LF_PENDING_FILE:-}"

# No pending file configured — quietly no-op.
if [ -z "$PENDING_FILE" ]; then
  exit 0
fi

# File missing — quietly no-op. Could be stale env var on --resume when the
# daemon didn't write a fresh pending file, or a race where another hook
# invocation already consumed it.
if [ ! -f "$PENDING_FILE" ]; then
  exit 0
fi

# Read the file. If read fails (permissions, disk error), no-op silently
# rather than blocking session start.
RAW="$(cat "$PENDING_FILE" 2>/dev/null)" || exit 0
if [ -z "$RAW" ]; then
  rm -f "$PENDING_FILE" 2>/dev/null || true
  exit 0
fi

# Parse fields via jq. On parse failure, no-op but still try to unlink so
# we don't get stuck on a malformed file.
USER_NAME="$(printf '%s' "$RAW" | jq -r '.user // "a user"' 2>/dev/null)" || USER_NAME="a user"
CONTENT="$(printf '%s' "$RAW" | jq -r '.content // ""' 2>/dev/null)" || CONTENT=""
CHANNEL_ID="$(printf '%s' "$RAW" | jq -r '.channel_id // ""' 2>/dev/null)" || CHANNEL_ID=""
TS="$(printf '%s' "$RAW" | jq -r '.ts // ""' 2>/dev/null)" || TS=""

if [ -z "$CONTENT" ]; then
  rm -f "$PENDING_FILE" 2>/dev/null || true
  exit 0
fi

# Build the additional-context string. jq's -Rs read + tojson escapes the
# full multi-line content safely for JSON embedding.
CTX_HEADER="A user just messaged you in Discord. Respond to them via the Discord reply tool (the channel plugin is already loaded)."
if [ -n "$CHANNEL_ID" ]; then
  CTX_HEADER="$CTX_HEADER Channel: $CHANNEL_ID."
fi
if [ -n "$TS" ]; then
  CTX_HEADER="$CTX_HEADER Sent at: $TS."
fi

ADDITIONAL_CONTEXT="$(printf '%s\n\nFrom %s:\n%s\n' "$CTX_HEADER" "$USER_NAME" "$CONTENT")"

# Emit the hook output JSON. jq --arg safely escapes the context string.
jq -cn \
  --arg ctx "$ADDITIONAL_CONTEXT" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'

# Unlink after successful emit so a later --resume doesn't re-inject stale
# content. Best-effort — a failure here just means drain_pending_files or
# the next run will clean it up.
rm -f "$PENDING_FILE" 2>/dev/null || true

exit 0
