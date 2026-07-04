import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InboundMeta } from "../broker/protocol.js";
import { BrokerQueue, type QueueEntry } from "../broker/queue.js";

const META: InboundMeta = {
  chat_id: "chan-1",
  message_id: "msg-1",
  user: "hunter",
  user_id: "u1",
  ts: "2026-07-03T00:00:00.000Z",
};

function enqueue_one(q: BrokerQueue, channel_id = "chan-1"): QueueEntry {
  return q.enqueue({
    channel_id,
    bot_id: 3,
    content: "hi",
    meta: { ...META, chat_id: channel_id },
  });
}

/** Wait for coalesced async persistence to settle. */
async function settle(q: BrokerQueue): Promise<void> {
  await q.flush();
}

describe("BrokerQueue", () => {
  let dir: string;
  let path: string;
  // Track every queue built in a test so afterEach can flush any in-flight
  // coalesced persist BEFORE we remove the temp dir — otherwise a late write
  // recreates the file and rmdir races on a non-empty directory.
  let built: BrokerQueue[];

  function make(opts: ConstructorParameters<typeof BrokerQueue>[0]): BrokerQueue {
    const q = new BrokerQueue(opts);
    built.push(q);
    return q;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "broker-queue-test-"));
    path = join(dir, "queue.json");
    built = [];
  });

  afterEach(async () => {
    await Promise.all(built.map((q) => q.flush().catch(() => {})));
    await rm(dir, { recursive: true, force: true });
  });

  it("enqueue persists an entry to disk (atomic write)", async () => {
    const q = make({ path });
    const entry = enqueue_one(q);
    await settle(q);

    const raw = JSON.parse(await readFile(path, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].id).toBe(entry.id);
    expect(raw.entries[0].status).toBe("pending");
    expect(raw.entries[0].deliveries).toBe(0);
  });

  it("deliverable_for returns pending entries oldest-first", async () => {
    const q = make({ path });
    const first = q.enqueue({
      channel_id: "c",
      bot_id: 1,
      content: "1",
      meta: { ...META, ts: "2026-07-03T00:00:00.000Z" },
    });
    const second = q.enqueue({
      channel_id: "c",
      bot_id: 1,
      content: "2",
      meta: { ...META, ts: "2026-07-03T00:00:01.000Z" },
    });
    const due = q.deliverable_for("c");
    expect(due.map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it("ack removes the entry permanently and is idempotent", async () => {
    const q = make({ path });
    const entry = enqueue_one(q);
    expect(q.ack(entry.id)).toBe(true);
    expect(q.ack(entry.id)).toBe(false); // already gone
    expect(q.all()).toHaveLength(0);
  });

  it("mark_delivered transitions pending → delivered and holds until redelivery window", () => {
    const q = make({ path, redeliver_after_ms: 1000 });
    const entry = enqueue_one(q);

    expect(q.mark_delivered(entry.id, 0)).toBe("delivered");
    // Immediately after delivery, not due for redelivery.
    expect(q.deliverable_for("chan-1", 500)).toHaveLength(0);
    // After the window elapses, due again.
    expect(q.deliverable_for("chan-1", 1000).map((e) => e.id)).toEqual([entry.id]);
  });

  it("dead-letters after exactly max_deliveries attempts and fires on_dead_letter once", () => {
    const dead: QueueEntry[] = [];
    const q = make({
      path,
      max_deliveries: 3,
      redeliver_after_ms: 0,
      on_dead_letter: (e) => dead.push(e),
    });
    const entry = enqueue_one(q);

    // `max_deliveries: 3` means EXACTLY 3 real delivery attempts. Attempts 1..3
    // each go out ("delivered"); the 4th call finds the budget spent and
    // dead-letters WITHOUT counting a 4th attempt (the server skips the send on
    // "dead", so a 4th increment would silently drop the 3rd real delivery).
    expect(q.mark_delivered(entry.id, 0)).toBe("delivered");
    expect(q.mark_delivered(entry.id, 1)).toBe("delivered");
    expect(q.mark_delivered(entry.id, 2)).toBe("delivered");
    // Boundary locked: after the 3rd attempt the count is exactly 3, not 4.
    expect(q.all().find((e) => e.id === entry.id)!.deliveries).toBe(3);

    expect(q.mark_delivered(entry.id, 3)).toBe("dead");
    // The dead-lettering call must NOT have inflated the attempt count past the cap.
    expect(dead).toHaveLength(1);
    expect(dead[0]!.id).toBe(entry.id);
    expect(dead[0]!.deliveries).toBe(3);
    // Dead entries are not deliverable.
    expect(q.deliverable_for("chan-1")).toHaveLength(0);
  });

  it("max_deliveries: N permits exactly N real deliveries (name matches behavior)", () => {
    // Regression pin for the off-by-one the reviewer flagged: with the old
    // `deliveries > max` guard, max_deliveries: 5 permitted 6 attempts. The name
    // says at most N — this locks that N=5 yields 5 "delivered" then "dead".
    const q = make({ path, max_deliveries: 5, redeliver_after_ms: 0 });
    const entry = enqueue_one(q);
    const results = Array.from({ length: 6 }, (_, i) => q.mark_delivered(entry.id, i));
    expect(results).toEqual([
      "delivered",
      "delivered",
      "delivered",
      "delivered",
      "delivered",
      "dead",
    ]);
  });

  it("a failing on_dead_letter sink never breaks queue accounting", () => {
    const q = make({
      path,
      max_deliveries: 1,
      on_dead_letter: () => {
        throw new Error("alert sink blew up");
      },
    });
    const entry = enqueue_one(q);
    expect(q.mark_delivered(entry.id, 0)).toBe("delivered");
    // The exhausting attempt throws inside the sink — must still return "dead".
    expect(q.mark_delivered(entry.id, 1)).toBe("dead");
  });

  it("sweep_expired dead-letters an entry past the age threshold with NO delivery attempt", () => {
    const dead: QueueEntry[] = [];
    const q = make({ path, on_dead_letter: (e) => dead.push(e) });
    const entry = enqueue_one(q);

    // Never delivered — attempt-based dead-lettering would never fire.
    expect(entry.deliveries).toBe(0);

    const enqueued_ms = Date.parse(entry.enqueued_at);
    const max_age = 10 * 60_000; // 10 min

    // Just under the threshold: not swept.
    expect(q.sweep_expired(max_age, enqueued_ms + max_age - 1)).toHaveLength(0);
    expect(q.all().find((e) => e.id === entry.id)!.status).toBe("pending");

    // At/after the threshold: dead-lettered, alert fired, still zero deliveries.
    const swept = q.sweep_expired(max_age, enqueued_ms + max_age);
    expect(swept.map((e) => e.id)).toEqual([entry.id]);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.id).toBe(entry.id);
    expect(dead[0]!.deliveries).toBe(0);
    // Dead entries are no longer deliverable.
    expect(q.deliverable_for("chan-1")).toHaveLength(0);
  });

  it("sweep_expired is idempotent — an already-dead entry is not re-alerted", () => {
    const dead: QueueEntry[] = [];
    const q = make({ path, on_dead_letter: (e) => dead.push(e) });
    const entry = enqueue_one(q);
    const t = Date.parse(entry.enqueued_at) + 10 * 60_000;

    expect(q.sweep_expired(10 * 60_000, t)).toHaveLength(1);
    // Second pass: entry is already dead → nothing swept, no second alert.
    expect(q.sweep_expired(10 * 60_000, t + 1)).toHaveLength(0);
    expect(dead).toHaveLength(1);
  });

  it("a failing on_dead_letter sink never breaks the age sweep", () => {
    const q = make({
      path,
      on_dead_letter: () => {
        throw new Error("alert sink blew up");
      },
    });
    const entry = enqueue_one(q);
    const t = Date.parse(entry.enqueued_at) + 10 * 60_000;
    // The sink throws, but the entry must still be marked dead and returned.
    const swept = q.sweep_expired(10 * 60_000, t);
    expect(swept.map((e) => e.id)).toEqual([entry.id]);
    expect(q.all().find((e) => e.id === entry.id)!.status).toBe("dead");
  });

  it("restart-reload resumes un-acked backlog and resets delivered → pending", async () => {
    // First "process lifetime": enqueue two, deliver one.
    const q1 = make({ path });
    const a = enqueue_one(q1, "chan-1");
    const b = enqueue_one(q1, "chan-1");
    q1.mark_delivered(a.id, 0); // a is "delivered" but never acked
    await settle(q1);

    // Second "process lifetime": fresh queue reloads from disk.
    const q2 = make({ path });
    await q2.load();
    const reloaded = q2.all();
    expect(reloaded).toHaveLength(2);
    // The previously-delivered entry is reset to pending — the shim that held
    // it died with the old daemon lifecycle, so it must be redelivered.
    for (const e of reloaded) expect(e.status).toBe("pending");
    // Both are immediately deliverable again.
    expect(
      q2
        .deliverable_for("chan-1")
        .map((e) => e.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it("restart-reload drops dead-lettered entries so the file doesn't grow unbounded", async () => {
    const q1 = make({ path, max_deliveries: 1 });
    const entry = enqueue_one(q1);
    q1.mark_delivered(entry.id, 0);
    q1.mark_delivered(entry.id, 1); // → dead
    await settle(q1);

    const q2 = make({ path, max_deliveries: 1 });
    await q2.load();
    expect(q2.all()).toHaveLength(0); // dead entry dropped on reload
  });

  it("clear_channel drops only the given channel's entries", async () => {
    const q = make({ path });
    enqueue_one(q, "chan-1");
    enqueue_one(q, "chan-1");
    enqueue_one(q, "chan-2");
    expect(q.clear_channel("chan-1")).toBe(2);
    expect(q.depth("chan-1")).toBe(0);
    expect(q.depth("chan-2")).toBe(1);
  });

  it("load tolerates a missing file (starts empty, never throws)", async () => {
    const q = make({ path: join(dir, "does-not-exist.json") });
    await expect(q.load()).resolves.toBeUndefined();
    expect(q.all()).toHaveLength(0);
  });

  it("load tolerates a corrupt file (starts empty, never throws)", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ this is not json", "utf-8");
    const q = make({ path });
    await expect(q.load()).resolves.toBeUndefined();
    expect(q.all()).toHaveLength(0);
  });
});
