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
claude --mcp-config <broker-mcp.json> --strict-mcp-config
```

`broker-mcp.json` (written by `pool.ts` `prepare_broker_session`) declares one
MCP server keyed **`plugin_discord_discord`** running this file. That server key
is load-bearing: the agent-visible tool names come out as
`mcp__plugin_discord_discord__reply` etc. — byte-identical to the fleet, so
reply-enforcement (#80), which matches on tool *name*, keeps working unchanged.

The plugin path uses `--channels plugin:discord@claude-plugins-official` instead.
The two are mutually exclusive per session and chosen at bring-up.

## Env contract

| Var                 | Meaning                                    |
| ------------------- | ------------------------------------------ |
| `LF_BROKER_SOCKET`  | absolute path to the daemon's unix socket  |
| `LF_BROKER_CHANNEL` | channel_id this session owns               |
| `LF_BROKER_BOT_ID`  | owning pool bot id (selects the reply identity server-side) |

All three are required; missing any exits non-zero before the MCP loop starts.

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
