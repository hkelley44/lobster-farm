#!/usr/bin/env bash
#
# redeploy-daemon.sh — the single robust redeploy command (#106).
#
#   rebuild dist  →  launchctl kickstart -k  →  verify pid change + running:true
#
# Every step is launchd-native and runs in the FOREGROUND of the caller. The
# 2026-08-01 incident proved the detached alternatives silently fail on macOS:
#   - `setsid` does not exist on macOS — a script detaching with it dies on
#     launch while the operator believes the restart happened.
#   - `nohup ... &` inside a backgrounded shell gets reaped with its process
#     group before the restart fires.
# Neither is used here, and nothing below depends on the *daemon's* old process
# surviving — launchd owns the restart; we only build, kick, and verify.
#
# Verification is real, not assumed: PASS requires launchd to report a NEW pid
# for the service AND the daemon's /status endpoint to answer running:true from
# that new process (when the deployed build exposes `pid`, /status must agree
# with launchd). Anything else is a loud FAIL with diagnostics.
#
# Usage:
#   scripts/redeploy-daemon.sh            # build + restart + verify
#   scripts/redeploy-daemon.sh --no-build # restart + verify only
#
# Env overrides:
#   LF_DAEMON_PORT        daemon HTTP port      (default 7749)
#   LF_REDEPLOY_TIMEOUT   verify timeout, secs  (default 90)

set -euo pipefail

LABEL="com.lobsterfarm.daemon"
DOMAIN="gui/$(id -u)"
PORT="${LF_DAEMON_PORT:-7749}"
STATUS_URL="http://127.0.0.1:${PORT}/status"
TIMEOUT_S="${LF_REDEPLOY_TIMEOUT:-90}"
DAEMON_LOG="${HOME}/.lobsterfarm/logs/daemon.log"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log()  { printf '[redeploy] %s\n' "$*"; }
pass() { printf '[redeploy] PASS: %s\n' "$*"; exit 0; }
fail() {
  printf '[redeploy] FAIL: %s\n' "$*" >&2
  if [[ -f "$DAEMON_LOG" ]]; then
    printf '[redeploy] last daemon log lines:\n' >&2
    tail -n 15 "$DAEMON_LOG" >&2 || true
  fi
  exit 1
}

# pid launchd currently tracks for the service ("" when not running). The
# start wrapper `exec`s node, so this IS the daemon process pid.
launchd_pid() {
  launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'
}

# Extract a top-level JSON field from a /status body via python3 (always
# present on macOS; no jq dependency). Prints "" when absent/unparseable.
status_field() { # $1 = json body, $2 = field
  printf '%s' "$1" | /usr/bin/python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    v = d.get(sys.argv[1], "")
    print("" if v is None else (str(v).lower() if isinstance(v, bool) else v))
except Exception:
    print("")
' "$2" 2>/dev/null
}

# ── 1. Build ──────────────────────────────────────────────────────────────────
if [[ "${1:-}" != "--no-build" ]]; then
  log "building dist (pnpm -r run build in ${REPO_ROOT}) ..."
  if ! (cd "$REPO_ROOT" && pnpm -r run build); then
    fail "build failed — daemon was NOT restarted (old process still serving)"
  fi
  log "build OK"
else
  log "skipping build (--no-build)"
fi

# ── 2. Snapshot the old pid ───────────────────────────────────────────────────
OLD_PID="$(launchd_pid || true)"
log "current daemon pid: ${OLD_PID:-<not running>}"

# ── 3. Restart via launchd ────────────────────────────────────────────────────
# kickstart -k kills the running instance and starts a fresh one under launchd
# supervision — the only restart mechanism that reliably fired during the
# 08-01 deploy. Synchronous; no detachment tricks.
log "launchctl kickstart -k ${DOMAIN}/${LABEL}"
if ! launchctl kickstart -k "${DOMAIN}/${LABEL}"; then
  fail "launchctl kickstart failed — is the service bootstrapped? (launchctl print ${DOMAIN}/${LABEL})"
fi

# ── 4. Verify: genuine pid change + running:true ──────────────────────────────
log "verifying: waiting up to ${TIMEOUT_S}s for a new pid + running:true at ${STATUS_URL}"
deadline=$(( $(date +%s) + TIMEOUT_S ))
new_pid=""
while (( $(date +%s) < deadline )); do
  new_pid="$(launchd_pid || true)"

  # Not up yet, or launchd briefly re-reports the dying pid — keep polling.
  if [[ -z "$new_pid" || "$new_pid" == "${OLD_PID:-__none__}" ]]; then
    sleep 2
    continue
  fi

  body="$(curl -fsS --max-time 3 "$STATUS_URL" 2>/dev/null || true)"
  if [[ -z "$body" ]]; then
    sleep 2
    continue
  fi

  running="$(status_field "$body" running)"
  status_pid="$(status_field "$body" pid)"

  if [[ "$running" == "true" ]]; then
    # Builds since #106 report their own pid — require agreement with launchd
    # so a stale pre-restart process answering the port can't fake a PASS.
    if [[ -n "$status_pid" && "$status_pid" != "$new_pid" ]]; then
      log "pid mismatch (launchd: ${new_pid}, /status: ${status_pid}) — still settling, retrying"
      sleep 2
      continue
    fi
    uptime="$(status_field "$body" uptime_seconds)"
    pass "daemon restarted (pid ${OLD_PID:-<none>} → ${new_pid}, running:true, uptime ${uptime:-?}s)"
  fi
  sleep 2
done

fail "daemon did not come back healthy within ${TIMEOUT_S}s (old pid: ${OLD_PID:-<none>}, last seen pid: ${new_pid:-<none>})"
