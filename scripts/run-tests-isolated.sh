#!/usr/bin/env bash
#
# run-tests-isolated.sh — run an arbitrary command inside its own macOS
# resource coalition by bootstrapping it as a one-shot launchd service.
#
# WHY THIS EXISTS
# ---------------
# On macOS (Darwin), every process belongs to a "resource coalition" — a Mach
# kernel concept that aggregates resource accounting (notably the dirty-write
# I/O budget, ~2 GiB per 24 h) across a process tree. Coalition membership is
# fixed at posix_spawn() time and is *inherited* from the spawning process.
# POSIX-level tools (setsid, nohup, sandbox-exec, sudo, launchctl asuser) do
# NOT change coalition membership — confirmed empirically in PRs #34 and #35.
#
# The LobsterFarm daemon runs in coalition `com.lobsterfarm.daemon` (id 1153
# on the current host). Every agent session, and every process those sessions
# spawn (including parallel vitest workers), inherits coalition 1153 and bills
# its disk writes against the same shared 2 GiB / 24 h budget. When the budget
# is exhausted, the kernel sends SIGKILL to the heaviest writer — usually a
# vitest worker. The agent loses scrollback and any unpushed work.
#
# The only userspace mechanism that creates a fresh coalition on a SIP-enabled
# host is `launchctl bootstrap`: launchd itself holds the private entitlement
# `com.apple.private.coalition-policy` and can call coalition_create() on our
# behalf. A process started this way runs in a brand-new coalition named after
# the plist's Label, with its own fresh 2 GiB / 24 h write budget. Children
# spawned by that process inherit the new coalition, not 1153.
#
# This script wraps an arbitrary command in a one-shot LaunchAgent so the
# command (and all of its descendants — pnpm, node, vitest workers, …) runs
# in a coalition isolated from the daemon. See investigation report at
# docs/investigation-35-coalition-isolation-notes.md on branch
# `investigation/35-coalition-isolation`, and issues #28, #35, #36.
#
# USAGE
# -----
#   scripts/run-tests-isolated.sh <command> [args...]
#
# Examples:
#   scripts/run-tests-isolated.sh pnpm -r test
#   scripts/run-tests-isolated.sh pnpm --filter @lobster-farm/daemon test
#   scripts/run-tests-isolated.sh bash -c 'echo hi && ls'
#
# VERIFICATION
# ------------
# While the wrapped command runs, in another shell:
#   pgrep -f vitest                    # find a worker pid
#   launchctl print pid/<pid> | grep -i coalition
# The `name = ...` line should show `com.lobsterfarm.test.<timestamp>`,
# never `com.lobsterfarm.daemon` (id 1153).
#
# SECURITY NOTE — environment forwarding
# --------------------------------------
# The plist file at /tmp/<label>.plist is world-readable by default. We
# therefore forward an explicit allowlist of non-sensitive environment
# variables only (PATH, HOME, PNPM_HOME, NODE_ENV, LANG, LC_*, TERM, TMPDIR,
# CI). Secrets — including OP_SERVICE_ACCOUNT_TOKEN, OP_SESSION_*, and any
# other token-shaped vars — are deliberately NOT forwarded. If a test
# command needs 1Password-injected secrets, run `op run --env-file <file>
# -- scripts/run-tests-isolated.sh <cmd>` and have the inner command itself
# call `op run` again — the secrets will be injected into the launchd
# child's process env at exec time without ever touching disk in the plist.
# (The `op` binary's session credentials live in the user keychain and are
# accessed by the cli inside the bootstrapped service; they don't need to
# travel through env vars.)

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  echo "usage: $(basename "$0") <command> [args...]" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Label & file paths
# ---------------------------------------------------------------------------
# Nanosecond timestamp keeps labels unique across concurrent agent sessions.
# `gdate` (GNU coreutils) is preferred when available because BSD `date` on
# macOS does not support %N. Fall back to PID-suffixed seconds otherwise.
if command -v gdate >/dev/null 2>&1; then
  TIMESTAMP="$(gdate +%s%N)"
else
  TIMESTAMP="$(date +%s)$$"
fi

LABEL="com.lobsterfarm.test.${TIMESTAMP}"
PLIST="/tmp/${LABEL}.plist"
STDOUT_FILE="/tmp/${LABEL}.out"
STDERR_FILE="/tmp/${LABEL}.err"
EXITCODE_FILE="/tmp/${LABEL}.exitcode"
DOMAIN_TARGET="gui/${UID}/${LABEL}"
DOMAIN="gui/${UID}"

# ---------------------------------------------------------------------------
# Cleanup trap — runs on normal exit, error, SIGINT, SIGTERM.
# Idempotent so it's safe to invoke twice (EXIT will fire after INT/TERM).
# ---------------------------------------------------------------------------
CLEANED_UP=0
TAIL_OUT_PID=""
TAIL_ERR_PID=""

cleanup() {
  if [[ "${CLEANED_UP}" -eq 1 ]]; then
    return
  fi
  CLEANED_UP=1

  # Stop streaming tails first so they don't keep printing during/after bootout.
  if [[ -n "${TAIL_OUT_PID}" ]] && kill -0 "${TAIL_OUT_PID}" 2>/dev/null; then
    kill "${TAIL_OUT_PID}" 2>/dev/null || true
    wait "${TAIL_OUT_PID}" 2>/dev/null || true
  fi
  if [[ -n "${TAIL_ERR_PID}" ]] && kill -0 "${TAIL_ERR_PID}" 2>/dev/null; then
    kill "${TAIL_ERR_PID}" 2>/dev/null || true
    wait "${TAIL_ERR_PID}" 2>/dev/null || true
  fi

  # Tear down the launchd service. `bootout` is the inverse of `bootstrap`;
  # it stops the service and removes it from the user domain. If the service
  # already exited cleanly, bootout still works (it removes the dormant
  # entry); we suppress its output either way.
  launchctl bootout "${DOMAIN_TARGET}" >/dev/null 2>&1 || true

  # Remove temp artefacts. We keep them only on debug demand.
  rm -f -- "${PLIST}" "${STDOUT_FILE}" "${STDERR_FILE}" "${EXITCODE_FILE}"
}

# Cleanup must fire on every exit path. On INT/TERM we exit with 128+sig
# so the calling shell sees a sensible non-zero status; cleanup() is
# idempotent and the EXIT trap will be a no-op the second time.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# ---------------------------------------------------------------------------
# Build the wrapped command.
#
# We invoke the user's command via `/bin/bash -c '<cmd>; echo $? > <sentinel>'`
# so that:
#   - the exit code lands in a sentinel file (Option 1 from the spec)
#   - we don't have to parse `launchctl print` output
#   - the bash wrapper writes the sentinel atomically AFTER the command exits
#
# Each user-supplied argument is single-quote-escaped before being joined
# into the bash command string. The escape rule for single-quoted shell:
# replace every `'` with `'\''`.
# ---------------------------------------------------------------------------
shell_escape() {
  local arg="$1"
  # Use a local variable for the single quote so bash's parameter-expansion
  # parser doesn't get tangled trying to balance literal `'` characters in
  # the replacement pattern. The substitution rule is: every `'` becomes
  # `'\''` (close-quote, escaped-quote, open-quote).
  local -r SQ="'"
  printf "'%s'" "${arg//$SQ/$SQ\\$SQ$SQ}"
}

USER_CMD=""
for arg in "$@"; do
  if [[ -n "${USER_CMD}" ]]; then
    USER_CMD+=" "
  fi
  USER_CMD+="$(shell_escape "${arg}")"
done

# The bash wrapper. Note: ${EXITCODE_FILE} is interpolated NOW (the path the
# launchd child should write to); $? is escaped so it's evaluated by the
# child's bash at runtime.
WRAPPED_CMD="${USER_CMD}; echo \$? > $(shell_escape "${EXITCODE_FILE}")"

# ---------------------------------------------------------------------------
# Build EnvironmentVariables block — explicit allowlist only.
# See SECURITY NOTE at top of file. Never add OP_*, AWS_*, GH_TOKEN, etc.
# ---------------------------------------------------------------------------
ENV_ALLOWLIST=(
  PATH
  HOME
  PNPM_HOME
  NODE_ENV
  LANG
  LC_ALL
  LC_CTYPE
  TERM
  TMPDIR
  CI
)

# XML-escape a string for safe inclusion in a plist <string> value.
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  s="${s//\'/&apos;}"
  printf '%s' "${s}"
}

ENV_XML=""
for var in "${ENV_ALLOWLIST[@]}"; do
  if [[ -n "${!var:-}" ]]; then
    ENV_XML+="        <key>$(xml_escape "${var}")</key>
        <string>$(xml_escape "${!var}")</string>
"
  fi
done

# ---------------------------------------------------------------------------
# Working directory — capture at script invocation time.
# ---------------------------------------------------------------------------
WORKDIR="${PWD}"

# ---------------------------------------------------------------------------
# Write the plist.
# ---------------------------------------------------------------------------
cat >"${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$(xml_escape "${LABEL}")</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>$(xml_escape "${WRAPPED_CMD}")</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "${WORKDIR}")</string>
    <key>StandardOutPath</key>
    <string>$(xml_escape "${STDOUT_FILE}")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "${STDERR_FILE}")</string>
    <key>RunAtLoad</key>
    <true/>
    <key>AbandonProcessGroup</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
${ENV_XML}    </dict>
</dict>
</plist>
PLIST_EOF

# Lock down /tmp artefacts to 0600 — they live in a world-readable directory
# and the plist exposes the full command line, working directory, and any
# allowlisted env var values. Even on a single-user box this is basic hygiene.
chmod 0600 "${PLIST}"

# Sanity-check the plist; if it's malformed launchctl will fail with a
# cryptic message, so we surface the parser error early.
if ! plutil -lint "${PLIST}" >/dev/null; then
  echo "run-tests-isolated: generated plist failed plutil -lint" >&2
  plutil -lint "${PLIST}" >&2 || true
  exit 1
fi

# Pre-create the out/err files so `tail -f` has something to attach to
# without racing the service's first write. chmod immediately so launchd's
# subsequent appends inherit the restrictive mode.
: >"${STDOUT_FILE}"
chmod 0600 "${STDOUT_FILE}"
: >"${STDERR_FILE}"
chmod 0600 "${STDERR_FILE}"
# Pre-create the exit-code file too; the inner bash will overwrite it via
# `echo $? > …` but starting with 0600 means there's no brief 0644 window.
: >"${EXITCODE_FILE}"
chmod 0600 "${EXITCODE_FILE}"

# ---------------------------------------------------------------------------
# Bootstrap into the user's launchd domain. This is the load-bearing step:
# the new process gets a fresh resource coalition named after LABEL.
# ---------------------------------------------------------------------------
if ! launchctl bootstrap "${DOMAIN}" "${PLIST}"; then
  echo "run-tests-isolated: launchctl bootstrap ${DOMAIN} ${PLIST} failed" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Stream stdout/stderr to the calling terminal in real time.
# `tail -F` follows by name and is robust to file replacement; `-n +1`
# starts from the beginning so we don't miss early output.
# ---------------------------------------------------------------------------
tail -n +1 -F "${STDOUT_FILE}" 2>/dev/null &
TAIL_OUT_PID=$!
tail -n +1 -F "${STDERR_FILE}" >&2 2>/dev/null &
TAIL_ERR_PID=$!

# ---------------------------------------------------------------------------
# Wait for the sentinel exit-code file. Poll at 200 ms; that's frequent
# enough to feel instant on completion and cheap enough to be invisible.
# ---------------------------------------------------------------------------
while [[ ! -s "${EXITCODE_FILE}" ]]; do
  sleep 0.2
done

# Give tail one more tick to drain final buffered writes before we kill it.
sleep 0.3

EXIT_CODE="$(tr -d '[:space:]' <"${EXITCODE_FILE}")"
if [[ -z "${EXIT_CODE}" ]] || ! [[ "${EXIT_CODE}" =~ ^[0-9]+$ ]]; then
  echo "run-tests-isolated: malformed exit code in ${EXITCODE_FILE}: '${EXIT_CODE}'" >&2
  EXIT_CODE=1
fi

# cleanup() runs via EXIT trap.
exit "${EXIT_CODE}"
