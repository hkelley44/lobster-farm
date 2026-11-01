/**
 * Offline test harness for the four broker cold-path validations (epic #84 §4 G0.2).
 *
 * WHAT THIS IS
 * ------------
 * MEMORY's own debugging recipe for the broker is: "a ~60-line NDJSON broker
 * stand-in + real CLI in tmux is a full testbed needing no daemon or Discord".
 * This file is the daemon half of that recipe, inverted: instead of standing in
 * for the daemon, it stands in for the *shim* and runs the REAL daemon-side
 * modules — real `BrokerQueue`, real `BrokerServer`, real `DiscordBroker`
 * facade, real `protocol.ts` envelopes, over a real unix domain socket in a
 * per-test temp dir.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a daemon restart and it is not a Discord post. Two things are
 * therefore structurally outside its reach, and no assertion in here should be
 * read as covering them:
 *
 *   1. The closed-source `claude` CLI's channel-notification routing. The shim
 *      acks a notification once its *write* succeeds; the CLI can still discard
 *      it ("Channel notifications skipped: …") and the shim cannot tell. Every
 *      live-only broker bug to date (#112, #113, #114, #115) lived exactly
 *      here, and every one was missed by a mock. A ShimStandIn that acks is
 *      modelling the half of the contract that has never been the broken half.
 *   2. Anything downstream of the agent: that a reply reached Discord, that the
 *      session JSONL persisted, that one tmux session (not two) exists.
 *
 * So: this harness proves daemon-side *accounting and ordering*. Delivery to a
 * human is live-only. The test file that uses it names which is which per case.
 *
 * SAFETY
 * ------
 * Every socket and queue path is caller-supplied and expected to live under a
 * `mkdtemp` dir. Nothing here reads `~/.lobsterfarm/config.yaml`, binds
 * `state/broker.sock`, touches `state/broker-queue.json`, or resolves a real
 * bot token: `OutboundExecutor` is never reached because the harness supplies
 * its own outbound handler.
 */

import { readFile, writeFile } from "node:fs/promises";
import { type Socket, connect } from "node:net";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { DiscordBroker } from "../../broker/index.js";
import {
  type BrokerEnvelope,
  type BrokerToolName,
  type InboundMeta,
  type InboundPayload,
  NdjsonDecoder,
  encode_envelope,
} from "../../broker/protocol.js";
import { BrokerQueue, type QueueEntry } from "../../broker/queue.js";
import { BrokerServer } from "../../broker/server.js";

/** Minimal config the DiscordBroker constructor needs. `dir` is the temp root. */
export function harness_config(dir: string): LobsterFarmConfig {
  return {
    version: 1,
    paths: { projects_dir: dir, lobsterfarm_dir: dir, claude_dir: dir },
    concurrency: { max_active_sessions: 3, max_queue_depth: 20 },
    defaults: { models: {} },
    user: { name: "hunter" },
    machine: { name: "", hardware: "" },
    agents: {},
  } as unknown as LobsterFarmConfig;
}

export function make_meta(message_id: string, overrides: Partial<InboundMeta> = {}): InboundMeta {
  return {
    chat_id: "chan-cold",
    message_id,
    user: "hunter",
    user_id: "u1",
    ts: "2026-10-31T12:00:00.000Z",
    ...overrides,
  };
}

/** One inbound as observed on the wire by the shim stand-in, with arrival order. */
export interface ObservedInbound {
  payload: InboundPayload;
  /** Monotonic sequence number across the stand-in's whole lifetime. */
  seq: number;
  /** Which socket generation (connection attempt) carried it. */
  connection: number;
}

export interface ShimStandInOptions {
  socket_path: string;
  channel_id: string;
  bot_id: number;
  /**
   * What to do with each inbound.
   *   "ack"   — ack immediately (the happy path; models a CLI that accepted it)
   *   "never" — never ack (models the CLI silently discarding the notification,
   *             i.e. the #112/#114 zombie: the shim's write succeeded so the
   *             real shim WOULD ack — here we withhold it to drive redelivery)
   */
  ack_mode?: "ack" | "never";
  /** Mirror the real shim's auto-reconnect-with-backoff. Off by default so
   * tests control reconnect timing explicitly. */
  auto_reconnect?: boolean;
}

/**
 * Stand-in for `shim/discord-shim.ts`'s `BrokerClient`, trimmed to the
 * transport contract: register on connect, ack an inbound after "delivering"
 * it, correlate outbound requests by `request_id`.
 *
 * Deliberately NOT a copy of the shim: it has no MCP server, so it cannot and
 * does not model `mcp.notification()` → CLI routing. That gap is the point —
 * see the file header.
 */
export class ShimStandIn {
  private socket: Socket | null = null;
  private decoder = new NdjsonDecoder();
  private seq = 0;
  private connection_count = 0;
  private readonly ack_mode: "ack" | "never";
  private readonly auto_reconnect: boolean;

  /** Every inbound seen on the wire, in arrival order. The ordering oracle. */
  readonly inbound: ObservedInbound[] = [];
  /** Ids this stand-in actually acked. */
  readonly acked: string[] = [];

  private waiters: Array<{ want: number; resolve: () => void }> = [];
  private pending = new Map<string, (r: { text: string; is_error: boolean }) => void>();

  constructor(private readonly opts: ShimStandInOptions) {
    this.ack_mode = opts.ack_mode ?? "ack";
    this.auto_reconnect = opts.auto_reconnect ?? false;
  }

  /** Connect and send `register`, resolving once the register write is flushed. */
  async connect_and_register(): Promise<void> {
    this.connection_count += 1;
    const socket = connect(this.opts.socket_path);
    socket.setEncoding("utf-8");
    this.socket = socket;
    this.decoder = new NdjsonDecoder();

    socket.on("data", (chunk: string) => {
      const { envelopes } = this.decoder.push(chunk);
      for (const env of envelopes) this.handle(env);
    });
    socket.on("error", () => {
      /* close handles it, same as the real shim */
    });
    socket.on("close", () => {
      this.socket = null;
      if (this.auto_reconnect) void this.connect_and_register().catch(() => {});
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    this.write({
      type: "register",
      channel_id: this.opts.channel_id,
      bot_id: this.opts.bot_id,
    });
  }

  private handle(env: BrokerEnvelope): void {
    if (env.type === "inbound") {
      this.seq += 1;
      this.inbound.push({
        payload: env.payload,
        seq: this.seq,
        connection: this.connection_count,
      });
      if (this.ack_mode === "ack") {
        this.acked.push(env.payload.id);
        this.write({ type: "ack", id: env.payload.id });
      }
      for (const w of [...this.waiters]) {
        if (this.inbound.length >= w.want) {
          this.waiters = this.waiters.filter((x) => x !== w);
          w.resolve();
        }
      }
      return;
    }
    if (env.type === "outbound_response") {
      const resolve = this.pending.get(env.request_id);
      if (resolve) {
        this.pending.delete(env.request_id);
        resolve({ text: env.text, is_error: env.is_error });
      }
    }
  }

  /** Resolve once at least `n` inbound have arrived; reject on timeout. */
  wait_for_inbound(n: number, timeout_ms = 3000): Promise<void> {
    if (this.inbound.length >= n) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for ${String(n)} inbound (saw ${String(this.inbound.length)})`,
            ),
          ),
        timeout_ms,
      );
      this.waiters.push({
        want: n,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** Forward a tool call exactly as the shim does, awaiting the verbatim result. */
  request_outbound(
    tool: BrokerToolName,
    args: Record<string, unknown>,
    request_id = `req-${String(++this.seq)}`,
  ): Promise<{ text: string; is_error: boolean }> {
    return new Promise((resolve) => {
      this.pending.set(request_id, resolve);
      this.write({ type: "outbound_request", request_id, tool, args });
    });
  }

  /** Ack a specific id out of band (for "the CLI accepted it late" cases). */
  ack(id: string): void {
    this.acked.push(id);
    this.write({ type: "ack", id });
  }

  /** Abrupt socket loss — models the session process dying. */
  kill(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private write(env: BrokerEnvelope): boolean {
    if (!this.socket) return false;
    try {
      return this.socket.write(encode_envelope(env));
    } catch {
      return false;
    }
  }
}

/**
 * A `DiscordBroker` that can be torn down and brought back up against the SAME
 * socket path and the SAME durable queue file — which is the only honest
 * offline stand-in for a daemon restart that exists without restarting the
 * daemon. `restart()` goes through `stop()` (queue.flush + server.stop) and a
 * fresh constructor + `start()` (queue.load + server bind), so it exercises the
 * real persistence round-trip, not an in-memory shortcut.
 *
 * NOT equivalent to a real restart: no process boundary, no launchd, no pool
 * re-assign, no `--resume`. It proves queue durability and delivery accounting
 * only.
 */
export class RestartableBroker {
  private broker: DiscordBroker;
  readonly dead_letters: QueueEntry[] = [];
  /** Every outbound the daemon side was asked to execute, in order. */
  readonly outbound_calls: Array<{
    channel_id: string;
    tool: string;
    args: Record<string, unknown>;
  }> = [];
  private boots = 0;

  constructor(
    private readonly dir: string,
    readonly socket_path: string,
    readonly queue_path: string,
    private readonly opts: { redeliver_after_ms?: number; sweep_interval_ms?: number } = {},
  ) {
    this.broker = this.construct();
  }

  private construct(): DiscordBroker {
    this.boots += 1;
    return new DiscordBroker({
      config: harness_config(this.dir),
      socket_path: this.socket_path,
      queue_path: this.queue_path,
      ...(this.opts.redeliver_after_ms != null
        ? { redeliver_after_ms: this.opts.redeliver_after_ms }
        : {}),
      ...(this.opts.sweep_interval_ms != null
        ? { sweep_interval_ms: this.opts.sweep_interval_ms }
        : {}),
      on_dead_letter: (entry) => {
        this.dead_letters.push(entry);
      },
      // Never let the real OutboundExecutor run: it resolves a bot token from
      // <state_dir>/.env and would hit the Discord REST API. The harness records
      // the call and returns the plugin's success string shape instead.
      fetch_impl: (() => {
        throw new Error("harness: real fetch must never be reached");
      }) as unknown as typeof fetch,
    });
  }

  get current(): DiscordBroker {
    return this.broker;
  }

  get boot_count(): number {
    return this.boots;
  }

  async start(): Promise<void> {
    await this.broker.start();
  }

  async stop(): Promise<void> {
    await this.broker.stop();
  }

  /** Full stop → fresh construct → start, same socket + same queue file. */
  async restart(): Promise<void> {
    await this.broker.stop();
    this.broker = this.construct();
    await this.broker.start();
  }

  /** Read the durable queue file exactly as the daemon would on next boot. */
  async read_queue_file(): Promise<{ version: number; entries: QueueEntry[] }> {
    const raw = await readFile(this.queue_path, "utf-8");
    return JSON.parse(raw) as { version: number; entries: QueueEntry[] };
  }

  /**
   * Rewrite the durable queue file with every entry's `enqueued_at` moved back
   * by `ms`. Models daemon downtime: wall-clock advances while the daemon is
   * dead, so a restored entry's AGE includes the outage. Must be called while
   * the broker is stopped.
   */
  async backdate_queue_file(ms: number): Promise<void> {
    const data = await this.read_queue_file();
    for (const e of data.entries) {
      e.enqueued_at = new Date(Date.parse(e.enqueued_at) - ms).toISOString();
    }
    await writeFile(this.queue_path, JSON.stringify(data, null, 2), "utf-8");
  }
}

/**
 * Lower-level fixture for cases that need to control the server's age-based
 * dead-letter horizon, which `DiscordBroker` does not expose. Same real
 * modules, wired by hand the way `DiscordBroker` wires them.
 */
export function raw_broker(opts: {
  socket_path: string;
  queue_path: string;
  redeliver_after_ms?: number;
  sweep_interval_ms?: number;
  dead_letter_after_ms?: number;
  max_deliveries?: number;
  on_dead_letter?: (e: QueueEntry) => void;
  outbound?: (
    channel_id: string,
    bot_id: number,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; is_error: boolean }>;
}): { queue: BrokerQueue; server: BrokerServer } {
  const queue = new BrokerQueue({
    path: opts.queue_path,
    ...(opts.redeliver_after_ms != null ? { redeliver_after_ms: opts.redeliver_after_ms } : {}),
    ...(opts.max_deliveries != null ? { max_deliveries: opts.max_deliveries } : {}),
    ...(opts.on_dead_letter ? { on_dead_letter: opts.on_dead_letter } : {}),
  });
  const server = new BrokerServer({
    socket_path: opts.socket_path,
    queue,
    outbound: opts.outbound ?? (async () => ({ text: "ok", is_error: false })),
    ...(opts.sweep_interval_ms != null ? { sweep_interval_ms: opts.sweep_interval_ms } : {}),
    ...(opts.dead_letter_after_ms != null
      ? { dead_letter_after_ms: opts.dead_letter_after_ms }
      : {}),
  });
  return { queue, server };
}

/** Sleep helper — real timers; these tests are I/O-ordered, not timer-mocked. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
