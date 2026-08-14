# broker/

Daemon-owned Discord gateway **broker** — Phase 1 of epic #84 (issue #85).

The broker lets the daemon own the Discord connection for a channel and hand
inbound messages to an agent session over a **unix domain socket** instead of
the session opening its own discord.js gateway. It also performs outbound REST
(reply/react/edit/download) on the session's behalf, using the correct per-bot
token so replies keep the `lf-pool-N` identity.

**Default OFF.** When `discord.broker.enabled` is false (or absent), nothing in
here runs and every session uses the official plugin exactly as before.

## Modules

- **index.ts** — `DiscordBroker` facade. The only surface the daemon touches:
  `start()` / `stop()`, `register_channel()` / `release_channel()`, `feed()`
  (enqueue an inbound), `owns()` (ownership check for the inbound hot path).
  Wires the queue, the IPC server, and the outbound executor together.

- **protocol.ts** — the wire contract. `BrokerEnvelope` union (register / inbound
  / ack / outbound_request / outbound_response), `InboundMeta` (byte-identical to
  the plugin's `notifications/claude/channel` meta), and NDJSON framing helpers
  (`encode_envelope`, `NdjsonDecoder`). Transport-agnostic — no socket code here.
  Also home of `SHIM_MCP_SERVER_KEY` — the MCP server key the shim is registered
  under. The key is load-bearing twice: it makes the shim's tool names byte-
  identical to the plugin (`mcp__plugin_discord_discord__*`), and it must appear
  as `--channels server:<key>` on the session's `claude` invocation or the CLI
  silently drops every `notifications/claude/channel` the shim emits (the
  idle-zombie bug — see the constant's doc comment).

- **queue.ts** — `BrokerQueue`, the durable per-channel inbound queue. Every
  inbound is persisted (atomic write-temp-then-rename, coalesced async writes)
  BEFORE any delivery attempt, so a daemon restart mid-flight reloads the backlog
  and resumes. Delivery is confirmed by an explicit `ack`; unacked entries are
  redelivered a bounded number of times, then dead-lettered with an alert.
  `flush()` truly drains the in-flight write loop for a clean shutdown.

- **server.ts** — `BrokerServer`, the unix-socket IPC endpoint. Accepts shim
  connections, tracks channel ownership by connection (newest registration wins),
  delivers deliverable queue entries on register + on a periodic sweep, handles
  acks, and round-trips `outbound_request` → `outbound_response` through the
  injected `OutboundHandler` using the *connection's* identity (never the
  request's — a session cannot spoof another bot).

- **dead-letter.ts** — `handle_dead_letter` (#107), the alert + session-heal
  composition for a dead-lettered inbound. Captures the quoted message FIRST
  (the entry is its only copy), then runs `pool.heal_dead_letter` (release the
  owning bot to dark, queue preserved, 10-min per-channel cool-down), then posts
  ONE alert per outcome: healed → `action_required` naming the recycled session;
  repeat-within-cool-down → `incident_open`, no automatic action; already-dark →
  plain dead-letter alert. The dead-lettered message is never re-enqueued
  (poison-loop breaker). Extracted from index.ts wiring for testability.

- **outbound.ts** — `OutboundExecutor`, raw Discord API v10 REST. Reads the
  per-bot token from `<state_dir>/.env`, produces result strings byte-identical
  to the plugin (`sent (id: X)`, `reacted`, `edited (id: X)`, the fetch line
  format, `downloaded N attachment(s): …`). `fetch` is injectable for tests.
  Fail-open: a REST failure or missing token becomes an error *result*, never a
  throw.

## Enabling the broker (pilot-first, default OFF)

The broker is gated by two config keys under `discord.broker` in
`~/.lobsterfarm/config.yaml`:

```yaml
discord:
  broker:
    enabled: true            # master switch — default false / absent
    pilot_channels:          # allowlist of channel IDs on the broker transport
      - "1234567890123456789"
```

Behavior:

- **`enabled: false` (or the `broker` block absent) — the default.** Every
  transport decision resolves to "plugin" and the daemon is byte-identical to
  today. The broker is never even constructed.
- **`enabled: true` with an empty `pilot_channels` — effectively off.** The
  broker starts, but no channel matches the allowlist, so every session still
  uses the plugin. Safe to leave in this state.
- **`enabled: true` with channel IDs listed — pilot.** Only the listed channels
  route through the LF shim + broker; all other channels stay on the official
  plugin. This is the intended rollout mode: add one low-traffic channel, watch
  it, then widen.

The fork happens once, at session bring-up, in `Pool.uses_broker(channel_id)`
(`enabled && pilot_channels.includes(channel_id)`). Changing the config takes
effect for **new** sessions; a session already running on one transport keeps it
until it's next brought up.

Rollout steps:

1. Set `discord.broker.enabled: true` and add exactly one channel ID to
   `pilot_channels`.
2. Restart the daemon (or wait for the target channel's session to be brought up
   fresh).
3. Confirm the session launched with the shim: its `broker-mcp.json` exists in
   the pool `state_dir`, and `mcp__plugin_discord_discord__*` tools resolve as
   before.
4. Exercise reply/react/fetch and verify the reply identity is `lf-pool-N` (the
   per-bot token path).
5. To roll back a channel: remove it from `pilot_channels` (or set `enabled:
   false`) and bring the session up again — it reverts to the plugin with no
   code change.

If the broker fails to start, `index.ts` logs and falls back to the plugin for
the whole daemon — enabling it can never harden into an outage.

## Design invariants

- **Fail-open everywhere.** No broker fault may throw into a session's hot path.
  `feed()` on an unowned channel is a no-op; outbound failures return error
  results; a broker startup failure in `index.ts` falls back to the plugin.
- **Identity is server-side.** Outbound always uses the token of the bot bound to
  the connection at register time.
- **Durability first.** Enqueue-then-deliver; ack-to-remove; redeliver-then-dead-
  letter. A message is never silently dropped.

## Why a unix domain socket

The shim and the daemon are always co-resident on one host. A unix domain socket
gives us a local, filesystem-permissioned, bidirectional stream with no port
allocation and no network exposure — strictly better than a TCP loopback port
for a same-host IPC channel. NDJSON over the stream keeps framing trivial and
debuggable (`nc -U` + line reads) while staying language-neutral.

See also `../shim/README.md` for the agent-facing MCP shim that connects here.
