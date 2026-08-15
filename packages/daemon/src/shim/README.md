# shim/

LF-owned Discord **MCP shim** — the agent-facing half of the broker (issue #85).

`discord-shim.ts` is a standalone MCP server that presents a **byte-identical**
surface to the official Discord plugin (`~/.claude/plugins/cache/
claude-plugins-official/discord/0.0.4/server.ts`): the same five tools
(`reply`, `react`, `edit_message`, `download_attachment`, `fetch_messages`) with
identical schemas, identical result strings, identical instructions, and the
same `notifications/claude/channel` inbound shape.

The difference is invisible to the agent: the shim opens **no discord.js
gateway**. It connects to the daemon broker over a local unix domain socket and
forwards everything.

```
inbound   daemon → shim  →  emit MCP notifications/claude/channel  →  ack
outbound  agent tool call  →  forward to daemon  →  return result verbatim
```

## How it's wired into a session

A broker-pilot session is launched with the shim swapped in for the plugin:

```
claude --mcp-config <broker-mcp.json> --strict-mcp-config --dangerously-load-development-channels server:plugin_discord_discord
```

`broker-mcp.json` (written by `pool.ts` `prepare_broker_session`) declares one
MCP server keyed **`plugin_discord_discord`** (`SHIM_MCP_SERVER_KEY` in
`../broker/protocol.ts`) running this file. That server key is load-bearing
twice:

- The agent-visible tool names come out as `mcp__plugin_discord_discord__reply`
  etc. — byte-identical to the fleet, so reply-enforcement (#80), which matches
  on tool *name*, keeps working unchanged.
- `--dangerously-load-development-channels server:<key>` registers the server
  as an approved **channel source**. The CLI routes a server's
  `notifications/claude/channel` into the session only when a channel entry
  names the server AND carries the dev marker that flag confers. Both observed
  failure modes end in "Channel notifications skipped: …" + the shim acking a
  message the CLI discarded (permanent loss → 60s cold-start idle-zombie):
  no entry at all ("not in --channels list", #112), or a plain
  `--channels server:<key>` entry without the dev marker ("not on the approved
  channels allowlist", #114). Entries match first-wins with `--channels`
  entries ahead of dev entries, so the server entry must ride the dev flag
  ONLY — a duplicate non-dev entry would shadow it.

The dev flag pops a confirmation dialog at CLI startup (accept preselected);
the daemon's start_tmux auto-keypress answers it. MCP servers don't spawn until
the dialog is answered.

The plugin path uses `--channels plugin:discord@claude-plugins-official` instead.
The two are mutually exclusive per session and chosen at bring-up.

### Registration grace (boot race)

Even with the gates cleared, the CLI attaches its channel-notification handler
shortly **after** the MCP connection completes ("Channel notifications
registered" ≈ 16ms after "Successfully connected"). A backlog message delivered
in that window is silently dropped — and acked, because the shim's notification
write succeeded and MCP notifications carry no processing receipt. The shim
therefore defers its first broker registration (which triggers backlog
delivery) until the client's `initialized` notification plus a grace period
(`LF_BROKER_REGISTER_GRACE_MS`, default 3s; bounded 30s fail-open if
`initialized` never arrives). This is a heuristic against closed-source timing
— the live pilot is the source of truth for whether it holds across CLI
versions.

Because `--strict-mcp-config` loads **only** `broker-mcp.json`, `prepare_broker_session`
also merges in any global `mcpServers` from the resolved `.claude.json` (e.g.
`playwright`) so a broker session keeps the **same MCP server set** as a plugin
session — the pilot swaps the Discord transport and nothing else. The shim's
`plugin_discord_discord` key is applied last, so it always wins.

## Env contract

| Var                 | Meaning                                    |
| ------------------- | ------------------------------------------ |
| `LF_BROKER_SOCKET`  | absolute path to the daemon's unix socket  |
| `LF_BROKER_CHANNEL` | channel_id this session owns               |
| `LF_BROKER_BOT_ID`  | owning pool bot id (selects the reply identity server-side) |
| `LF_BROKER_REGISTER_GRACE_MS` | optional; first-registration grace after MCP `initialized` (default 3000) — see "Registration grace" above |

The first three are required; missing any exits non-zero before the MCP loop
starts. The grace override is a test seam — production uses the default.

## Fail-open discipline

- A socket drop reconnects with exponential backoff (500ms → 10s); it never
  crashes the host CLI session.
- An outbound call with no live connection returns an error result string
  (`<tool> failed: broker connection unavailable`) rather than hanging.
- Outbound calls are time-bounded (20s) so a wedged daemon can't hang a tool call.
- Inbound is acked **only after** the notification is handed to the transport —
  the durability contract. No ack ⇒ the daemon redelivers.
- `unhandledRejection` / `uncaughtException` are trapped and logged to stderr so
  a stray error can't silently take the channel down.

The shim shares `../broker/protocol.ts` with the daemon side, so the wire
contract can never drift between the two ends.
