# Discord reliability: Phase 0 (stop the losses) and Phase 1 (headless transport)

Status: proposed · Owner: implementing agent · Repo: `hkelley44/lobster-farm`

This plan is written to be executed by an agent with no prior context. Read
"Background" fully before touching code. Every claim about the current code
cites a file; verify it before relying on it, because the code may have moved.

---

## Background: why Discord is unreliable today

Pool sessions are **interactive `claude` processes in tmux**. Inbound Discord
messages reach them through the **official Discord channel plugin**
(`--channels plugin:discord@claude-plugins-official`, see `start_tmux` in
`packages/daemon/src/pool.ts`), which opens its *own* discord.js gateway per
pool bot. The daemon opens a separate gateway (`packages/daemon/src/discord.ts`)
and only *observes* messages; it never hands them to the session.

Consequences:

1. **No delivery receipt.** Discord gateways do not replay messages to a client
   that wasn't connected. If a bot's plugin is booting, reconnecting, or its
   listener silently died, the message is gone, while the daemon has already
   reacted 👀 and started the typing loop. The code says so itself: "the
   inbound→bot path is pure MCP plugin with no daemon send-keys"
   (`PoolBot.last_inbound_at` doc comment, `pool.ts`).
2. **Explicit drops.**
   - `discord.ts` `handle_message` (≈ line 2930): when `pool.assign()` returns
     `null`, plugin channels reply "All bots are busy right now. Your message
     will be picked up when a slot opens." Nothing queues it:
     `deliver_or_buffer_broker_inbound` (`pool.ts` ≈ line 700) returns `false`
     immediately for non-broker channels.
   - The same path catches a **second message sent while the first message's
     `assign()` is still in flight** (assign lock → `null` → "busy" → dropped).
   - Messages sent **after assignment but before the new session's plugin is
     connected** are seen by the daemon (steady-state branch: `touch` +
     `mark_inbound`) but never by the plugin.
3. **The daemon kills sessions based on screen-scraping.**
   `is_tmux_session_idle` (`packages/daemon/src/plugin-liveness.ts`) reads only
   the *last line* of the pane; anything without `esc to interrupt` / `local
   agent` is "idle". The deaf probe (`check_plugin_liveness` →
   `recover_deaf_bot` → `recycle_deaf_bot` in `pool.ts`) then releases and
   reassigns the session after 90s. A permission prompt, a modal, or a CLI
   status-bar change can trigger it.
4. **Blind keypresses.** `start_tmux` sends `Enter` at fixed 3s / 6s delays to
   accept startup dialogs (`pool.ts` ≈ line 4366). Wrong timing leaves a
   dialog open (dark channel) or sends a stray Enter.
5. **Undocumented CLI internals.** The broker/shim path (default OFF, pilot
   only) depends on `--dangerously-load-development-channels`, CLI routing
   logic verified against one CLI version, and a 3s registration-grace
   heuristic (`packages/daemon/src/shim/README.md`).

Phase 0 removes the worst *self-inflicted* losses on the existing plugin
transport. Phase 1 adds a new transport that has a real delivery receipt and
no screen-scraping, behind a per-channel flag.

---

## Ground rules for the implementing agent

- Branch: work on the branch you were given. Small, reviewable commits; one
  commit (or PR) per numbered task below is ideal.
- Conventions: TypeScript, `snake_case` functions/fields (match surrounding
  code), Biome (`pnpm lint`), vitest. Run daemon tests with
  `pnpm --filter @lobster-farm/daemon test` (see the vitest fork-cap note in
  repo history, #34; prefer `--filter` and targeted files:
  `pnpm --filter @lobster-farm/daemon exec vitest run src/__tests__/<file>`).
  Also `pnpm typecheck` and `pnpm build` before each commit.
- **Fail-open discipline** (already a repo invariant): no new code may throw
  into the Discord hot path or the health-monitor loop. Catch, log, Sentry
  (`./sentry.js`), continue.
- **New state files** written with `write_json_atomic` MUST be registered in
  `ATOMIC_STATE_FILES` in `packages/daemon/src/persistence.ts` (its sweep
  regex is anchored to that list).
- **Tests sandbox state**: under `NODE_ENV=test` persistence refuses the real
  `~/.lobsterfarm`; follow existing tests (e.g. `persist-queue.test.ts`,
  `broker-queue.test.ts`) for temp-dir setup.
- Keep the default behaviour unchanged unless a task says otherwise. Every
  behaviour change is behind config with a safe default, or is a pure bug fix.
- Update the module tables in `packages/daemon/src/README.md` and the relevant
  sub-READMEs for every new module.

---

# Phase 0: stop the losses on the plugin transport

Goal: no message the daemon has seen is silently dropped, and the daemon stops
killing sessions on a single unreliable reading. No new transport.

### 0.1 Durable pending-inbound queue for plugin channels

**Problem:** the "All bots are busy" and concurrent-assign paths drop messages
(Background §2).

**Design:**

- New module `packages/daemon/src/pending-inbound.ts` exporting
  `PendingInboundStore`:
  - Persisted to `state/pending-inbound.json` via `write_json_atomic`; add the
    basename constant (e.g. `PENDING_INBOUND_FILE`) next to the others in
    `persistence.ts` and register it in `ATOMIC_STATE_FILES`.
  - Shape: `{ version: 1, entries: Array<PendingMessage & { entity_id: string;
    queued_at: string; attempts: number }> }`. `PendingMessage` is the existing
    interface in `pool.ts`.
  - API: `load()`, `enqueue(entry)`, `peek_channel(channel_id)`,
    `take_channel(channel_id)` (remove + return in arrival order),
    `channels_waiting()` (oldest-first), `depth(channel_id)`, `flush()`.
    Dedupe by `message_id`.
  - Expire entries older than 24h on load and on a periodic sweep; post one
    alert per expired batch (use `notify("alerts", …)` like `pool.ts` does).
- Wire it in `index.ts` (construct, `load()` before Discord starts, pass to
  `BotPool` via a setter like `set_broker`). Keep construction in a small
  factory function so it is testable (see why in the `worktree-lease.ts`
  README entry: `index.ts` is unreachable from tests).

**Changes in `discord.ts` `handle_message`:**

- In the `else` branch after `assign()` returns `null`, when
  `deliver_or_buffer_broker_inbound` returns `false`: enqueue the message in
  `PendingInboundStore` and reply with an honest message:
  `"Queued (position N). I'll start a session for this channel as soon as a bot frees up."`
  Keep the ⏳ reaction on the message.
- If the channel is **currently being assigned** (expose a read-only
  `pool.is_assigning(channel_id)` over the existing `assigning_channels` set),
  enqueue silently (no "busy" reply). It will be delivered as a follow-up
  (see delivery rules).

**Delivery rules (in `pool.ts`):**

1. **Slot frees up** (`release()` and `park_bot()` end, and the end of
   `check_assigned_health`): if `channels_waiting()` is non-empty, take the
   oldest channel and call `assign(channel_id, entity_id, archetype_for(channel),
   undefined, channel_type, undefined, first_pending)`. `first_pending` drives the
   session's first turn through the existing SessionStart-hook path (#290).
   Look up archetype/channel_type the same way `handle_message` does (the
   `channel_map` entry lives in `DiscordBot`; add a callback
   `pool.set_channel_resolver(fn)` that `DiscordBot` registers, rather than
   importing `DiscordBot` into the pool).
2. **Follow-ups for a channel that now has a confirmed session:** after
   `watch_session_confirmation` confirms a session (find where
   `session_confirmed = true` is set), deliver any remaining queued entries for
   that channel through `inject_message_to_bot(bot.tmux_session, text)`, in
   order. Format `text` exactly as a channel message header the agent can act on:
   `[Discord · #<channel-name> · from <user> · message_id <id>]\n<content>`
   (the agent must still reply with the Discord reply tool; the header gives it
   `chat_id`/`message_id`. Include `chat_id=<channel_id>` in the header).
   Remove an entry from the store only when `inject_message_to_bot` returns
   `true`. On `false` it is queued in `pending_injections`; leave the store
   entry and let the next pass retry (dedupe by `message_id` so the in-memory
   `pending_injections` and the store can't double-send: track
   `injected_message_ids` per session).
3. When a pending entry is finally handed to a session, swap the reaction
   ⏳ → 👀 (use the existing `DiscordBot` helpers; pool emits an event, the
   bot reacts, same pattern as nickname/avatar handlers).

**Tests** (new `src/__tests__/pending-inbound.test.ts` + additions to
`pool.test.ts` / a new `discord-busy-queue.test.ts`):

- store: enqueue/take order, dedupe, persistence round-trip, expiry, atomic
  file registered in `ATOMIC_STATE_FILES` (there is an existing test asserting
  that list; extend it).
- `assign()` returns null on a plugin channel → message stored, honest reply
  sent, no "will be picked up" lie.
- concurrent assign: second message during in-flight assign → stored silently,
  injected after confirmation, in order.
- slot frees → oldest waiting channel assigned with its first pending message
  as `pending_message`.
- injection failure keeps the entry; success removes it; no double send.

### 0.2 Cover the cold-start window (message after assign, before plugin is ready)

**Problem:** the steady-state branch in `handle_message` trusts the plugin
even when the session was assigned seconds ago and its plugin isn't listening.

**Design:**

- Add `pool.is_plugin_ready(bot)`: `true` if the bot is `session_confirmed`
  AND either (a) the pane has shown the plugin's ready marker
  (`"Listening for channel messages"`, already used by `wait_for_bot_ready`
  in `pool.ts` ≈ line 162), recorded once into a new in-memory
  `PoolBot.plugin_ready_at`, or (b) the bot has processed at least one turn
  since assignment (`last_processing_at > assigned_at`).
  Cache the positive result; never re-scrape after it's true.
- In the steady-state branch: if the bot is on the plugin transport and
  `!is_plugin_ready(bot)`, enqueue the message into `PendingInboundStore`
  (0.1) instead of relying on the plugin, and let rule 2 of 0.1 inject it
  after confirmation.
- Accept a small duplicate risk (plugin connected moments before we checked).
  Mitigate: when injecting, skip entries whose `message_id` the session has
  already seen. Detect via the session JSONL: search the transcript for the
  `message_id` string before injecting (helper reading
  `claude_session_jsonl_path`, already exported from `pool.ts`). Fail toward
  injecting (a duplicate is better than a loss).

**Tests:** steady-state message to an unconfirmed / not-ready bot is stored and
later injected; to a ready bot it is not stored; JSONL dedupe skips a message
already present.

### 0.3 Make the deaf probe non-destructive by default

**Problem:** a single "idle for 90s" reading ends the session.

**Design:**

1. **Better idle reading** (`plugin-liveness.ts` `is_tmux_session_idle`):
   scan the last **8** non-empty lines of the pane (not only the last line) for
   the working markers `esc to interrupt` and `local agent`. Keep the
   fail-open behaviour. Update the doc comment and the tests in
   `plugin-liveness.test.ts`.
2. **Blocking-state detection before any verdict:** new pure function
   `classify_blocking_pane(pane_text): "permission_prompt" | "rate_limit_modal"
   | "trust_dialog" | "login_required" | null` in `plugin-liveness.ts`. Collect
   the real strings from the existing detectors (`check_rate_limit_modals`,
   `is_pane_stale_oauth` in `pool.ts`) plus the permission-prompt text (capture
   it from a live CLI and put the fixture in the test). If non-null, the deaf
   path must NOT recycle: post one alert naming the state, apply the existing
   remedy where one exists (rate-limit Escape, stale-OAuth recycle), and stop.
3. **Redeliver before recycle:** extend the in-memory record kept by
   `mark_inbound` to hold the last unprocessed inbound(s) (`message_id`,
   `user`, `content`, `ts`), max 10 per bot, cleared on the same transitions
   that clear `last_inbound_at`. `discord.ts` passes these fields into
   `mark_inbound`. On the **first** `deaf` verdict: inject the missed
   message(s) through `inject_message_to_bot` (same header format as 0.1),
   re-arm `last_inbound_at = now`, record `redelivered_at`, alert
   "redelivered". Only a **second** consecutive `deaf` verdict after a
   redelivery calls the existing `recover_deaf_bot` path.
4. **Config switch** in `packages/shared/src/schemas/config.ts` under the
   existing `pool` (or `discord`) block:
   `deaf_policy: z.enum(["recycle", "redeliver_then_recycle", "alert_only"]).default("redeliver_then_recycle")`.
   `recycle` = today's behaviour (escape hatch).

**Tests:** extend `plugin-liveness.test.ts`, `pool-plugin-liveness.test.ts`,
`commander-plugin-liveness.test.ts`: multi-line idle scan; each blocking state
suppresses recycle; first deaf → redeliver (no release); second deaf →
recycle; `alert_only` never recycles; `recycle` matches old behaviour. The
commander shares `evaluate_plugin_liveness`; apply items 1–2 there too, and
item 3 only if trivial (commander has no inject path; alert-only is fine).

### 0.4 Replace fixed-time Enter keypresses with pane-matched answers

**Problem:** `start_tmux` presses Enter at 3s/6s blindly.

**Design:**

- New helper `answer_startup_dialogs(tmux_session, { timeout_ms: 45_000,
  poll_ms: 500, expect_dev_channels: boolean })` in `pool.ts` (or a new
  `startup-dialogs.ts`), replacing both `setTimeout` blocks:
  - Poll `capture-pane`. If the pane matches the workspace-trust dialog or the
    dev-channels confirmation (capture exact strings from a live CLI; store as
    constants with a comment naming the CLI version), send `Enter` once per
    dialog occurrence.
  - Stop when the pane shows the prompt `❯` with no dialog text, or the plugin
    ready marker, or timeout.
  - On timeout with a dialog still visible: alert (`notify("alerts", …)`) and
    Sentry; do not kill the session.
- Run it without blocking `start_tmux`'s promise (same as today's timers).

**Tests:** new `startup-dialogs.test.ts` with injected `capture`/`send_keys`
fakes: no dialog → no keypress; trust dialog → exactly one Enter; trust then
dev dialog → two Enters; dialog persists → alert after timeout, no kill.

### 0.5 Inbound outcome logging (observability)

- One structured log line per inbound in `handle_message`:
  `[inbound] channel=<id> message=<id> outcome=<plugin|queued_busy|queued_assigning|queued_not_ready|commander|ignored>`.
- One per resolution: `[inbound] message=<id> resolved=<first_turn|injected|expired|redelivered>`.
- Add pending-queue depth per channel to `/status` output (`discord.ts`
  status command) and to the pool status object (`get_status`).

### Phase 0 acceptance criteria

- Every inbound message on a mapped channel ends in exactly one of: handled
  by the plugin, injected, used as a first turn, or expired-with-alert. No
  code path replies "will be picked up" without storing the message.
- With `deaf_policy` default, no session is released by the deaf probe
  without one redelivery attempt first, and never while a blocking state is
  visible.
- No fixed-delay `send-keys Enter` remains in `start_tmux`.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, daemon tests all green.

---

# Phase 1: headless transport (`claude -p` + stream-json), behind a flag

Goal: for opted-in channels, the daemon owns delivery end-to-end. One
long-lived headless `claude` process per assigned channel receives turns on
stdin and emits structured events on stdout. A message is acked only when the
turn's `result` event arrives. No tmux, no plugin, no pane scraping, no
keypresses.

```
Discord ──(daemon's single gateway)──▶ handle_message
                                         │ enqueue (durable, BrokerQueue)
                                         ▼
                                 HeadlessChannelRunner ──stdin (stream-json)──▶ claude -p
                                         ▲                                         │
                                         └──────── stdout events (init/assistant/  │
                                                   tool_use/result) ◀──────────────┘
                                         │ on result: ack + post reply via REST
                                         ▼
                           OutboundExecutor (per-bot token → lf-pool-N identity)
```

### 1.0 Spike: verify CLI behaviour first (blocking; do before any other 1.x)

Write a throwaway script under `packages/daemon/scripts/headless-spike.mjs`
(there is a precedent: `scripts/broker-cli-testbed.mjs`) and record findings
in `docs/plans/headless-spike-findings.md`, including `claude --version`.
Verify each item; if any fails, stop and report before building on it:

1. `claude -p --input-format stream-json --output-format stream-json --verbose`
   stays alive across **multiple** user messages written to stdin as NDJSON
   lines of the form
   `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`,
   and emits exactly one `{"type":"result",…}` per user message.
2. What happens when a second user message is written **while a turn is
   running** (queued until the turn ends? merged? rejected?). The runner design
   in 1.4 assumes "write only when idle", so this is informational, but record it.
3. The `system`/`init` event carries `session_id`; `result` carries
   `session_id`, `is_error`, `subtype`, `result` (final text),
   `duration_ms`, `total_cost_usd`/usage. Record exact field names.
4. These flags work in this mode together: `--agent <name>`, `--model`,
   `--effort`, `--permission-mode bypassPermissions`, `--add-dir` (×n),
   `--session-id <uuid>` (fresh) and `--resume <uuid>`, `--mcp-config <file>`.
5. Auth uses the existing CLI login (subscription), same as the daemon's other
   `claude -p` calls (`claude-cli.ts`). No API key required.
6. Hooks configured in settings (SessionStart, Stop) still fire in this mode,
   and whether the Stop hook fires per turn.
7. Closing stdin ends the process cleanly after the current turn; SIGTERM
   behaviour; exit code on auth failure and on rate limit; what a rate-limit
   / usage-limit failure looks like in the stream (`result` with `is_error`?
   which text?).
8. Whether slash commands sent as user text (e.g. `/compact`) are executed in
   this mode. Needed by 1.9.
9. Idle process memory/CPU (one process per assigned channel will sit idle).
10. How the plugin's channel notifications appear in a normal session's JSONL
    transcript (open an existing pool session JSONL). Record the exact wrapper
    (e.g. a `<channel source="discord" chat_id=… message_id=… user=… ts=…>`
    block) so 1.4 can format headless turns identically and the agents'
    prompts/skills keep working unchanged.

### 1.1 Config and transport selector

In `packages/shared/src/schemas/config.ts`, under `discord`:

```ts
transport: z
  .object({
    /** Channels on the headless transport (claude -p + stream-json). */
    headless_channels: z.array(z.string()).default([]),
    /** Optional: make headless the default for all pool channels. */
    default: z.enum(["plugin", "headless"]).default("plugin"),
    /** Wall-clock after which a running turn raises an alert (no kill). */
    turn_alert_after_ms: z.number().int().positive().default(30 * 60_000),
  })
  .optional(),
```

- Add `Pool.transport_for(channel_id): "plugin" | "broker" | "headless"`.
  Precedence: `headless_channels` (or `default: "headless"`) > broker pilot >
  plugin. Log a config warning at startup if a channel is in both
  `headless_channels` and `broker.pilot_channels`.
- Replace direct `uses_broker()` decisions with `transport_for()` where the
  question is "which transport", keeping `uses_broker()` as a thin wrapper so
  the broker's existing tests are untouched.
- Add `transport: "plugin" | "broker" | "headless" | null` to `PoolBot`
  (in-memory; derive on load for persisted bots). The transport is fixed at
  bring-up, same rule as the broker README.
- Tests: schema defaults; precedence; channel in both lists → headless wins + warning.

### 1.2 `HeadlessSession`: the process wrapper

New file `packages/daemon/src/headless/session.ts`.

```ts
export interface HeadlessStartOptions {
  bot_id: number;
  channel_id: string;
  cwd: string;
  args: string[];               // full claude argv after the binary
  env: Record<string, string>;
  event_log_path: string;       // state/headless/pool-<id>.ndjson
}

export type HeadlessEvent =
  | { kind: "init"; session_id: string; raw: unknown }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; is_error: boolean }
  | { kind: "result"; is_error: boolean; subtype: string; text: string; session_id: string; raw: unknown }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null; signal: string | null };

export class HeadlessSession extends EventEmitter {
  constructor(opts: HeadlessStartOptions, deps?: { spawn_impl?: typeof spawn; now?: () => number });
  start(): void;
  /** Write one user turn. Throws if a turn is in flight or the process is dead. */
  send_turn(text: string): void;
  get busy(): boolean;
  get alive(): boolean;
  get session_id(): string | null;
  /** Close stdin, wait up to grace_ms for exit, then SIGTERM, then SIGKILL. */
  stop(grace_ms?: number): Promise<void>;
}
```

- Spawn with `stdio: ["pipe", "pipe", "pipe"]`, `detached: false`. Use the
  same env assembly as `start_tmux` (GH token, op token, `CLAUDE_CONFIG_DIR`,
  `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME`); **refactor that assembly out of
  `start_tmux` into a shared function** rather than duplicating it.
- Parse stdout as NDJSON. The `NdjsonDecoder` in `broker/protocol.ts` is typed
  for broker envelopes; either generalise it (generic type param, keep the
  existing export working) or add a minimal line splitter in
  `headless/ndjson.ts`. Never throw on a malformed line: emit `stderr`-style
  log + Sentry breadcrumb and continue.
- Map stream events to `HeadlessEvent` using the field names recorded in the
  spike. Unknown event types: append to the event log, otherwise ignore.
- Append every raw stdout line (and stderr lines, prefixed) to
  `event_log_path`. Rotate at 10 MB keeping one backup (see
  `log-rotation.ts` for the pattern).
- `busy` is true from `send_turn` until the matching `result`.
- Stdin `EPIPE`/write errors must not throw out of `send_turn` asynchronously:
  attach an `error` listener on `stdin` (see the EPIPE guard precedent in
  `reply-enforcement.ts`, #81).

**Tests** (`src/__tests__/headless-session.test.ts`), using a fake child
process (EventEmitter with fake stdin/stdout/stderr streams) injected via
`spawn_impl`: init → `session_id` set; text + tool_use + result sequence →
events in order, `busy` toggles; malformed line ignored; `send_turn` while
busy throws; exit mid-turn emits `exit` and `busy` false; `stop()` closes
stdin then escalates signals on timeout; event log written.

### 1.3 Building the argv

New function `build_headless_args(...)` next to `start_tmux` in `pool.ts`
(or in `headless/args.ts`), mirroring `start_tmux`'s `claude_args` exactly
except for transport and quoting (no `sq()`; argv is passed directly, no shell):

```
-p --input-format stream-json --output-format stream-json --verbose
--agent <agent_name> --model <model_id> [--effort <effort>]
--permission-mode bypassPermissions
--add-dir <working_dir> --add-dir <entity_dir> --add-dir ~/.claude --add-dir /tmp
--mcp-config <state_dir>/headless-mcp.json
(--session-id <uuid> | --resume <uuid>)
```

- No `--channels`, no `--dangerously-load-development-channels`, no
  `--strict-mcp-config` (normal MCP config loading stays, so global servers
  like `playwright` keep working) — **verify in the spike** that adding
  `--mcp-config` without `--strict-mcp-config` merges rather than replaces; if it
  replaces, reuse `prepare_broker_session`'s global-server merge.
- `headless-mcp.json` registers the existing shim
  (`packages/daemon/src/shim/discord-shim.ts`) in **outbound-only** mode (1.5)
  under `SHIM_MCP_SERVER_KEY`, so the agent keeps the identical
  `mcp__plugin_discord_discord__{reply,react,edit_message,download_attachment,fetch_messages}`
  tools and existing prompts/skills (`config/claude/agents/*.md`) work unchanged.
- Test: snapshot the argv for fresh and resume; assert no channel flags.

### 1.4 `HeadlessChannelRunner`: queue ↔ process

New file `packages/daemon/src/headless/runner.ts`. One runner per headless
channel with an assigned bot. Responsibilities:

- **Durable inbound**: reuse `BrokerQueue` (`broker/queue.ts`). Construct a
  *separate* instance at `state/headless-queue.json` (new constant + register
  in `ATOMIC_STATE_FILES`) so headless and broker state never mix. Construct
  it with `redeliver_after_ms` set very high (e.g. 7 days): in headless mode
  redelivery is driven by **process exit**, not by a timer, because a long
  turn is not a failure. Keep `max_deliveries` (default 5) and wire
  `on_dead_letter` to the same alert path the broker uses
  (`broker/dead-letter.ts` / `alert-router.ts`; read them first).
- **Turn assembly**: when the session is alive, not busy, and the queue has
  deliverable entries for the channel, take **all** deliverable entries
  (ordered), `mark_delivered` each, and send **one** user turn containing each
  message wrapped exactly like the plugin's channel notification (format from
  spike item 10), one block per message, in order. Batching is deliberate:
  messages that arrive during a turn become the next single turn.
- **Ack**: on the `result` event for that turn, `ack()` every entry in the
  batch, then run outbound (1.5). `is_error` results are still acked (the
  turn ran) except for rate-limit (see 1.7).
- **Process exit before `result`**: do not ack. The entries are still
  `delivered`; call a new `BrokerQueue.requeue(ids)` (add it: sets status back
  to `pending`, keeps `deliveries` count) so the respawned process receives
  them. Dead-lettering after `max_deliveries` is the poison-loop breaker.
- **Turn watchdog**: if `busy` longer than `turn_alert_after_ms`, post one
  alert (no kill). Also expose `interrupt()` that sends SIGINT for a future
  `/stop` command (not wired to anything automatic).
- **Typing/status**: expose `get_activity(): { busy: boolean; started_at:
  number | null; tool_count: number; last_tool: string | null }` for 1.6.
- Runner must be restart-safe: on daemon start, entries left `delivered` in
  `headless-queue.json` are reset to `pending` (the process that had them is
  gone).

**Tests** (`headless-runner.test.ts`, fake `HeadlessSession`): enqueue →
turn sent; two messages during a busy turn → one batched next turn, in order;
result → acked; exit mid-turn → requeued, delivered after respawn; 5 exits →
dead-letter + alert; restart with `delivered` entries → reset to pending;
watchdog alert fires once.

### 1.5 Outbound: replies and tools

Two complementary paths:

1. **Tools (agent-initiated):** run the shim in outbound-only mode.
   - `shim/discord-shim.ts`: honour `LF_BROKER_OUTBOUND_ONLY=1`: still connect
     and register (identity is server-side, keyed by connection), skip the
     registration grace, never emit `notifications/claude/channel`.
   - `broker/protocol.ts`: add optional `mode?: "full" | "outbound_only"` to
     `RegisterEnvelope` (absent ⇒ `"full"`, so old shims are unchanged).
   - `broker/server.ts`: never deliver inbound to an `outbound_only`
     connection, and an `outbound_only` registration must not take inbound
     ownership away from a `full` one.
   - This requires the broker's IPC server to run whenever any headless channel
     is configured, even if `discord.broker.enabled` is false. Split the
     `DiscordBroker` start condition in `index.ts`: start the server + executor
     when `broker.enabled || headless configured`; the broker *inbound* path
     stays gated on `broker.enabled` + pilot list. Do not change broker
     behaviour for broker channels.
   - Register headless channel ownership (`register_channel`) at bring-up so
     outbound uses the right per-bot token (`ChannelOwnership` in
     `broker/index.ts`).
2. **Final-text fallback (daemon-initiated):** on `result`, if the agent did
   **not** call a reply-shaped tool during the turn (reuse
   `is_reply_tool_name` from `reply-enforcement.ts`; export it) and `result.text`
   is non-empty, the runner posts it via
   `OutboundExecutor.execute("reply", { chat_id, text, reply_to: <last message_id in batch> }, ctx)`.
   `OutboundExecutor` already chunks to 2000 chars. If the text is longer than
   8000 chars, post the first 1800 chars plus the full text as a `.md`
   attachment (check `reply`'s `files` arg support in `outbound.ts`; if absent,
   add it). If neither text nor a reply happened, react ✅ on the last message so
   the user sees the turn finished.
- **Reply enforcement:** the Stop-hook reply enforcement
  (`reply-enforcement.ts`) must pass through for headless sessions (the runner
  owns delivery now). Pass `LF_TRANSPORT=headless` in the session env and make
  the Stop-hook handler (`server.ts` `/hooks/stop`) skip enforcement when the
  session belongs to a headless bot (look up by `session_id` in the pool).
  Keep `mark_processed` working.

**Tests:** shim outbound-only never emits notifications; server ignores
inbound for outbound-only; reply-tool-called → no fallback post; no tool →
fallback post with `reply_to`; long text → attachment; empty → ✅ reaction;
reply-enforcement skipped for headless session ids.

### 1.6 Typing indicator and status embed from events

- In `discord.ts` `start_typing_loop`: if the channel's bot is headless, drive
  the loop from `runner.get_activity()` instead of `is_bot_idle` /
  `capture-pane` / `"← discord"` scraping: send typing while `busy`, update the
  status embed from `tool_count`/`last_tool`/elapsed, finalize on not-busy.
  Keep the plugin path untouched.
- `update_status_embed_from_tmux` gets a sibling `update_status_embed_from_activity`.
- Tests: extend `typing-loop-grace.test.ts` (or new file) for the headless branch.

### 1.7 Pool integration

In `pool.ts`, branch on `bot.transport === "headless"`:

| Concern | Headless behaviour |
|---|---|
| Bring-up (`assign`, resume paths, `restart_crashed_session`) | Call new `start_headless(bot, …)` instead of `start_tmux`. It builds argv (1.3), writes `headless-mcp.json`, registers broker ownership, creates `HeadlessSession` + `HeadlessChannelRunner`, keeps them in a `Map<bot_id, …>` (not persisted). If `pending_message` is given, enqueue it as the first entry (no SessionStart-hook injection needed). |
| `is_session_alive` / `is_tmux_alive` callers | `session.alive`. Audit every `is_tmux_alive`, `kill_tmux`, `capture-pane`, `send-keys` call site and make each transport-aware; headless never shells out to tmux. |
| Session confirmation | Take `session_id` from the `init` event; keep the existing JSONL-on-disk confirmation (`watch_session_confirmation`) unchanged. |
| Crash | `exit` event while assigned → existing crash accounting (`record_crash`, `is_crash_loop`, `handle_crash_loop`) → respawn with `--resume`; runner requeues unacked entries (1.4). |
| Release / park / evict / shutdown | `runner.stop()` then `session.stop(10_000)`; stash session history exactly as today (`stash_session_history`). `shutdown()` stops all headless sessions. |
| Daemon restart | Children die with the daemon. Do not respawn eagerly; resume lazily on the next message or on queue backlog for that channel (mirror the broker's lazy model, #89). `resume_parked_bots`/`reconcile_assigned_health` must not try tmux for headless bots. On startup, for each channel with pending entries in `headless-queue.json`, assign/resume so the backlog drains. |
| Health monitor | Skip plugin-liveness, deaf probe, post-restart heal, rate-limit modal check, cwd-health `cd` injection, stale-OAuth pane check for headless bots. |
| Stale auth | Detect from the stream (spike item 7: `result.is_error` / exit code + text such as "not logged in"/401). Alert once with remedy; leave entries pending. |
| Rate limit | Detect from the stream (spike item 7). Do not ack; `requeue` and schedule the next attempt at the parsed reset time, or +15 min if unparsable; post one notice to the channel ("Rate limited — will continue at HH:MM") and one alert. |
| Activity state / eviction (`compute_activity_state`, `is_bot_idle`) | Use `runner.get_activity().busy` and last result time instead of pane reads. A busy headless bot is never evicted (same FLOOR rule). |
| `inject_message_to_bot` (PR-watch notifications) | For headless bots, enqueue a synthetic entry into the runner queue (author `lobsterfarm`, content = the message) instead of send-keys. |

Tests: extend `pool.test.ts` / new `pool-headless.test.ts` with injected fake
session factory: assign → headless started with pending first; crash →
resume + requeue; release → stop + history stash; eviction skips busy
headless bot; health monitor never calls tmux for headless bots (spy on
`execFileSync`); restart with backlog → channel resumed and drained;
`inject_message_to_bot` → queue entry.

### 1.8 Slash commands

Make each command in `discord.ts` transport-aware:

- `/reset`, `/close`, `/resume`, `/archives`, `/swap`, `/room`: go through
  `assign`/`release`, which become transport-aware in 1.7. Verify each with a
  test.
- `/compact`: if the spike (item 8) shows `/compact` works as stream-json user
  text, enqueue it as a synthetic turn; otherwise implement by stopping the
  process and resuming (document the limitation in the command reply).
- `/status`: show transport per channel, queue depth, busy/idle, last result
  time, process uptime.
- Add `/stop`: calls `runner.interrupt()` for headless channels (SIGINT the
  current turn); reply "not supported" on plugin channels.

### 1.9 `lf tail` CLI command

In `packages/cli`: `lf tail <channel-name|channel-id|pool-N> [--raw]` follows
`state/headless/pool-<id>.ndjson`, pretty-printing assistant text, tool calls
(name + short input), results (duration, cost). Resolve channel → bot through
the daemon's HTTP API (add `GET /pool/assignments` if no equivalent exists in
`server.ts`). This replaces `tmux attach` for watching a headless session.

### 1.10 Documentation

- New `packages/daemon/src/headless/README.md`: design, invariants (ack on
  result only; redelivery on exit only; no tmux; fail-open), config, rollout,
  rollback.
- Update `packages/daemon/src/README.md` file table, `broker/README.md`
  (outbound-only mode), `shim/README.md` (env `LF_BROKER_OUTBOUND_ONLY`), root
  `README.md` (mention `lf tail`, `/stop`, transport flag).

### 1.11 Rollout

1. Merge with `headless_channels: []` (no behaviour change). Confirm all tests
   and a daemon restart are clean.
2. Pilot: add one low-traffic channel. Watch for 3 days:
   - every `headless-queue.json` entry ends acked or dead-lettered with an alert;
   - no session ended by daemon heuristics (grep logs for deaf/recycle on that channel: should be none);
   - replies arrive under the `lf-pool-N` identity; tools work;
   - `/reset`, `/swap`, `/compact`, `/stop`, daemon restart mid-turn
     (message redelivered after restart, answered once).
3. Widen to all entity channels; then set `default: "headless"`.
4. Rollback for a channel: remove it from `headless_channels` (or flip
   `default`) and `/reset` the channel; it comes back on the plugin.

### Phase 1 acceptance criteria

- On a headless channel: zero tmux processes, zero `send-keys`, zero
  `capture-pane` calls attributable to it (assert in tests via spies).
- A message is removed from the durable queue only after its turn's `result`.
- Killing the `claude` process mid-turn (`kill -9`) results in the same
  message being answered once by the resumed session.
- Restarting the daemon mid-turn results in the message being answered once.
- Plugin and broker channels behave exactly as before (existing tests green,
  untouched).

---

## Out of scope (Phase 2, do not implement now)

- Moving the commander (Pat, `commander-process.ts`) to the headless transport.
- Deleting the plugin path, the broker inbound path, the shim's inbound
  half, plugin-liveness, deaf recycle, post-restart heal, rate-limit modal
  handling, and tmux startup-dialog handling once headless is the default and
  stable.
- Discord button-based permission prompts via `--permission-prompt-tool`.
- Stopping pool bots from appearing offline (they no longer hold a gateway
  under headless; cosmetic).

## Suggested commit/PR order

1. 0.5 logging (tiny, makes everything after observable)
2. 0.1 pending-inbound store + busy/concurrent paths
3. 0.2 cold-start window
4. 0.3 deaf probe policy
5. 0.4 startup dialogs
6. 1.0 spike + findings doc (no production code)
7. 1.1 config + selector
8. 1.2 `HeadlessSession`
9. 1.3 + 1.5 (argv, shim outbound-only, broker server split)
10. 1.4 runner
11. 1.7 pool integration + 1.6 typing/status
12. 1.8 slash commands
13. 1.9 `lf tail`
14. 1.10 docs
