/**
 * Broker IPC protocol — the wire contract between the daemon broker and the
 * LF Discord MCP shim over a local unix domain socket.
 *
 * Framing is newline-delimited JSON (NDJSON): every message is a single JSON
 * object serialized on one line, terminated by "\n". This keeps the parser
 * trivial (split on newline) and avoids a length-prefix framing layer — the
 * payloads are small (a Discord message + metadata) and local-only.
 *
 * Direction legend (S = shim → daemon, D = daemon → shim):
 *   register          S  shim announces the (channel_id, bot_id) it owns
 *   inbound           D  daemon delivers a queued inbound message to the shim
 *   ack               S  shim confirms it emitted the MCP notification
 *   outbound_request  S  shim forwards an agent tool call (reply/react/…)
 *   outbound_response D  daemon returns the tool result verbatim
 *
 * Everything here is transport-agnostic plain data — no daemon or discord.js
 * imports — so the shim can depend on it without pulling in the daemon world.
 */

/** Path to the broker's unix domain socket, relative to the lobsterfarm dir. */
export const BROKER_SOCKET_RELATIVE = "state/broker.sock";

/**
 * The MCP server key the shim is registered under in a broker session's
 * `--mcp-config`. This single name is load-bearing twice:
 *
 *   1. Tool-name parity: the CLI prefixes tools as `mcp__<key>__<tool>`, so this
 *      key makes the shim's tools come out as `mcp__plugin_discord_discord__reply`
 *      etc. — byte-identical to the official plugin (reply-enforcement matches on
 *      these names).
 *   2. Channel routing: the CLI only routes a server's
 *      `notifications/claude/channel` notifications into the session if that
 *      server is named in its `--channels` list (tagged `server:<key>` for
 *      manually-configured MCP servers). A shim session launched WITHOUT
 *      `--channels server:<this key>` has every inbound silently skipped:
 *      "Channel notifications skipped: server plugin_discord_discord not in
 *      --channels list for this session" — the root cause of the #112
 *      idle-zombie (message delivered, dropped by the CLI, acked by the shim,
 *      permanently lost).
 *
 * pool.ts must use this constant for BOTH the mcp-config key and the
 * `--channels server:…` argument so the two can never drift apart.
 */
export const SHIM_MCP_SERVER_KEY = "plugin_discord_discord";

/** Outbound tool names the shim can forward. Byte-identical to the official
 * plugin's tool surface — the daemon executes these via per-bot REST. */
export type BrokerToolName =
  | "reply"
  | "react"
  | "edit_message"
  | "download_attachment"
  | "fetch_messages";

/** Attachment/meta shape carried on an inbound message. Mirrors the official
 * plugin's `notifications/claude/channel` `meta` object exactly. */
export interface InboundMeta {
  chat_id: string;
  message_id: string;
  user: string;
  user_id: string;
  ts: string;
  /** Present only when the message carried attachments (stringified count). */
  attachment_count?: string;
  /** Present only when the message carried attachments ("name (type, sizeKB); …"). */
  attachments?: string;
}

/** An inbound Discord message the daemon delivers to the owning shim. */
export interface InboundPayload {
  /** Unique queue id — the shim echoes this back in its ack. */
  id: string;
  /** `content` field of the MCP notification (may be empty string). */
  content: string;
  meta: InboundMeta;
}

// ── Envelopes ──

/** Shim → daemon: announce ownership of a channel. Sent on connect and on
 * every reconnect. `bot_id` selects which per-bot token executes outbound. */
export interface RegisterEnvelope {
  type: "register";
  channel_id: string;
  bot_id: number;
}

/** Daemon → shim: deliver a queued inbound message. */
export interface InboundEnvelope {
  type: "inbound";
  payload: InboundPayload;
}

/** Shim → daemon: confirm an inbound was emitted to the agent. */
export interface AckEnvelope {
  type: "ack";
  id: string;
}

/** Shim → daemon: forward an agent tool call for daemon-side REST execution. */
export interface OutboundRequestEnvelope {
  type: "outbound_request";
  /** Correlation id so the shim can match the response to the pending call. */
  request_id: string;
  tool: BrokerToolName;
  /** Raw tool arguments, passed through untouched. */
  args: Record<string, unknown>;
}

/** Daemon → shim: the tool result, returned verbatim to the agent.
 * `is_error` mirrors the MCP CallTool `isError` flag. */
export interface OutboundResponseEnvelope {
  type: "outbound_response";
  request_id: string;
  text: string;
  is_error: boolean;
}

export type BrokerEnvelope =
  | RegisterEnvelope
  | InboundEnvelope
  | AckEnvelope
  | OutboundRequestEnvelope
  | OutboundResponseEnvelope;

// ── NDJSON framing ──

/** Serialize an envelope to a single NDJSON line (JSON + trailing newline). */
export function encode_envelope(env: BrokerEnvelope): string {
  return `${JSON.stringify(env)}\n`;
}

/**
 * Stateful NDJSON decoder. Feed it raw socket chunks; it buffers partial lines
 * and yields complete envelopes. Malformed lines are skipped (returned in the
 * `errors` array) rather than throwing — a corrupt frame must never crash the
 * host session or the daemon.
 */
export class NdjsonDecoder {
  private buffer = "";

  /** Push a chunk; returns any complete envelopes parsed from it. */
  push(chunk: string): { envelopes: BrokerEnvelope[]; errors: string[] } {
    this.buffer += chunk;
    const envelopes: BrokerEnvelope[] = [];
    const errors: string[] = [];

    let newline_idx = this.buffer.indexOf("\n");
    while (newline_idx !== -1) {
      const line = this.buffer.slice(0, newline_idx);
      this.buffer = this.buffer.slice(newline_idx + 1);
      newline_idx = this.buffer.indexOf("\n");

      if (line.trim() === "") continue;
      try {
        envelopes.push(JSON.parse(line) as BrokerEnvelope);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { envelopes, errors };
  }
}
