/**
 * DiscordBroker — the daemon-side facade that wires the durable queue, the
 * unix-socket IPC server, and per-bot REST outbound into one lifecycle object.
 *
 * The daemon owns exactly one broker. discord.ts feeds it inbound (`feed()`)
 * for broker-owned channels; pool.ts registers channel ownership so the broker
 * knows which per-bot token to use for outbound and which state dir holds it.
 *
 * Everything is fail-open: `feed()` swallows its own errors (an enqueue failure
 * must never break the daemon's message-handling hot path), and the server /
 * outbound layers never throw into the daemon.
 */

import { join } from "node:path";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { OutboundExecutor, type ReplyChunkConfig } from "./outbound.js";
import { BROKER_SOCKET_RELATIVE } from "./protocol.js";
import type { InboundMeta } from "./protocol.js";
import { BrokerQueue, type QueueEntry } from "./queue.js";
import { BrokerServer } from "./server.js";

/** Ownership record for a broker-owned channel: which bot owns it and where its
 * token / attachment inbox live. Registered by pool.ts at bring-up. */
export interface ChannelOwnership {
  bot_id: number;
  /** Directory holding the bot's `.env` (its DISCORD_BOT_TOKEN). */
  state_dir: string;
  /** Reply chunking config (mirrors the bot's access.json fields). */
  chunk_config: ReplyChunkConfig;
}

/** Sink for a dead-lettered inbound — routed to #alerts by the daemon. */
export type DeadLetterAlert = (entry: QueueEntry) => void | Promise<void>;

export interface DiscordBrokerOptions {
  config: LobsterFarmConfig;
  /** Called when a message exhausts redelivery. Wire to alert-router. */
  on_dead_letter?: DeadLetterAlert;
  /** Test seams. */
  socket_path?: string;
  queue_path?: string;
  fetch_impl?: typeof fetch;
  /** Override the queue's redelivery window (ms). Tests only. */
  redeliver_after_ms?: number;
  /** Override the server's redelivery sweep interval (ms). Tests only. */
  sweep_interval_ms?: number;
}

export class DiscordBroker {
  private readonly queue: BrokerQueue;
  private readonly server: BrokerServer;
  private readonly executor: OutboundExecutor;
  /** The resolved IPC socket path — the injected `opts.socket_path` if given,
   * else the default under lobsterfarm_dir. Stored so the getter returns exactly
   * what the server bound (getter can't recompute or it would ignore injection). */
  private readonly _socket_path: string;
  /** channel_id → ownership. The broker's source of truth for outbound identity. */
  private readonly ownership = new Map<string, ChannelOwnership>();
  private started = false;

  constructor(opts: DiscordBrokerOptions) {
    const dir = lobsterfarm_dir(opts.config.paths);
    this._socket_path = opts.socket_path ?? join(dir, BROKER_SOCKET_RELATIVE);
    const queue_path = opts.queue_path ?? join(dir, "state", "broker-queue.json");

    this.executor = new OutboundExecutor(opts.fetch_impl);
    this.queue = new BrokerQueue({
      path: queue_path,
      redeliver_after_ms: opts.redeliver_after_ms,
      on_dead_letter: (entry) => {
        try {
          void opts.on_dead_letter?.(entry);
        } catch {
          // never let an alert failure break queue accounting
        }
      },
    });
    this.server = new BrokerServer({
      socket_path: this._socket_path,
      queue: this.queue,
      sweep_interval_ms: opts.sweep_interval_ms,
      outbound: (channel_id, _bot_id, tool, args) => this.execute_outbound(channel_id, tool, args),
    });
  }

  /** Absolute path to the IPC socket — used by pool.ts to tell the shim where
   * to connect (via env var). Returns the path the server actually bound (the
   * injected `opts.socket_path` when provided, else the default), never a
   * recomputed one. */
  get socket_path(): string {
    return this._socket_path;
  }

  /** Load the durable backlog and bind the socket. On restart, any un-acked
   * message reloads and resumes delivery once its shim reconnects. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.queue.load();
    await this.server.start();
    this.started = true;
    const backlog = this.queue.all().length;
    if (backlog > 0) {
      console.log(`[broker] resumed with ${String(backlog)} queued inbound message(s)`);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.queue.flush();
    await this.server.stop();
    this.started = false;
  }

  /** Register (or update) which bot owns a channel. Idempotent. Called by
   * pool.ts whenever a broker session is assigned/resumed. */
  register_channel(channel_id: string, ownership: ChannelOwnership): void {
    this.ownership.set(channel_id, ownership);
  }

  /** Forget a channel's ownership and drop its backlog (channel released). */
  release_channel(channel_id: string): void {
    this.ownership.delete(channel_id);
    this.queue.clear_channel(channel_id);
  }

  /**
   * Forget a channel's ownership WITHOUT dropping its queued backlog (#89).
   *
   * Used by the lazy release-to-dark path: when a broker session dies or is
   * released on restart we want the channel to go dark (so `owns()` returns
   * false and the next inbound cold-recreates the session), but we must NOT ack
   * or drop any unacked inbound still in the queue. The queue's at-least-once
   * redelivery re-delivers those entries once the cold-recreated session's shim
   * registers again — no message is lost on a crash/restart. Unlike
   * `release_channel`, this leaves the durable queue untouched.
   */
  deregister_channel(channel_id: string): void {
    this.ownership.delete(channel_id);
  }

  /**
   * Enqueue an inbound Discord message for a broker-owned channel and kick a
   * delivery attempt. Fail-open: never throws — the daemon's `handle_message`
   * calls this on the hot path and must not be derailed by a broker fault.
   */
  feed(input: { channel_id: string; content: string; meta: InboundMeta }): void {
    try {
      const owner = this.ownership.get(input.channel_id);
      if (!owner) {
        // Not a broker channel (or ownership not yet registered) — ignore.
        // The plugin path handles non-broker channels unchanged.
        return;
      }
      this.queue.enqueue({
        channel_id: input.channel_id,
        bot_id: owner.bot_id,
        content: input.content,
        meta: input.meta,
      });
      this.server.notify_channel(input.channel_id);
    } catch (err) {
      console.error(
        `[broker] feed failed for ${input.channel_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** True if the channel is broker-owned (has registered ownership). */
  owns(channel_id: string): boolean {
    return this.ownership.has(channel_id);
  }

  /** Live (non-dead) queued inbound count for a channel — diagnostics/tests. */
  queue_depth(channel_id: string): number {
    return this.queue.depth(channel_id);
  }

  // ── Internal ──

  private async execute_outbound(
    channel_id: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; is_error: boolean }> {
    const owner = this.ownership.get(channel_id);
    if (!owner) {
      return { text: `${tool} failed: channel ${channel_id} not owned by broker`, is_error: true };
    }
    const inbox_dir = join(owner.state_dir, "inbox");
    return this.executor.execute(tool as never, args, {
      state_dir: owner.state_dir,
      inbox_dir,
      chunk_config: owner.chunk_config,
    });
  }
}
