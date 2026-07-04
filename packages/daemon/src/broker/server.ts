/**
 * Broker IPC server — a unix-domain-socket server the LF Discord shims connect
 * to. One connection per broker-owned session. Responsibilities:
 *
 *   - Accept a `register` envelope: learn which (channel_id, bot_id) this
 *     connection owns, then flush any backlog + start redelivery for it.
 *   - Deliver queued inbound to the owning connection (NDJSON `inbound`).
 *   - Receive `ack` → remove the entry from the durable queue.
 *   - Receive `outbound_request` → execute via per-bot REST, return the result
 *     verbatim as `outbound_response`.
 *
 * The server owns NO Discord state itself — it delegates durability to
 * BrokerQueue and REST execution to a supplied callback. It is fail-open: a
 * malformed frame, a dropped socket, or a REST error never crashes the daemon.
 *
 * A single periodic sweep drives redelivery: for each connected channel, any
 * queue entry that is due (never delivered, or past its redelivery window) is
 * re-sent. Dead-lettering happens inside the queue when the attempt budget is
 * exhausted.
 */

import { unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import {
  type BrokerEnvelope,
  NdjsonDecoder,
  type OutboundResponseEnvelope,
  encode_envelope,
} from "./protocol.js";
import type { BrokerQueue, QueueEntry } from "./queue.js";

/** Executes a forwarded tool call; returns the verbatim result. */
export type OutboundHandler = (
  channel_id: string,
  bot_id: number,
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; is_error: boolean }>;

/** A live shim connection that has registered its channel ownership. */
interface Connection {
  socket: Socket;
  decoder: NdjsonDecoder;
  channel_id: string | null;
  bot_id: number | null;
}

export interface BrokerServerOptions {
  socket_path: string;
  queue: BrokerQueue;
  outbound: OutboundHandler;
  /** Sweep interval for redelivery, ms. Default 5s. */
  sweep_interval_ms?: number;
  /**
   * Age after which a still-live queue entry is dead-lettered regardless of
   * delivery attempts, ms. Default 10 min. This is a backstop for a
   * registered-but-never-connected channel (a shim that never registers can't
   * drive delivery attempts, so attempt-based dead-lettering never fires and
   * the durable file would grow unbounded). 10 min sits comfortably above the
   * normal delivery-based dead-letter horizon (default 5 attempts × 30s
   * redelivery ≈ 2.5 min), so a normally-delivering entry always exhausts via
   * attempts first; this only catches the truly stranded ones.
   */
  dead_letter_after_ms?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_DEAD_LETTER_AFTER_MS = 10 * 60_000;

export class BrokerServer {
  private server: Server | null = null;
  private readonly socket_path: string;
  private readonly queue: BrokerQueue;
  private readonly outbound: OutboundHandler;
  private readonly sweep_interval_ms: number;
  private readonly dead_letter_after_ms: number;
  private sweep_timer: NodeJS.Timeout | null = null;

  /** All open connections. One channel may briefly have two during reconnect;
   * the newest registered wins (see `owner_for`). */
  private connections = new Set<Connection>();
  /** channel_id → the connection that most recently registered for it. */
  private owners = new Map<string, Connection>();

  constructor(opts: BrokerServerOptions) {
    this.socket_path = opts.socket_path;
    this.queue = opts.queue;
    this.outbound = opts.outbound;
    this.sweep_interval_ms = opts.sweep_interval_ms ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.dead_letter_after_ms = opts.dead_letter_after_ms ?? DEFAULT_DEAD_LETTER_AFTER_MS;
  }

  /** Bind the socket and begin serving. Removes any stale socket file first. */
  async start(): Promise<void> {
    // A previous daemon crash can leave the socket file behind; unlink so the
    // fresh bind doesn't EADDRINUSE.
    await unlink(this.socket_path).catch(() => {});

    this.server = createServer((socket) => this.on_connection(socket));
    this.server.on("error", (err) => {
      console.error(`[broker-server] socket error: ${err.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socket_path, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    this.sweep_timer = setInterval(() => this.sweep(), this.sweep_interval_ms);
    this.sweep_timer.unref();
    console.log(`[broker-server] listening on ${this.socket_path}`);
  }

  /** Stop serving and close all connections. */
  async stop(): Promise<void> {
    if (this.sweep_timer) {
      clearInterval(this.sweep_timer);
      this.sweep_timer = null;
    }
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    this.owners.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    await unlink(this.socket_path).catch(() => {});
  }

  /** Immediately attempt delivery of the channel's backlog to its owner. Called
   * when the daemon enqueues a fresh inbound so the agent sees it without
   * waiting for the next sweep. No-op if the channel has no connected shim. */
  notify_channel(channel_id: string): void {
    const conn = this.owners.get(channel_id);
    if (conn) this.deliver_backlog(conn);
  }

  /** True if a shim is currently registered for this channel. */
  has_owner(channel_id: string): boolean {
    return this.owners.has(channel_id);
  }

  // ── Connection lifecycle ──

  private on_connection(socket: Socket): void {
    const conn: Connection = {
      socket,
      decoder: new NdjsonDecoder(),
      channel_id: null,
      bot_id: null,
    };
    this.connections.add(conn);
    socket.setEncoding("utf-8");

    socket.on("data", (chunk: string) => this.on_data(conn, chunk));
    socket.on("error", () => {
      /* handled by close */
    });
    socket.on("close", () => this.on_close(conn));
  }

  private on_close(conn: Connection): void {
    this.connections.delete(conn);
    if (conn.channel_id && this.owners.get(conn.channel_id) === conn) {
      this.owners.delete(conn.channel_id);
    }
  }

  private on_data(conn: Connection, chunk: string): void {
    const { envelopes, errors } = conn.decoder.push(chunk);
    for (const msg of errors) {
      console.warn(`[broker-server] dropped malformed frame: ${msg}`);
    }
    for (const env of envelopes) {
      this.handle_envelope(conn, env);
    }
  }

  private handle_envelope(conn: Connection, env: BrokerEnvelope): void {
    switch (env.type) {
      case "register":
        this.handle_register(conn, env.channel_id, env.bot_id);
        break;
      case "ack":
        this.queue.ack(env.id);
        break;
      case "outbound_request":
        void this.handle_outbound(conn, env.request_id, env.tool, env.args);
        break;
      default:
        // inbound/outbound_response are daemon→shim only; ignore if received.
        break;
    }
  }

  private handle_register(conn: Connection, channel_id: string, bot_id: number): void {
    conn.channel_id = channel_id;
    conn.bot_id = bot_id;
    // Newest registration wins ownership — a reconnecting shim supersedes a
    // dead one. The old connection (if any) keeps its socket until it closes.
    this.owners.set(channel_id, conn);
    console.log(`[broker-server] registered channel ${channel_id} → bot ${String(bot_id)}`);
    this.deliver_backlog(conn);
  }

  private async handle_outbound(
    conn: Connection,
    request_id: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    let result: { text: string; is_error: boolean };
    try {
      if (conn.channel_id == null || conn.bot_id == null) {
        result = { text: `${tool} failed: connection not registered`, is_error: true };
      } else {
        result = await this.outbound(conn.channel_id, conn.bot_id, tool, args);
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      result = { text: `${tool} failed: ${m}`, is_error: true };
    }
    const response: OutboundResponseEnvelope = {
      type: "outbound_response",
      request_id,
      text: result.text,
      is_error: result.is_error,
    };
    this.send(conn, response);
  }

  // ── Delivery + redelivery ──

  /** Send every currently-deliverable entry for the connection's channel. */
  private deliver_backlog(conn: Connection): void {
    if (!conn.channel_id) return;
    const due = this.queue.deliverable_for(conn.channel_id);
    for (const entry of due) this.deliver(conn, entry);
  }

  private deliver(conn: Connection, entry: QueueEntry): void {
    const status = this.queue.mark_delivered(entry.id);
    if (status === "dead") return; // exhausted — dead-lettered by the queue
    const ok = this.send(conn, {
      type: "inbound",
      payload: { id: entry.id, content: entry.content, meta: entry.meta },
    });
    if (!ok) {
      // Write failed — the socket is likely gone. Don't count this as a real
      // delivery: the next sweep (or reconnect) will retry. We already bumped
      // the attempt count in mark_delivered; that's acceptable bounded cost.
    }
  }

  /**
   * Periodic pass: (1) age-based dead-letter sweep across ALL entries — this is
   * independent of connections, so it also catches a registered-but-never-
   * connected channel whose entries would otherwise never accrue delivery
   * attempts; (2) redelivery for every currently-connected channel.
   */
  private sweep(): void {
    const swept = this.queue.sweep_expired(this.dead_letter_after_ms);
    if (swept.length > 0) {
      console.warn(
        `[broker-server] age-swept ${String(swept.length)} stranded entr${swept.length === 1 ? "y" : "ies"} to dead-letter`,
      );
    }
    for (const [channel_id, conn] of this.owners) {
      const due = this.queue.deliverable_for(channel_id);
      for (const entry of due) this.deliver(conn, entry);
    }
  }

  private send(conn: Connection, env: BrokerEnvelope): boolean {
    try {
      return conn.socket.write(encode_envelope(env));
    } catch {
      return false;
    }
  }
}
