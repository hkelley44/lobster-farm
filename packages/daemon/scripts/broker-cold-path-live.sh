#!/usr/bin/env bash
# broker-cold-path-live.sh — the LIVE half of #84 §4 G0.2.
#
# Runs the four cold-path validations against the real daemon in
# #broker-room-test. It restarts the daemon and asks YOU to post; it never
# posts to Discord itself (#84 §10: no step may be self-certified by an agent —
# a human round-trip is the point, not an inconvenience).
#
# Companion to the offline half:
#   packages/daemon/src/__tests__/broker-cold-path-harness.test.ts   (daemon side)
#   packages/daemon/scripts/broker-cli-testbed.mjs                   (CLI/shim leg)
# Those two prove queue accounting, ordering, and CLI routing. This script
# proves the parts that need a restart and a human: pool cold assign, one
# session not two, a reply actually arriving, and session persistence.
#
# USAGE
#   ./broker-cold-path-live.sh preflight   # no restart; run this first
#   ./broker-cold-path-live.sh v1          # restart → post → cold assign → reply
#   ./broker-cold-path-live.sh v2          # kill mid-idle → dark → post → recreate
#   ./broker-cold-path-live.sh v3          # restart with an unacked message
#   ./broker-cold-path-live.sh v4          # rapid double-post during cold start
#   ./broker-cold-path-live.sh watch-queue # queue sampler (used by v3)
#
# Each validation prints PASS/FAIL per objective check and exits non-zero if any
# check failed. Run them in order; v1 is the cheapest and most diagnostic.

set -uo pipefail

LF_DIR="${LF_DIR:-$HOME/.lobsterfarm}"
LOG="$LF_DIR/logs/daemon.log"
QUEUE="$LF_DIR/state/broker-queue.json"
CONFIG="$LF_DIR/config.yaml"
DAEMON_PORT="${DAEMON_PORT:-7749}"
CHANNEL=""   # resolved from config.yaml — never hardcoded
ROOM_NAME="#broker-room-test"
SAMPLE_DIR="${TMPDIR:-/tmp}/lf-coldpath-samples"

pass_count=0; fail_count=0

c_g() { printf '\033[32m%s\033[0m' "$1"; }
c_r() { printf '\033[31m%s\033[0m' "$1"; }
c_y() { printf '\033[33m%s\033[0m' "$1"; }

hdr()  { echo; echo "──── $* ────"; }
note() { echo "  · $*"; }

# chk <name> <expected> <actual>
chk() {
  local name="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    echo "  $(c_g PASS)  $name"
    pass_count=$((pass_count+1))
  else
    echo "  $(c_r FAIL)  $name"
    echo "          expected: $want"
    echo "          actual:   $got"
    fail_count=$((fail_count+1))
  fi
}

# chk_true <name> <0-or-1>
chk_true() { chk "$1" "1" "$2"; }

ask() {
  echo
  echo "  $(c_y 'ACTION REQUIRED')  $1"
  read -r -p "  press ENTER when done… " _
}

resolve_channel() {
  # The pilot channel list is the only source of truth; a hardcoded id here
  # would silently validate the wrong room.
  # Take ONLY the quoted snowflake. Stripping all non-digits would also pull
  # digits out of the trailing `# …Phase 2 pilot — attempt 2` comment and
  # silently build a channel id that matches nothing.
  CHANNEL="$(awk '
    /^ *pilot_channels:/ { f=1; next }
    f && /^ *- *"[0-9]+"/ { match($0, /"[0-9]+"/); print substr($0, RSTART+1, RLENGTH-2); exit }
    f && !/^ *- / { exit }' "$CONFIG")"
  if [[ -z "$CHANNEL" ]]; then
    echo "$(c_r 'ABORT')  could not read discord.broker.pilot_channels from $CONFIG" >&2
    exit 2
  fi
}

log_lines() { wc -l < "$LOG" | tr -d ' '; }

# since <line-number> — everything appended to the log after that line
since() { tail -n "+$(( $1 + 1 ))" "$LOG"; }

# count_since <line> <grep-pattern>
count_since() { since "$1" | grep -cE "$2"; }

queue_depth() {
  [[ -f "$QUEUE" ]] || { echo 0; return; }
  jq '[.entries[] | select(.status != "dead")] | length' "$QUEUE" 2>/dev/null || echo "?"
}

# The pane's process tree is the only proof the shim — and not the official
# plugin — is the live transport for a channel (#84 §4 Q-e).
transport_for_pane() {
  local pane_pid="$1"
  local tree
  tree="$(pstree -p "$pane_pid" 2>/dev/null || ps -ax -o pid=,ppid=,command=)"
  local shim plugin
  shim=$(ps -ax -o command= | grep -cE "node .*dist/shim/discord-shim\.js")
  plugin=$(ps -ax -o command= | grep -cE "bun .*discord/0\.0\.4")
  echo "shim=$shim plugin=$plugin"
}

shim_procs()   { ps -ax -o command= | grep -cE "node .*dist/shim/discord-shim\.js"; }
plugin_procs() { ps -ax -o command= | grep -cE "bun .*discord/0\.0\.4"; }

restart_daemon() {
  hdr "restarting the daemon"
  note "this is YOUR restart — the script runs it, nothing else does"
  local before; before=$(log_lines)
  lf restart >/dev/null 2>&1 || launchctl kickstart -k "gui/$(id -u)/com.lobsterfarm.daemon"
  # Wait for the broker to announce itself rather than sleeping a guess.
  local waited=0
  while (( waited < 60 )); do
    if since "$before" | grep -qF "[broker-server] listening on"; then break; fi
    sleep 1; waited=$((waited+1))
  done
  note "broker announced after ${waited}s"
  echo "$before"
}

# ── Shared post-restart assertions ──
assert_broker_up() {
  local mark="$1"
  chk_true "broker bound its socket ([broker-server] listening on)" \
    "$([[ $(count_since "$mark" '\[broker-server\] listening on') -ge 1 ]] && echo 1 || echo 0)"
  chk_true "broker flag is on ([broker] enabled —)" \
    "$([[ $(count_since "$mark" '\[broker\] enabled —') -ge 1 ]] && echo 1 || echo 0)"
  chk "no silent plugin fallback for the pilot channel" "0" \
    "$(count_since "$mark" "broker session prep failed for pool-[0-9]+ on $CHANNEL")"
}

assert_no_pathology() {
  local mark="$1"
  chk "no dead-letter for this channel" "0" "$(count_since "$mark" 'dead-letter')"
  chk "no age-sweep to dead-letter" "0" "$(count_since "$mark" 'age-swept')"
  chk "no DEAF detection" "0" "$(count_since "$mark" 'appears DEAF')"
  chk "no malformed broker frames" "0" "$(count_since "$mark" 'dropped malformed frame')"
  chk "no broker queue persist failure" "0" "$(count_since "$mark" '\[broker-queue\] Persist failed')"
}

summary() {
  echo
  echo "════════════════════════════════════════"
  echo "  checks passed: $pass_count"
  echo "  checks failed: $fail_count"
  if (( fail_count == 0 )); then
    echo "  $(c_g 'ALL CHECKS PASSED') for this validation."
  else
    echo "  $(c_r 'FAILED') — do not advance to the next rollout step."
  fi
  echo "════════════════════════════════════════"
  (( fail_count == 0 ))
}

# ───────────────────────────────── preflight ─────────────────────────────────
cmd_preflight() {
  resolve_channel
  hdr "preflight (no restart required)"
  note "pilot channel resolved from config: $CHANNEL"

  chk "exactly one pilot channel configured" "1" \
    "$(awk '/^ *pilot_channels:/{f=1;next} f&&/^ *- /{n++;next} f{exit} END{print n+0}' "$CONFIG")"
  chk "broker enabled in config" "1" \
    "$(grep -cE '^ *enabled: true' <(awk '/^ *broker:/{f=1} f&&/enabled:/{print;exit}' "$CONFIG"))"
  chk "queue is empty before we start (G0.6)" "0" "$(queue_depth)"
  chk "no dead entries parked in the queue file" "0" \
    "$(jq '[.entries[] | select(.status == "dead")] | length' "$QUEUE" 2>/dev/null || echo ERR)"

  # G0.9: the three live-only gates were found against a specific CLI build.
  note "CLI version: $(claude --version 2>/dev/null)"
  note "record this; a CLI upgrade invalidates any G0.2 pass (#84 R2)"

  # G0.5 dist drift — a stale dist means you are testing yesterday's code.
  local dist_mtime head_time
  dist_mtime=$(stat -f %m "$LF_DIR/src/packages/daemon/dist/index.js" 2>/dev/null || echo 0)
  head_time=$(cd "$LF_DIR/src" && git log -1 --format=%ct 2>/dev/null || echo 0)
  chk_true "dist/index.js is not older than HEAD (G0.5)" \
    "$([[ "$dist_mtime" -ge "$head_time" ]] && echo 1 || echo 0)"
  note "dist mtime $(date -r "$dist_mtime" 2>/dev/null) vs HEAD $(date -r "$head_time" 2>/dev/null)"

  # THE BLOCKER the offline testbed found. A CLI that cannot authenticate
  # routes channel messages correctly and then fails the turn — which looks
  # exactly like the #112/#114 idle-zombie symptom. Check this FIRST or you
  # will misattribute four failures to the broker.
  hdr "CLI auth (checked because a failure here mimics a broker fault)"
  local auth_bad=0
  for s in $(tmux ls -F '#{session_name}' 2>/dev/null); do
    if tmux capture-pane -p -t "$s" -S -60 2>/dev/null \
       | grep -qE 'Login expired|Not logged in|Please run /login'; then
      echo "  $(c_r 'AUTH FAIL')  tmux session '$s' reports Login expired"
      auth_bad=1
    fi
  done
  chk "no live session reports an expired login" "0" "$auth_bad"
  if (( auth_bad )); then
    note "run /login in a claude session before continuing — every validation"
    note "below will FAIL for a non-broker reason while this holds."
  fi

  summary
}

# ─────────────────────────── V1 ───────────────────────────
cmd_v1() {
  resolve_channel
  hdr "V1 — restart → post → single cold assign → reply persists"
  note "the channel must be DARK before the post; a restart guarantees that"

  local mark; mark=$(restart_daemon)
  assert_broker_up "$mark"

  chk_true "channel was left dark on restart (lazy/message-driven)" \
    "$([[ $(count_since "$mark" "\[broker-dark\] Broker channel $CHANNEL left dark") -ge 1 ]] && echo 1 || echo 0)"

  local shim_before; shim_before=$(shim_procs)
  note "shim processes before the post: $shim_before"

  ask "post ONE message in $ROOM_NAME, e.g.: 'cold path v1 — reply with V1-OK'"
  note "waiting up to 180s for the cold start to complete…"

  local waited=0
  while (( waited < 180 )); do
    if since "$mark" | grep -qE "\[broker-server\] registered channel $CHANNEL"; then break; fi
    sleep 2; waited=$((waited+2))
  done

  # This is the ONLY readiness signal that exists for a broker session. See the
  # readiness note at the bottom of this script.
  chk_true "the cold-started session's shim registered (≤180s; took ${waited}s)" \
    "$([[ $(count_since "$mark" "\[broker-server\] registered channel $CHANNEL") -ge 1 ]] && echo 1 || echo 0)"

  chk "exactly ONE cold assign for this channel (single session, not two)" "1" \
    "$(count_since "$mark" "\[pool\] Assigned pool-[0-9]+ to channel $CHANNEL")"
  chk "shim registered exactly once (no reconnect storm)" "1" \
    "$(count_since "$mark" "\[broker-server\] registered channel $CHANNEL")"

  # Q-e: the shim is the transport and the official plugin is not.
  chk_true "a shim process exists for the new session" \
    "$([[ $(shim_procs) -gt "$shim_before" ]] && echo 1 || echo 0)"

  ask "did EXACTLY ONE reply arrive in $ROOM_NAME, authored by lf-pool-N? (ENTER = yes)"

  # Q-h: the ack landed, so nothing is parked.
  chk "queue drained to 0 after the reply (the ack landed)" "0" "$(queue_depth)"
  assert_no_pathology "$mark"

  # "reply persists" — the session JSONL must exist on disk, else the session is
  # `unconfirmed … leaving unpersisted` and the next restart loses the thread.
  local bot_id session_id
  bot_id=$(curl -s "http://127.0.0.1:$DAEMON_PORT/status" \
    | jq -r --arg c "$CHANNEL" '.pool.bots[]? | select(.channel_id==$c) | .id' 2>/dev/null)
  session_id=$(curl -s "http://127.0.0.1:$DAEMON_PORT/status" \
    | jq -r --arg c "$CHANNEL" '.pool.bots[]? | select(.channel_id==$c) | .session_id' 2>/dev/null)
  note "channel owner: pool-$bot_id  session: $session_id"
  chk_true "status reports a bot assigned to the channel" \
    "$([[ -n "$bot_id" && "$bot_id" != "null" ]] && echo 1 || echo 0)"
  chk_true "session id is persisted (not null → JSONL confirmed)" \
    "$([[ -n "$session_id" && "$session_id" != "null" ]] && echo 1 || echo 0)"
  if [[ -n "$session_id" && "$session_id" != "null" ]]; then
    local jsonl
    jsonl=$(find "$HOME/.claude/projects" -name "$session_id.jsonl" 2>/dev/null | head -1)
    chk_true "session JSONL exists on disk ('reply persists')" \
      "$([[ -n "$jsonl" ]] && echo 1 || echo 0)"
    [[ -n "$jsonl" ]] && note "JSONL: $jsonl ($(wc -l < "$jsonl" | tr -d ' ') turns)"
  fi

  summary
}

# ─────────────────────────── V2 ───────────────────────────
cmd_v2() {
  resolve_channel
  hdr "V2 — kill-session-mid-idle → released → post → cold recreate → reply"
  note "PRECONDITION: run v1 first, so a live idle session owns the channel"

  local bot_id tmux_session
  bot_id=$(curl -s "http://127.0.0.1:$DAEMON_PORT/status" \
    | jq -r --arg c "$CHANNEL" '.pool.bots[]? | select(.channel_id==$c) | .id' 2>/dev/null)
  if [[ -z "$bot_id" || "$bot_id" == "null" ]]; then
    echo "$(c_r 'ABORT')  no live session owns $CHANNEL — run v1 first." >&2
    exit 2
  fi
  tmux_session="pool-$bot_id"
  note "owning session: $tmux_session"

  chk "channel is idle (queue empty) before the kill" "0" "$(queue_depth)"

  local mark; mark=$(log_lines)
  hdr "killing the owning session mid-idle"
  note "killing tmux session $tmux_session — the designed #90 trigger"
  tmux kill-session -t "$tmux_session"
  sleep 15   # let the daemon's health path notice and release to dark

  chk_true "channel was released to dark (not re-assigned eagerly)" \
    "$([[ $(count_since "$mark" "\[broker-dark\].*$CHANNEL|released.*$CHANNEL") -ge 1 ]] && echo 1 || echo 0)"
  chk "nothing was dead-lettered by the kill" "0" "$(count_since "$mark" 'dead-letter')"
  chk "queue still empty (nothing stranded by the release)" "0" "$(queue_depth)"

  ask "post ONE message in $ROOM_NAME, e.g.: 'cold path v2 — reply with V2-OK'"
  note "waiting up to 180s for the cold RECREATE…"
  local waited=0
  while (( waited < 180 )); do
    if (( $(count_since "$mark" "\[broker-server\] registered channel $CHANNEL") >= 1 )); then break; fi
    sleep 2; waited=$((waited+2))
  done

  chk_true "a shim registered for the recreated session (took ${waited}s)" \
    "$([[ $(count_since "$mark" "\[broker-server\] registered channel $CHANNEL") -ge 1 ]] && echo 1 || echo 0)"
  chk "exactly ONE cold assign (recreate, not a double-assign)" "1" \
    "$(count_since "$mark" "\[pool\] Assigned pool-[0-9]+ to channel $CHANNEL")"

  ask "did EXACTLY ONE reply arrive, and did it show continuity with the v1 thread? (ENTER = yes)"
  chk "queue drained to 0" "0" "$(queue_depth)"
  assert_no_pathology "$mark"
  summary
}

# ─────────────────────────── V3 ───────────────────────────
# "Exactly once" has NO log observable: no emitted string in the codebase
# contains "Redeliver", and `ack` DELETES the entry, destroying the delivery
# count. So the measurement has to be taken in flight. `watch-queue` samples
# broker-queue.json and records the max `deliveries` ever seen per entry id.
cmd_watch_queue() {
  mkdir -p "$SAMPLE_DIR"
  local out="$SAMPLE_DIR/deliveries.tsv"
  : > "$out"
  echo "sampling $QUEUE every 200ms → $out   (ctrl-C to stop)"
  while :; do
    if [[ -f "$QUEUE" ]]; then
      jq -r '.entries[]? | [.id, (.deliveries|tostring), .status, .content[0:40]] | @tsv' \
        "$QUEUE" 2>/dev/null >> "$out"
    fi
    sleep 0.2
  done
}

cmd_v3() {
  resolve_channel
  hdr "V3 — restart with an unacked queued message → redelivered exactly once"
  echo
  echo "  HOW THE UNACKED MESSAGE IS CREATED (reliably, no race-guessing):"
  echo "  During a cold start, message #1 sits in the queue unacked for the WHOLE"
  echo "  CLI startup (dialog + MCP handshake + the shim's post-initialized grace"
  echo "  — tens of seconds). Restarting inside that window leaves exactly one"
  echo "  unacked entry on disk. That is the state the gate is about."
  echo
  echo "  $(c_y 'TIME LIMIT'): restart within ~9 MINUTES of the post. The server's"
  echo "  age-based dead-letter horizon is 10 min measured from enqueued_at, and"
  echo "  downtime counts toward it — past that the restored entry is"
  echo "  DEAD-LETTERED instead of redelivered (proven offline: V3.3)."
  echo

  # Start from dark so the post triggers a cold start.
  local mark0; mark0=$(restart_daemon)
  assert_broker_up "$mark0"

  note "starting the queue sampler in the background"
  mkdir -p "$SAMPLE_DIR"; : > "$SAMPLE_DIR/deliveries.tsv"
  ( while :; do
      [[ -f "$QUEUE" ]] && jq -r '.entries[]? | [.id,(.deliveries|tostring),.status] | @tsv' \
        "$QUEUE" 2>/dev/null >> "$SAMPLE_DIR/deliveries.tsv"
      sleep 0.2
    done ) & local sampler=$!
  trap 'kill $sampler 2>/dev/null' EXIT

  ask "post ONE message in $ROOM_NAME: 'cold path v3 — reply with V3-OK'"
  note "waiting 4s so the daemon enqueues it, then restarting mid-cold-start"
  sleep 4
  local depth_before; depth_before=$(queue_depth)
  chk_true "the message is queued and unacked before the restart (depth=$depth_before)" \
    "$([[ "$depth_before" -ge 1 ]] && echo 1 || echo 0)"
  local entry_id
  entry_id=$(jq -r '.entries[0].id' "$QUEUE" 2>/dev/null)
  note "entry id: $entry_id"

  local mark1; mark1=$(restart_daemon)

  # The one objective proof that the durable backlog survived the restart.
  chk_true "backlog reloaded on boot ([broker] resumed with N queued …)" \
    "$([[ $(count_since "$mark1" '\[broker\] resumed with [0-9]+ queued inbound message') -ge 1 ]] && echo 1 || echo 0)"
  since "$mark1" | grep -E '\[broker\] resumed with' | tail -1 | sed 's/^/          /'
  chk_true "the SAME entry id is still in the queue file" \
    "$([[ "$(jq -r --arg i "$entry_id" '[.entries[]|select(.id==$i)]|length' "$QUEUE" 2>/dev/null)" == "1" ]] && echo 1 || echo 0)"
  chk "its status was reset to pending for redelivery" "pending" \
    "$(jq -r --arg i "$entry_id" '.entries[]|select(.id==$i)|.status' "$QUEUE" 2>/dev/null)"

  echo
  note "the channel is dark again, so the restored entry is only redelivered"
  note "once a NEW session's shim registers — which needs a second post."
  ask "post a SECOND message in $ROOM_NAME: 'cold path v3 second — reply with V3-TWO'"
  note "waiting up to 180s…"
  local waited=0
  while (( waited < 180 )); do
    if (( $(count_since "$mark1" "\[broker-server\] registered channel $CHANNEL") >= 1 )); then break; fi
    sleep 2; waited=$((waited+2))
  done
  sleep 20   # let both turns run and ack

  kill $sampler 2>/dev/null; trap - EXIT

  # THE measurement: max deliveries ever observed for the restored entry.
  local max_deliv
  max_deliv=$(awk -F'\t' -v id="$entry_id" '$1==id && $2+0>m {m=$2+0} END{print m+0}' \
    "$SAMPLE_DIR/deliveries.tsv")
  chk "restored entry was delivered EXACTLY ONCE after the restart" "1" "$max_deliv"
  note "samples for that id: $(awk -F'\t' -v id="$entry_id" '$1==id' "$SAMPLE_DIR/deliveries.tsv" | wc -l | tr -d ' ')"
  note "raw sample file: $SAMPLE_DIR/deliveries.tsv"

  chk "queue drained to 0" "0" "$(queue_depth)"
  chk "nothing dead-lettered (the restart beat the 10-min horizon)" "0" \
    "$(count_since "$mark1" 'dead-letter|age-swept')"

  ask "in $ROOM_NAME: did the FIRST message get exactly ONE reply (not zero, not two), and the second exactly one? (ENTER = yes)"
  note "zero replies to msg#1 = redelivery lost it. Two = duplicate delivery."
  assert_no_pathology "$mark1"
  summary
}

# ─────────────────────────── V4 ───────────────────────────
cmd_v4() {
  resolve_channel
  hdr "V4 — rapid double-post during cold start → one session, two ordered replies"
  note "the two posts must straddle the assign window, so post them FAST — the"
  note "race only exists while assign() holds its lock (#83)."

  local mark; mark=$(restart_daemon)
  assert_broker_up "$mark"
  local assigns_before; assigns_before=$(count_since "$mark" "Assigned pool-[0-9]+ to channel $CHANNEL")

  ask "post TWO messages in $ROOM_NAME back-to-back, as fast as you can type:
            1st: 'v4 one — reply with V4-ONE'
            2nd: 'v4 two — reply with V4-TWO'"
  note "waiting up to 180s…"
  local waited=0
  while (( waited < 180 )); do
    if (( $(count_since "$mark" "\[broker-server\] registered channel $CHANNEL") >= 1 )); then break; fi
    sleep 2; waited=$((waited+2))
  done
  sleep 30   # let both turns run

  # ONE session for both messages — the #83 invariant.
  chk "exactly ONE cold assign for both messages" "1" \
    "$(( $(count_since "$mark" "Assigned pool-[0-9]+ to channel $CHANNEL") - assigns_before ))"
  chk "shim registered exactly once" "1" \
    "$(count_since "$mark" "\[broker-server\] registered channel $CHANNEL")"

  # If the second post lost the assign lock it must have been BUFFERED, not
  # replied "busy" and not fed straight through (which would reorder it).
  local buffered drained
  buffered=$(count_since "$mark" "Buffered concurrent broker inbound for $CHANNEL")
  drained=$(count_since "$mark" "Drained [0-9]+ buffered broker inbound\(s\) for $CHANNEL")
  note "buffered: $buffered   drained: $drained"
  if (( buffered > 0 )); then
    chk_true "every buffered inbound was drained (none discarded)" \
      "$([[ "$drained" -ge 1 ]] && echo 1 || echo 0)"
    chk "no buffered inbound was discarded" "0" \
      "$(count_since "$mark" "Discarding [0-9]+ buffered broker inbound")"
  else
    note "the 2nd post did NOT hit the assign window — the ordering race was"
    note "not exercised. Re-run v4 and post faster, or treat this as NOT PROVEN."
  fi

  ask "in $ROOM_NAME: did you get EXACTLY TWO replies, V4-ONE before V4-TWO, with no duplicate? (ENTER = yes)"
  note "any other outcome (one reply, three replies, V4-TWO first) is a FAIL."

  chk "queue drained to 0" "0" "$(queue_depth)"
  assert_no_pathology "$mark"
  summary
}

# ─────────────────────────────────────────────────────────────────────────────
cat_readiness_note() {
  cat <<'EOF'

── On readiness (why every step above polls the log instead of asking the CLI) ──

Broker sessions have NO readiness verification on any code path. Confirmed:

  * `wait_for_bot_ready` (pool.ts:162) requires the literal
    "Listening for channel messages". That string appears nowhere in
    shim/discord-shim.ts — the shim's only startup output is
    "lf-discord-shim: connected to broker for channel <id>", on STDERR into the
    tmux pane, never into daemon.log.
  * `wait_for_bot_ready` and `wait_for_bot_ready_with_retries` are exported and
    have ZERO production call sites (only bridge-retry.test.ts). Dead code.
  * The dev-channels dialog is answered by a blind `tmux send-keys Enter` on a
    fixed timer with `catch {}`, and an unanswered dialog is a permanently dark
    channel — the CLI does not spawn its MCP servers until it is answered.

The one real readiness signal that already exists is the daemon-side line
  [broker-server] registered channel <id> → bot <n>
It is emitted in `handle_register`, i.e. only after the CLI has completed its
MCP handshake, the shim has passed its post-`initialized` grace, AND the socket
round-trip worked. Every check above keys on it.

A proper readiness gate should therefore be: after start_tmux for a broker
session, wait (bounded, with retries) for the broker server to report an owner
for that channel — `broker.has_owner(channel_id)` is already implemented and
exported on BrokerServer, and is currently called by nothing. That is a direct
observation of the invariant that matters ("the transport is attached"),
unlike a pane-text match against a string the shim never prints.

What it still would NOT prove: that the CLI will ROUTE a notification rather
than discard it. Only the pane echo ("← <serverKey> · <user>: …") shows that;
see scripts/broker-cli-testbed.mjs, which checks exactly that receipt.
EOF
}

case "${1:-}" in
  preflight)   cmd_preflight ;;
  v1)          cmd_v1 ;;
  v2)          cmd_v2 ;;
  v3)          cmd_v3 ;;
  v4)          cmd_v4 ;;
  watch-queue) cmd_watch_queue ;;
  readiness)   cat_readiness_note ;;
  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    cat_readiness_note
    exit 1 ;;
esac
