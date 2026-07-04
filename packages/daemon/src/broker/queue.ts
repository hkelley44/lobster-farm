/**
 * Durable per-channel inbound queue for the Discord broker.
 *
 * Every inbound message the daemon's gateway receives for a broker-owned
 * channel is enqueued here BEFORE any delivery attempt. Delivery is confirmed
 * by an explicit ack from the shim; unacked entries are redelivered a bounded
 * number of times, then dead-lettered with an alert. The queue is persisted to
 * disk (atomic write-temp-then-rename, same pattern as persistence.ts) so a
 * daemon restart mid-flight re-loads the backlog and resumes delivery — no
 * stranded messages (backlog item (d)).
 *
 * The queue is transport-agnostic: it does not know about sockets or REST. It
 * exposes `enqueue`, `pending_for` (what to deliver), `mark_delivered`, `ack`,
 * and a `sweep` that surfaces redelivery + dead-letter decisions. The IPC
 * server drives it; this module owns durability and retry accounting only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InboundMeta } from "./protocol.js";

/** Lifecycle of a queued inbound message. */
export type QueueEntryStatus = "pending" | "delivered" | "dead";

export interface QueueEntry {
  /** Stable queue id — the shim echoes this in its ack. */
  id: string;
  channel_id: string;
  /** Owning pool bot — selects the per-bot token for any outbound reply. */
  bot_id: number;
  content: string;
  meta: InboundMeta;
  /** ISO timestamp of enqueue. */
  enqueued_at: string;
  /** Number of times we've handed this to a shim (delivery attempts). */
  deliveries: number;
  status: QueueEntryStatus;
  /** Epoch ms of the last delivery attempt (0 if never delivered). Drives the
   * redelivery timer — a `pending`/`delivered` entry is eligible for redelivery
   * once `redeliver_after_ms` has elapsed since this. */
  last_delivery_ms: number;
}

/** On-disk shape. Versioned so the format can evolve without a silent misread. */
interface PersistedQueue {
  version: 1;
  entries: QueueEntry[];
}

export interface QueueOptions {
  /** Absolute path to the queue's JSON file. */
  path: string;
  /** Max delivery attempts before dead-lettering. `N` means the entry is
   * delivered at most N times; the attempt after the budget is spent
   * dead-letters instead of sending again. Default 5. */
  max_deliveries?: number;
  /** Ms to wait after a delivery before it's eligible for redelivery. Default 30s. */
  redeliver_after_ms?: number;
  /** Called when an entry exhausts retries and is dead-lettered. Fire-and-forget. */
  on_dead_letter?: (entry: QueueEntry) => void;
}

const DEFAULT_MAX_DELIVERIES = 5;
const DEFAULT_REDELIVER_AFTER_MS = 30_000;

export class BrokerQueue {
  private entries = new Map<string, QueueEntry>();
  private readonly path: string;
  private readonly max_deliveries: number;
  private readonly redeliver_after_ms: number;
  private readonly on_dead_letter?: (entry: QueueEntry) => void;

  // Coalesced persistence — mirrors persist-queue.ts semantics: one write at a
  // time, a follow-up write folded in if a mutation lands mid-write. Since we
  // always persist full state, coalescing loses nothing.
  private write_pending = false;
  /** The in-flight persist loop, if one is running. `flush()` awaits this so a
   * graceful shutdown (and tests) can be sure no write lands after teardown. */
  private write_loop: Promise<void> | null = null;

  constructor(opts: QueueOptions) {
    this.path = opts.path;
    this.max_deliveries = opts.max_deliveries ?? DEFAULT_MAX_DELIVERIES;
    this.redeliver_after_ms = opts.redeliver_after_ms ?? DEFAULT_REDELIVER_AFTER_MS;
    this.on_dead_letter = opts.on_dead_letter;
  }

  /** Load persisted entries from disk. Missing/corrupt file → empty queue.
   * Call once at daemon start before serving any shim. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const data: unknown = JSON.parse(raw);
      if (
        typeof data === "object" &&
        data !== null &&
        "entries" in data &&
        Array.isArray((data as PersistedQueue).entries)
      ) {
        this.entries.clear();
        for (const e of (data as PersistedQueue).entries) {
          // Drop dead-lettered entries on reload — they've already alerted and
          // are not redelivered. Keeps the durable file from growing unbounded.
          if (e.status === "dead") continue;
          // Reset a "delivered" entry to "pending" on restart: the shim that was
          // handed the message is gone (its session process died with the
          // daemon's old lifecycle), so nothing will ack it — redeliver.
          this.entries.set(e.id, { ...e, status: "pending" });
        }
      }
    } catch {
      // ENOENT or corrupt — start empty. Never throw into daemon startup.
      this.entries.clear();
    }
  }

  /** Enqueue an inbound message. Returns the created entry. Persists async. */
  enqueue(input: {
    channel_id: string;
    bot_id: number;
    content: string;
    meta: InboundMeta;
  }): QueueEntry {
    const entry: QueueEntry = {
      id: randomUUID(),
      channel_id: input.channel_id,
      bot_id: input.bot_id,
      content: input.content,
      meta: input.meta,
      enqueued_at: new Date().toISOString(),
      deliveries: 0,
      status: "pending",
      last_delivery_ms: 0,
    };
    this.entries.set(entry.id, entry);
    this.schedule_persist();
    return entry;
  }

  /**
   * Entries eligible to (re)deliver to a channel's shim right now, oldest first.
   * An entry qualifies when it is not dead and either has never been delivered
   * or its redelivery window has elapsed since the last attempt.
   */
  deliverable_for(channel_id: string, now_ms = Date.now()): QueueEntry[] {
    const out: QueueEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.channel_id !== channel_id || e.status === "dead") continue;
      const due = e.status === "pending" || now_ms - e.last_delivery_ms >= this.redeliver_after_ms;
      if (due) out.push(e);
    }
    return out.sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
  }

  /**
   * Record a delivery attempt. If the entry has already used its full attempt
   * budget, dead-letters it (fires on_dead_letter) and returns `dead` WITHOUT
   * consuming another attempt — the caller must not send. Otherwise it counts
   * this attempt and returns `delivered` so the caller sends.
   *
   * `max_deliveries: N` means at most N delivery attempts: the budget is
   * checked BEFORE it is consumed, so the entry is delivered exactly N times
   * (attempts 1..N), and the next `mark_delivered` after the budget is spent
   * dead-letters instead of sending an (N+1)th time. Checking before consuming
   * — rather than incrementing then testing `>=` — matters because the caller
   * (`server.deliver`) skips the actual send when this returns `dead`; testing
   * after the increment would drop the Nth real delivery.
   */
  mark_delivered(id: string, now_ms = Date.now()): QueueEntryStatus | null {
    const e = this.entries.get(id);
    if (!e || e.status === "dead") return e?.status ?? null;

    // Budget already spent (N attempts made, still unacked) → dead-letter now,
    // without counting or sending an (N+1)th attempt.
    if (e.deliveries >= this.max_deliveries) {
      e.status = "dead";
      this.schedule_persist();
      try {
        this.on_dead_letter?.(e);
      } catch {
        // A failing alert sink must not break queue accounting.
      }
      return "dead";
    }

    e.deliveries += 1;
    e.last_delivery_ms = now_ms;
    e.status = "delivered";
    this.schedule_persist();
    return "delivered";
  }

  /** Acknowledge delivery — removes the entry permanently. Idempotent. */
  ack(id: string): boolean {
    const existed = this.entries.delete(id);
    if (existed) this.schedule_persist();
    return existed;
  }

  /** Drop every entry for a channel (e.g., the channel was released). */
  clear_channel(channel_id: string): number {
    let removed = 0;
    for (const [id, e] of this.entries) {
      if (e.channel_id === channel_id) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.schedule_persist();
    return removed;
  }

  /** All live (non-dead) entries — for diagnostics/tests. */
  all(): QueueEntry[] {
    return [...this.entries.values()];
  }

  /** Count of live entries for a channel. */
  depth(channel_id: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.channel_id === channel_id && e.status !== "dead") n += 1;
    }
    return n;
  }

  /**
   * Wait for all pending writes to fully drain. Use during graceful shutdown
   * (and tests) — once this resolves, no further write will land, so the file
   * reflects the latest state and it's safe to tear down. If a mutation lands
   * while draining, its coalesced write is awaited too.
   */
  async flush(): Promise<void> {
    // Ensure at least one write captures the current state, then wait for the
    // loop (including any coalesced follow-up) to quiesce.
    this.schedule_persist();
    while (this.write_loop) {
      await this.write_loop;
    }
  }

  // ── Persistence (coalesced, atomic) ──

  private schedule_persist(): void {
    if (this.write_loop) {
      // A loop is already running — fold this mutation into a follow-up write.
      this.write_pending = true;
      return;
    }
    this.write_loop = this.run_persist_loop().finally(() => {
      this.write_loop = null;
    });
  }

  private async run_persist_loop(): Promise<void> {
    // Drain until no follow-up is pending. Each iteration snapshots + writes the
    // full current state, so a mutation that arrives mid-write is captured next.
    do {
      this.write_pending = false;
      try {
        await this.persist_now();
      } catch (err) {
        console.error(
          `[broker-queue] Persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } while (this.write_pending);
  }

  private async persist_now(): Promise<void> {
    const state: PersistedQueue = { version: 1, entries: [...this.entries.values()] };
    const tmp = `${this.path}.${randomUUID().slice(0, 8)}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmp, this.path);
  }
}
