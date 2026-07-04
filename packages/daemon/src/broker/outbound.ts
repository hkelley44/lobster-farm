/**
 * Broker outbound execution — daemon-side Discord REST calls using the OWNING
 * pool bot's token, so replies appear from the correct `lf-pool-N` identity.
 *
 * The shim forwards an agent tool call (reply/react/edit_message/
 * download_attachment/fetch_messages); this module performs the actual Discord
 * REST request and returns a result STRING that is byte-identical to the
 * official plugin's tool result. Parity is load-bearing: reply-enforcement's
 * transcript harvest and any downstream parsing read these strings.
 *
 * Tokens are read from the bot's `<state_dir>/.env` on demand and held only for
 * the duration of the fetch — never stored, logged, or passed around (same
 * discipline as `set_bot_profile_avatar` in discord.ts).
 *
 * All calls go through the raw Discord REST API (v10) via `fetch`, NOT a
 * discord.js gateway client. REST works even when a gateway is DEAF, which is
 * the entire point of the broker.
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { BrokerToolName } from "./protocol.js";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_CHUNK_LIMIT = 2000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const REST_TIMEOUT_MS = 15_000;

/** Reply chunking config — mirrors the fields the plugin reads from access.json. */
export interface ReplyChunkConfig {
  /** Max chars per message before splitting. Default 2000 (Discord hard cap). */
  text_chunk_limit?: number;
  /** Split on paragraph/line boundaries vs. hard char count. Default "length". */
  chunk_mode?: "length" | "newline";
  /** Which chunks get a Discord reply reference. Default "first". */
  reply_to_mode?: "off" | "first" | "all";
}

export interface OutboundContext {
  /** Directory holding the owning bot's `.env` (its DISCORD_BOT_TOKEN). */
  state_dir: string;
  /** Directory to write downloaded attachments into (the plugin uses inbox/). */
  inbox_dir: string;
  chunk_config: ReplyChunkConfig;
}

export interface OutboundResult {
  text: string;
  is_error: boolean;
}

/**
 * Split text into <=limit chunks, preferring paragraph/line/space boundaries in
 * "newline" mode. Byte-for-byte port of the official plugin's `chunk()` so the
 * message segmentation (and therefore the sent-part count in the result string)
 * matches exactly.
 */
export function chunk_text(text: string, limit: number, mode: "length" | "newline"): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    if (mode === "newline") {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** att.name is uploader-controlled — sanitize the same chars the plugin does
 * before it lands in a tool-result string. */
function safe_att_name(name: string | null | undefined, id: string): string {
  return (name ?? id).replace(/[[\]\r\n;]/g, "_");
}

/**
 * Refuse to upload the channel's own state. A byte-for-byte port of the official
 * plugin's `assertSendable` (server.ts ~L139-151): `reply`'s `files` param takes
 * ANY absolute path, so without this a session could `reply(files:["<state>/.env"])`
 * and exfil its DISCORD_BOT_TOKEN (or access.json, approved/, etc.). We reject any
 * file whose realpath resolves under `state_dir` EXCEPT under `state_dir/inbox`
 * (attachments the agent legitimately downloaded and may want to re-send).
 *
 * Async here (the plugin's is sync) because the broker's outbound path is async;
 * the semantics — realpath both sides, allow only `inbox/` under state — are
 * identical. If realpath fails (file absent, state dir absent) we return: the
 * later `stat` fails properly, or there's simply nothing to leak.
 */
async function assert_sendable(f: string, state_dir: string): Promise<void> {
  let real: string;
  let state_real: string;
  try {
    real = await realpath(f);
    state_real = await realpath(state_dir);
  } catch {
    return; // stat will fail properly; or state_dir absent → nothing to leak
  }
  const inbox = join(state_real, "inbox");
  if (real.startsWith(state_real + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`);
  }
}

/** Read the bot's token from its .env. Throws if absent — the caller turns
 * that into an error result string, never a crash. */
async function read_bot_token(state_dir: string): Promise<string> {
  const env = await readFile(join(state_dir, ".env"), "utf-8");
  const m = env.match(/DISCORD_BOT_TOKEN=(.+)/);
  const token = m?.[1]?.trim();
  if (!token) throw new Error(`No DISCORD_BOT_TOKEN in ${state_dir}/.env`);
  return token;
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string };
  timestamp: string;
  attachments: Array<{
    id: string;
    filename: string;
    size: number;
    url: string;
    content_type?: string;
  }>;
}

/**
 * Executes Discord REST calls for the broker using per-bot tokens. Injectable
 * `fetch_impl` so tests exercise every path without touching real Discord.
 */
export class OutboundExecutor {
  constructor(
    private fetch_impl: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  /** Dispatch a forwarded tool call. Never throws — a failure becomes an
   * error result string, matching the plugin's `<tool> failed: <msg>` shape. */
  async execute(
    tool: BrokerToolName,
    args: Record<string, unknown>,
    ctx: OutboundContext,
  ): Promise<OutboundResult> {
    try {
      switch (tool) {
        case "reply":
          return await this.reply(args, ctx);
        case "react":
          return await this.react(args, ctx);
        case "edit_message":
          return await this.edit_message(args, ctx);
        case "download_attachment":
          return await this.download_attachment(args, ctx);
        case "fetch_messages":
          return await this.fetch_messages(args, ctx);
        default:
          return { text: `unknown tool: ${String(tool)}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `${tool} failed: ${msg}`, is_error: true };
    }
  }

  // ── Tool implementations (result strings match the official plugin) ──

  private async reply(
    args: Record<string, unknown>,
    ctx: OutboundContext,
  ): Promise<OutboundResult> {
    const chat_id = args.chat_id as string;
    const text = args.text as string;
    const reply_to = args.reply_to as string | undefined;
    const files = (args.files as string[] | undefined) ?? [];

    if (files.length > 10) throw new Error("Discord allows max 10 attachments per message");
    for (const f of files) {
      // Exfil guard first (before we even stat): never let the bot's own state
      // (.env token, access.json, approved/) leave as an upload. Only inbox/ is
      // sendable. Mirrors the official plugin's assertSendable.
      await assert_sendable(f, ctx.state_dir);
      const st = await stat(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`);
      }
    }

    const limit = Math.max(
      1,
      Math.min(ctx.chunk_config.text_chunk_limit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT),
    );
    const mode = ctx.chunk_config.chunk_mode ?? "length";
    const reply_mode = ctx.chunk_config.reply_to_mode ?? "first";
    const chunks = chunk_text(text, limit, mode);

    const token = await read_bot_token(ctx.state_dir);
    const sent_ids: string[] = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const should_reply_to =
          reply_to != null && reply_mode !== "off" && (reply_mode === "all" || i === 0);
        const has_files = i === 0 && files.length > 0;
        const id = await this.post_message(token, chat_id, chunks[i]!, {
          reply_to: should_reply_to ? reply_to : undefined,
          files: has_files ? files : undefined,
        });
        sent_ids.push(id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `reply failed after ${sent_ids.length} of ${chunks.length} chunk(s) sent: ${msg}`,
      );
    }

    const result =
      sent_ids.length === 1
        ? `sent (id: ${sent_ids[0]})`
        : `sent ${sent_ids.length} parts (ids: ${sent_ids.join(", ")})`;
    return { text: result, is_error: false };
  }

  private async react(
    args: Record<string, unknown>,
    ctx: OutboundContext,
  ): Promise<OutboundResult> {
    const chat_id = args.chat_id as string;
    const message_id = args.message_id as string;
    const emoji = args.emoji as string;
    const token = await read_bot_token(ctx.state_dir);
    // PUT /channels/:ch/messages/:msg/reactions/:emoji/@me — emoji URL-encoded.
    await this.rest(
      token,
      "PUT",
      `/channels/${chat_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
    return { text: "reacted", is_error: false };
  }

  private async edit_message(
    args: Record<string, unknown>,
    ctx: OutboundContext,
  ): Promise<OutboundResult> {
    const chat_id = args.chat_id as string;
    const message_id = args.message_id as string;
    const text = args.text as string;
    const token = await read_bot_token(ctx.state_dir);
    const msg = await this.rest<DiscordMessage>(
      token,
      "PATCH",
      `/channels/${chat_id}/messages/${message_id}`,
      { content: text },
    );
    return { text: `edited (id: ${msg.id})`, is_error: false };
  }

  private async download_attachment(
    args: Record<string, unknown>,
    ctx: OutboundContext,
  ): Promise<OutboundResult> {
    const chat_id = args.chat_id as string;
    const message_id = args.message_id as string;
    const token = await read_bot_token(ctx.state_dir);
    const msg = await this.rest<DiscordMessage>(
      token,
      "GET",
      `/channels/${chat_id}/messages/${message_id}`,
    );
    if (msg.attachments.length === 0) {
      return { text: "message has no attachments", is_error: false };
    }
    const lines: string[] = [];
    for (const att of msg.attachments) {
      if (att.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
        );
      }
      const res = await this.fetch_impl(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const name = att.filename ?? att.id;
      const raw_ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin";
      const ext = raw_ext.replace(/[^a-zA-Z0-9]/g, "") || "bin";
      const path = join(ctx.inbox_dir, `${this.now()}-${att.id}.${ext}`);
      await mkdir(ctx.inbox_dir, { recursive: true });
      await writeFile(path, buf);
      const kb = (att.size / 1024).toFixed(0);
      lines.push(
        `  ${path}  (${safe_att_name(att.filename, att.id)}, ${att.content_type ?? "unknown"}, ${kb}KB)`,
      );
    }
    return {
      text: `downloaded ${lines.length} attachment(s):\n${lines.join("\n")}`,
      is_error: false,
    };
  }

  private async fetch_messages(
    args: Record<string, unknown>,
    ctx: OutboundContext,
  ): Promise<OutboundResult> {
    const channel = args.channel as string;
    const limit = Math.min((args.limit as number) ?? 20, 100);
    const token = await read_bot_token(ctx.state_dir);
    const msgs = await this.rest<DiscordMessage[]>(
      token,
      "GET",
      `/channels/${channel}/messages?limit=${limit}`,
    );
    // Discord returns newest-first; the plugin reverses to oldest-first.
    const arr = [...msgs].reverse();
    // Determine "me" by matching the bot's own user id (from the token's first
    // base64 segment — same trick the daemon uses elsewhere).
    const me = bot_user_id_from_token(token);
    const out =
      arr.length === 0
        ? "(no messages)"
        : arr
            .map((m) => {
              const who = m.author.id === me ? "me" : m.author.username;
              const atts = m.attachments.length > 0 ? ` +${m.attachments.length}att` : "";
              const text = m.content.replace(/[\r\n]+/g, " ⏎ ");
              return `[${new Date(m.timestamp).toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`;
            })
            .join("\n");
    return { text: out, is_error: false };
  }

  // ── REST helpers ──

  /** Post a message, optionally with a reply reference and file attachments.
   * Returns the created message id. Uses multipart when files are present. */
  private async post_message(
    token: string,
    channel_id: string,
    content: string,
    opts: { reply_to?: string; files?: string[] },
  ): Promise<string> {
    const payload: Record<string, unknown> = { content };
    if (opts.reply_to) {
      payload.message_reference = { message_id: opts.reply_to, fail_if_not_exists: false };
    }

    const url = `${DISCORD_API}/channels/${channel_id}/messages`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
      let res: Response;
      if (opts.files && opts.files.length > 0) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        for (let i = 0; i < opts.files.length; i++) {
          const path = opts.files[i]!;
          const buf = await readFile(path);
          const name = path.slice(path.lastIndexOf("/") + 1);
          form.append(`files[${i}]`, new Blob([buf]), name);
        }
        res = await this.fetch_impl(url, {
          method: "POST",
          headers: { Authorization: `Bot ${token}` },
          body: form,
          signal: controller.signal,
        });
      } else {
        res = await this.fetch_impl(url, {
          method: "POST",
          headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Discord API ${res.status}: ${body}`);
      }
      const msg = (await res.json()) as DiscordMessage;
      return msg.id;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Generic authenticated REST call. Parses JSON when a body is returned. */
  private async rest<T = unknown>(
    token: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
      const res = await this.fetch_impl(`${DISCORD_API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Discord API ${res.status}: ${text}`);
      }
      // 204 No Content (e.g. react) has no body.
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Extract a bot's user id from its token (first base64url segment decodes to
 * the snowflake). Returns null if the token isn't the expected shape. */
export function bot_user_id_from_token(token: string): string | null {
  const first = token.split(".")[0];
  if (!first) return null;
  try {
    const decoded = Buffer.from(first, "base64").toString("utf-8");
    return /^\d+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
