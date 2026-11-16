/**
 * Durable pending-inbound queue for plugin-transport channels.
 *
 * On the plugin transport the daemon only *observes* inbound Discord messages —
 * the session's own Discord plugin is what hands them to the agent, and a
 * Discord gateway never replays a message to a client that was not connected
 * when it was sent. So every window in which the daemon has seen a message but
 * no plugin is listening for it is a silent loss:
 *
 *   - `busy`      — every pool bot is at the eviction floor, `assign()` returned
 *                   null. The old reply ("will be picked up when a slot opens")
 *                   was untrue: nothing stored the message.
 *   - `assigning` — a second message arrived while the first message's
 *                   `assign()` was still in flight. Same null, same loss.
 *   - `not_ready` — a session is assigned but has not yet shown that its plugin
 *                   is connected (cold start, or a resume that has not run a
 *                   turn). The daemon used to trust the plugin regardless.
 *
 * This store is where those messages wait. The pool drains it
 * (`BotPool.drain_pending_inbound`): a channel with no session gets one, with
 * its oldest message as the first turn; a channel with a live session gets the
 * rest typed into its prompt. An entry leaves the store only when it has been
 * handed over, was provably delivered by the plugin after all (its message id
 * is in the session transcript), or expires — and expiry raises an alert.
 *
 * Broker channels never come here — `BotPool.queue_inbound` refuses them: the
 * broker has its own durable queue with a real ack (`broker/queue.ts`).
 *
 * Everything here is fail-open. A persist failure is logged and swallowed, a
 * corrupt file loads as empty — the store must never throw into the Discord
 * message handler or the health-monitor loop.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import { PENDING_INBOUND_FILE, write_json_atomic } from "./persistence.js";
import type { PendingMessage } from "./pool.js";

/** Why the daemon could not rely on the plugin for this message. */
export type PendingInboundReason = "busy" | "assigning" | "not_ready";

export interface PendingInboundEntry extends PendingMessage {
  entity_id: string;
  /** ISO timestamp of when the daemon queued the message. */
  queued_at: string;
  /** Hand-over attempts so far (assign or inject). Diagnostic only. */
  attempts: number;
  reason: PendingInboundReason;
}

interface PersistedPendingInbound {
  version: 1;
  entries: PendingInboundEntry[];
}

/** Entries older than this are dropped (with an alert) rather than delivered. */
export const PENDING_INBOUND_TTL_MS = 24 * 60 * 60 * 1000;

/** How an inbound message was routed when the daemon first saw it. */
export type InboundOutcome =
  | "plugin"
  | "broker"
  | "first_turn"
  | "queued_busy"
  | "queued_assigning"
  | "queued_not_ready"
  | "commander"
  | "ignored";

/** How a queued (or probed) inbound message was finally settled. */
export type InboundResolution =
  | "first_turn"
  | "injected"
  | "plugin_delivered"
  | "redelivered"
  | "expired";

/**
 * One structured line per inbound message, at the moment the daemon decides
 * where it goes. Together with `log_inbound_resolved` this makes "what happened
 * to message X" a single grep.
 */
export function log_inbound_outcome(
  channel_id: string,
  message_id: string,
  outcome: InboundOutcome,
): void {
  console.log(`[inbound] channel=${channel_id} message=${message_id} outcome=${outcome}`);
}

/** One structured line when a queued/probed inbound is settled. */
export function log_inbound_resolved(message_id: string, resolved: InboundResolution): void {
  console.log(`[inbound] message=${message_id} resolved=${resolved}`);
}

/** Longest injected message body. tmux `send-keys` types the text into the
 * input box; past this the agent is told to fetch the original by id. */
const MAX_INJECTED_CONTENT = 1500;

/**
 * Render queued messages as the text typed into a session's prompt.
 *
 * Each message carries a header with everything the agent needs to answer
 * through the Discord reply tool (`chat_id`, `message_id`), in the order the
 * messages arrived. Newlines are flattened: the text goes in through tmux
 * `send-keys`, where a raw newline is an Enter and would submit a half-typed
 * message.
 */
export function format_injected_inbound(
  messages: readonly PendingMessage[],
  channel_name: string | null,
): string {
  const label = channel_name ? `#${channel_name}` : "channel";
  const blocks = messages.map((m) => {
    const flat = neutralize(m.content).trim();
    const body =
      flat.length > MAX_INJECTED_CONTENT
        ? `${flat.slice(0, MAX_INJECTED_CONTENT)}… [truncated — fetch message_id ${m.message_id} for the full text]`
        : flat;
    return `[Discord · ${label} · from ${neutralize(m.user)} · chat_id=${m.channel_id} · message_id ${m.message_id}] ${body}`;
  });
  const lead =
    messages.length > 1
      ? `${String(messages.length)} Discord messages reached the daemon but not this session — answer each with the Discord reply tool: `
      : "A Discord message reached the daemon but not this session — answer it with the Discord reply tool: ";
  return lead + blocks.join(" ‖ ");
}

/**
 * Make user-controlled text safe to embed in the injected line.
 *
 * - Any line break — including a lone carriage return, which a terminal treats
 *   as Enter — becomes a visible marker, so the text cannot submit early.
 * - The block separator and the header opener are defused, so a message body
 *   cannot forge a second "[Discord · … · from someone-else …]" block.
 */
function neutralize(text: string): string {
  return text
    .replace(/\s*(?:\r\n|\r|\n)\s*/g, " ⏎ ")
    .replace(/‖/g, "|")
    .replace(/\[Discord ·/g, "(Discord ·");
}

function is_entry(value: unknown): value is PendingInboundEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.message_id === "string" &&
    e.message_id.length > 0 &&
    typeof e.channel_id === "string" &&
    typeof e.entity_id === "string" &&
    typeof e.user === "string" &&
    typeof e.content === "string" &&
    typeof e.queued_at === "string"
  );
}

const REASONS: readonly PendingInboundReason[] = ["busy", "assigning", "not_ready"];

export class PendingInboundStore {
  private readonly path: string;
  private readonly config: LobsterFarmConfig | undefined;
  private readonly now: () => number;
  /** Arrival order is array order. */
  private entries: PendingInboundEntry[] = [];

  // Coalesced persistence — same shape as broker/queue.ts: one write at a time,
  // a mutation that lands mid-write is folded into a follow-up write.
  private write_pending = false;
  private write_loop: Promise<void> | null = null;

  /**
   * @param opts.path   Absolute path of the JSON file.
   * @param opts.config Pass when `path` was derived from `config.paths`, so the
   *                    `NODE_ENV=test` state-root guard applies to writes.
   * @param opts.now    Clock, injectable for tests.
   */
  constructor(opts: { path: string; config?: LobsterFarmConfig; now?: () => number }) {
    this.path = opts.path;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Load persisted entries. Missing or corrupt file → empty store; malformed
   * entries are dropped individually. Entries that are already past the TTL
   * are kept: the pool's first drain pass expires them, and that is where the
   * alert is raised (Discord is not connected yet when this runs).
   */
  async load(): Promise<void> {
    this.entries = [];
    try {
      const raw = await readFile(this.path, "utf-8");
      const data: unknown = JSON.parse(raw);
      const list =
        typeof data === "object" && data !== null && "entries" in data
          ? (data as { entries: unknown }).entries
          : null;
      if (Array.isArray(list)) {
        const seen = new Set<string>();
        for (const candidate of list) {
          if (!is_entry(candidate) || seen.has(candidate.message_id)) continue;
          seen.add(candidate.message_id);
          this.entries.push({
            ...candidate,
            // Only what delivery cannot do without is required above. The rest
            // is repaired rather than used as a reason to discard a message
            // the daemon already accepted.
            ts: typeof candidate.ts === "string" ? candidate.ts : candidate.queued_at,
            attempts: typeof candidate.attempts === "number" ? candidate.attempts : 0,
            reason: REASONS.includes(candidate.reason) ? candidate.reason : "busy",
          });
        }
      }
    } catch {
      // ENOENT or corrupt — start empty. Never throw into daemon startup.
    }
  }

  /**
   * Queue a message. Returns false (and changes nothing) when a message with
   * the same id is already queued — Discord can redeliver a MESSAGE_CREATE
   * after a gateway resume, and one message must never become two turns.
   */
  enqueue(
    message: PendingMessage,
    entity_id: string,
    reason: PendingInboundReason,
    opts?: { front?: boolean },
  ): PendingInboundEntry | null {
    if (!message.message_id) return null;
    if (this.entries.some((e) => e.message_id === message.message_id)) return null;
    const entry: PendingInboundEntry = {
      user: message.user,
      channel_id: message.channel_id,
      message_id: message.message_id,
      content: message.content,
      ts: message.ts,
      entity_id,
      queued_at: new Date(this.now()).toISOString(),
      attempts: 0,
      reason,
    };
    // `front`: ahead of the channel's other queued messages. Used for a
    // message that arrived first but only failed over to the queue after later
    // ones were already parked behind its in-flight assign.
    const first_of_channel = opts?.front
      ? this.entries.findIndex((e) => e.channel_id === message.channel_id)
      : -1;
    if (first_of_channel >= 0) this.entries.splice(first_of_channel, 0, entry);
    else this.entries.push(entry);
    this.schedule_persist();
    return entry;
  }

  /** Queued entries for a channel, in arrival order. Does not remove them. */
  peek_channel(channel_id: string): PendingInboundEntry[] {
    return this.entries.filter((e) => e.channel_id === channel_id);
  }

  /** Remove and return every queued entry for a channel, in arrival order. */
  take_channel(channel_id: string): PendingInboundEntry[] {
    const taken = this.peek_channel(channel_id);
    if (taken.length > 0) this.remove(taken.map((e) => e.message_id));
    return taken;
  }

  /** Remove entries by message id. Returns how many were removed. */
  remove(message_ids: readonly string[]): number {
    const ids = new Set(message_ids);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !ids.has(e.message_id));
    const removed = before - this.entries.length;
    if (removed > 0) this.schedule_persist();
    return removed;
  }

  /** Record a failed hand-over attempt for these entries. */
  note_attempt(message_ids: readonly string[]): void {
    const ids = new Set(message_ids);
    let touched = false;
    for (const e of this.entries) {
      if (ids.has(e.message_id)) {
        e.attempts++;
        touched = true;
      }
    }
    if (touched) this.schedule_persist();
  }

  /** Channels with queued entries, ordered by their oldest entry. */
  channels_waiting(): string[] {
    const seen: string[] = [];
    for (const e of this.entries) {
      if (!seen.includes(e.channel_id)) seen.push(e.channel_id);
    }
    return seen;
  }

  /** Number of queued entries for a channel. */
  depth(channel_id: string): number {
    return this.peek_channel(channel_id).length;
  }

  /** Total queued entries across all channels. */
  total(): number {
    return this.entries.length;
  }

  /** 1-based position of a channel among the waiting channels, 0 if absent. */
  position(channel_id: string): number {
    return this.channels_waiting().indexOf(channel_id) + 1;
  }

  /**
   * Drop entries older than the TTL and return them. The caller alerts — a
   * message the daemon accepted and then never delivered must not vanish
   * quietly.
   */
  expire(ttl_ms: number = PENDING_INBOUND_TTL_MS): PendingInboundEntry[] {
    const cutoff = this.now() - ttl_ms;
    const expired = this.entries.filter((e) => {
      const queued = Date.parse(e.queued_at);
      // An unparseable timestamp can never age out on its own — treat it as
      // expired rather than carry it forever.
      return Number.isNaN(queued) || queued < cutoff;
    });
    if (expired.length > 0) this.remove(expired.map((e) => e.message_id));
    return expired;
  }

  /** Wait for all pending writes to land. Use at shutdown and in tests. */
  async flush(): Promise<void> {
    this.schedule_persist();
    while (this.write_loop) {
      await this.write_loop;
    }
  }

  private schedule_persist(): void {
    if (this.write_loop) {
      this.write_pending = true;
      return;
    }
    this.write_loop = this.run_persist_loop().finally(() => {
      this.write_loop = null;
      // A mutation can land after the loop's last `write_pending` check but
      // before this callback runs. It saw a live loop and only set the flag;
      // without this relaunch that write would wait for the next mutation —
      // and be lost if the daemon died first.
      if (this.write_pending) this.schedule_persist();
    });
  }

  private async run_persist_loop(): Promise<void> {
    do {
      this.write_pending = false;
      try {
        const state: PersistedPendingInbound = { version: 1, entries: [...this.entries] };
        await write_json_atomic(this.path, state, this.config);
      } catch (err) {
        // Deliberate swallow: the in-memory queue stays authoritative for this
        // daemon's lifetime, and a transient disk error must not break message
        // handling. The cost is durability across a restart, which is logged.
        console.error(
          `[pending-inbound] Persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } while (this.write_pending);
  }
}

/** Absolute path of the store's state file for this config. */
export function pending_inbound_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), "state", PENDING_INBOUND_FILE);
}

/**
 * Build and load the store for a daemon. Kept out of `index.ts` so the wiring
 * is reachable from tests. Never throws: `load()` treats an unreadable file as
 * empty.
 */
export async function create_pending_inbound_store(
  config: LobsterFarmConfig,
): Promise<PendingInboundStore> {
  const store = new PendingInboundStore({ path: pending_inbound_path(config), config });
  await store.load();
  return store;
}
