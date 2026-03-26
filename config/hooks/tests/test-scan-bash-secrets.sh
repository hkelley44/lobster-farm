#!/usr/bin/env bash
# test-scan-bash-secrets.sh — Tests for the Bash secret scanning PreToolUse hook.
#
# Usage: bash config/hooks/tests/test-scan-bash-secrets.sh
#
# Each test feeds a JSON hook event to the scanner via stdin and checks
# the exit code. Exit 0 = allowed, exit 2 = blocked.

set -uo pipefail

# Resolve script location so tests work from any cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../scan-bash-secrets.sh"

PASS=0
FAIL=0
TOTAL=0

# --- Helpers ---

# Build a JSON hook event from a command string.
# Uses jq to properly escape the command for JSON.
make_event() {
  local cmd="$1"
  jq -n --arg cmd "$cmd" '{
    tool_name: "Bash",
    tool_input: { command: $cmd, description: "test", timeout: 120000 },
    session_id: "test-session",
    cwd: "/tmp",
    hook_event_name: "PreToolUse"
  }'
}

# Run the hook with a given command and check the exit code.
# $1 = test name
# $2 = command string
# $3 = expected exit code (0 or 2)
run_test() {
  local name="$1"
  local cmd="$2"
  local expected="$3"
  TOTAL=$((TOTAL + 1))

  local stderr_output
  stderr_output="$(make_event "$cmd" | bash "$HOOK" 2>&1 >/dev/null)"
  local actual=$?

  if [ "$actual" -eq "$expected" ]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name (expected exit $expected, got exit $actual)"
    if [ -n "$stderr_output" ]; then
      echo "        stderr: $(echo "$stderr_output" | head -1)"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# --- Must block (exit 2) ---

echo ""
echo "=== MUST BLOCK (exit 2) ==="
echo ""

run_test "Discord bot token" \
  "curl -H \"Authorization: Bot MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs\" https://discord.com/api/v10/gateway" \
  2

run_test "OpenAI API key" \
  "curl -H \"Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456\" https://api.openai.com/v1/chat/completions" \
  2

run_test "GitHub PAT" \
  "git clone https://ghp_abcdefghijklmnopqrstuvwxyz1234567890@github.com/user/repo" \
  2

run_test "GitHub OAuth token" \
  "curl -H \"Authorization: token gho_abcdefghijklmnopqrstuvwxyz1234567890\" https://api.github.com/user" \
  2

run_test "GitHub fine-grained PAT" \
  "curl -H \"Authorization: token github_pat_abcdefghijklmnopqrstuvwxyz12345\" https://api.github.com/user" \
  2

run_test "AWS access key" \
  "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE" \
  2

run_test "Slack bot token" \
  "curl -H \"Authorization: Bearer xoxb-fake-test-token-not-real\" https://slack.com/api/chat.postMessage" \
  2

run_test "Webhook secret" \
  "curl -d '{\"secret\": \"whsec_abcdefghijklmnopqrstuvwxyz\"}' https://api.example.com/webhook" \
  2

run_test "Hardcoded Bearer token (JWT)" \
  "curl -H \"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoiZm9vIn0.hSwVxOGDa_THuhnV_yfwZIMC3c6_0AiJG\" https://api.example.com" \
  2

run_test "op read in \$()" \
  'TOKEN=$(op read "op://vault/item/field") && curl -H "Authorization: Bearer $TOKEN" https://api.example.com' \
  2

run_test "op read in backticks" \
  'curl -H "Authorization: Bearer `op read "op://vault/item/field"`" https://api.example.com' \
  2

run_test "Private RSA key" \
  'echo "-----BEGIN RSA PRIVATE KEY-----" > /tmp/key.pem' \
  2

run_test "Private EC key" \
  'echo "-----BEGIN EC PRIVATE KEY-----" > /tmp/key.pem' \
  2

run_test "Private key (generic)" \
  'echo "-----BEGIN PRIVATE KEY-----" > /tmp/key.pem' \
  2

run_test "Private OPENSSH key" \
  'echo "-----BEGIN OPENSSH PRIVATE KEY-----" > /tmp/key.pem' \
  2

# --- Must allow (exit 0) ---

echo ""
echo "=== MUST ALLOW (exit 0) ==="
echo ""

run_test "op run (safe path)" \
  "op run --env-file .env.op -- curl https://api.example.com" \
  0

run_test "Env var in Bearer header" \
  'curl -H "Authorization: Bearer $API_KEY" https://api.example.com' \
  0

run_test "Env var (braces) in Bearer header" \
  'curl -H "Authorization: Bearer ${API_KEY}" https://api.example.com' \
  0

run_test "Simple git command" \
  "git status" \
  0

run_test "Complex find command (no secrets)" \
  'find . -name "*.ts" -exec grep -l "import" {} \;' \
  0

run_test "npm install" \
  "npm install --save express" \
  0

run_test "op vault list" \
  "op vault list" \
  0

run_test "op item list" \
  "op item list --vault dev" \
  0

run_test "grep for sk- pattern (short, no real key)" \
  'grep -r "sk-" src/' \
  0

run_test "grep for token pattern in code" \
  'grep -rn "ghp_" src/' \
  0

run_test "Short sk- string in echo" \
  'echo "prefix sk-short"' \
  0

# --- Edge cases ---

echo ""
echo "=== EDGE CASES ==="
echo ""

# Empty command
TOTAL=$((TOTAL + 1))
EMPTY_EVENT='{"tool_name":"Bash","tool_input":{"command":""},"session_id":"test","cwd":"/tmp","hook_event_name":"PreToolUse"}'
echo "$EMPTY_EVENT" | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Empty command"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Empty command (expected exit 0)"
  FAIL=$((FAIL + 1))
fi

# Malformed JSON
TOTAL=$((TOTAL + 1))
echo "not json at all" | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Malformed JSON (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Malformed JSON (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Empty stdin
TOTAL=$((TOTAL + 1))
echo "" | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Empty stdin (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Empty stdin (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Missing tool_input.command field
TOTAL=$((TOTAL + 1))
echo '{"tool_name":"Bash","tool_input":{}}' | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Missing command field (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Missing command field (expected exit 0)"
  FAIL=$((FAIL + 1))
fi

# Multi-line command with secret on second line
run_test "Multi-line command with secret" \
  "$(printf 'cd /tmp\ncurl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456" https://api.openai.com')" \
  2

# Multi-line command without secret
run_test "Multi-line command without secret" \
  "$(printf 'cd /tmp\nls -la\ngit status')" \
  0

# op run should not trigger secret checks even with suspicious content after it
run_test "op run with Bearer in args" \
  'op run --env-file .env.op -- curl -H "Authorization: Bearer $TOKEN" https://api.example.com' \
  0

# Multi-line: op run on second line should NOT bypass scanning of first line
run_test "Multi-line: secret before op run" \
  "$(printf 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456" https://api.openai.com\nop run --env-file .env.op -- echo done')" \
  2

# --- DSA key type ---
run_test "Private DSA key" \
  'echo "-----BEGIN DSA PRIVATE KEY-----" > /tmp/key.pem' \
  2

# --- Summary ---

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
