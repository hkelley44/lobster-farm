import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_INBOUND_TTL_MS,
  PendingInboundStore,
  create_pending_inbound_store,
  format_injected_inbound,
  pending_inbound_path,
} from "../pending-inbound.js";
import type { PendingMessage } from "../pool.js";

let temp_dir: string;
let path: string;
const stores: PendingInboundStore[] = [];

function make_store(now?: () => number): PendingInboundStore {
  const store = new PendingInboundStore({ path, now });
  stores.push(store);
  return store;
}

function msg(id: string, channel_id = "ch-1", content = `content ${id}`): PendingMessage {
  return { user: "ada", channel_id, message_id: id, content, ts: "2026-01-01T00:00:00.000Z" };
}

beforeEach(async () => {
  temp_dir = await mkdtemp(join(tmpdir(), "pending-inbound-test-"));
  path = join(temp_dir, "state", "pending-inbound.json");
});

afterEach(async () => {
  // Writes are fire-and-forget; let them land before the directory goes away.
  await Promise.all(stores.map((s) => s.flush()));
  stores.length = 0;
  await rm(temp_dir, { recursive: true, force: true });
});

describe("PendingInboundStore", () => {
  it("returns a channel's entries in arrival order and removes them on take", () => {
    const store = make_store();
    store.enqueue(msg("m1"), "acme", "busy");
    store.enqueue(msg("x1", "ch-2"), "acme", "busy");
    store.enqueue(msg("m2"), "acme", "assigning");

    expect(store.peek_channel("ch-1").map((e) => e.message_id)).toEqual(["m1", "m2"]);
    expect(store.depth("ch-1")).toBe(2);

    expect(store.take_channel("ch-1").map((e) => e.message_id)).toEqual(["m1", "m2"]);
    expect(store.depth("ch-1")).toBe(0);
    expect(store.total()).toBe(1);
  });

  it("orders waiting channels by their oldest message", () => {
    const store = make_store();
    store.enqueue(msg("b1", "ch-b"), "acme", "busy");
    store.enqueue(msg("a1", "ch-a"), "acme", "busy");
    store.enqueue(msg("b2", "ch-b"), "acme", "busy");

    expect(store.channels_waiting()).toEqual(["ch-b", "ch-a"]);
    expect(store.position("ch-b")).toBe(1);
    expect(store.position("ch-a")).toBe(2);
    expect(store.position("ch-none")).toBe(0);
  });

  it("front: goes ahead of its own channel's queue without disturbing other channels", () => {
    const store = make_store();
    store.enqueue(msg("x1", "ch-2"), "acme", "busy");
    store.enqueue(msg("m2"), "acme", "assigning");
    store.enqueue(msg("m3"), "acme", "assigning");
    store.enqueue(msg("m1"), "acme", "busy", { front: true });

    expect(store.peek_channel("ch-1").map((e) => e.message_id)).toEqual(["m1", "m2", "m3"]);
    expect(store.channels_waiting()).toEqual(["ch-2", "ch-1"]);

    // With nothing queued for the channel, front is just an append.
    store.enqueue(msg("y1", "ch-3"), "acme", "busy", { front: true });
    expect(store.channels_waiting()).toEqual(["ch-2", "ch-1", "ch-3"]);
  });

  it("dedupes by message id — one Discord message is never two turns", () => {
    const store = make_store();
    expect(store.enqueue(msg("m1"), "acme", "busy")).not.toBeNull();
    expect(store.enqueue(msg("m1"), "acme", "not_ready")).toBeNull();
    expect(store.depth("ch-1")).toBe(1);
    expect(store.peek_channel("ch-1")[0]?.reason).toBe("busy");
  });

  it("refuses a message with no id (nothing to dedupe or reply to)", () => {
    const store = make_store();
    expect(store.enqueue(msg(""), "acme", "busy")).toBeNull();
    expect(store.total()).toBe(0);
  });

  it("round-trips through disk, preserving order, reason and attempts", async () => {
    const store = make_store();
    store.enqueue(msg("m1"), "acme", "busy");
    store.enqueue(msg("m2"), "acme", "not_ready");
    store.note_attempt(["m1"]);
    await store.flush();

    const reloaded = make_store();
    await reloaded.load();
    const entries = reloaded.peek_channel("ch-1");
    expect(entries.map((e) => [e.message_id, e.reason, e.attempts, e.entity_id])).toEqual([
      ["m1", "busy", 1, "acme"],
      ["m2", "not_ready", 0, "acme"],
    ]);

    const on_disk = JSON.parse(await readFile(path, "utf-8")) as { version: number };
    expect(on_disk.version).toBe(1);
  });

  it("removal is durable too", async () => {
    const store = make_store();
    store.enqueue(msg("m1"), "acme", "busy");
    store.enqueue(msg("m2"), "acme", "busy");
    expect(store.remove(["m1", "nope"])).toBe(1);
    await store.flush();

    const reloaded = make_store();
    await reloaded.load();
    expect(reloaded.peek_channel("ch-1").map((e) => e.message_id)).toEqual(["m2"]);
  });

  it("loads a missing or corrupt file as empty and drops malformed entries", async () => {
    const missing = make_store();
    await missing.load();
    expect(missing.total()).toBe(0);

    await mkdir(join(temp_dir, "state"), { recursive: true });
    await writeFile(path, "not json{{{", "utf-8");
    const corrupt = make_store();
    await corrupt.load();
    expect(corrupt.total()).toBe(0);

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { ...msg("ok"), entity_id: "acme", queued_at: new Date().toISOString() },
          { message_id: "no-fields" },
          "garbage",
          { ...msg("ok"), entity_id: "acme", queued_at: new Date().toISOString() }, // dup
        ],
      }),
      "utf-8",
    );
    const partial = make_store();
    await partial.load();
    expect(partial.peek_channel("ch-1").map((e) => e.message_id)).toEqual(["ok"]);
    expect(partial.peek_channel("ch-1")[0]).toMatchObject({ attempts: 0, reason: "busy" });
  });

  it("expires entries past the TTL and returns them for alerting", () => {
    let clock = 1_000_000_000_000;
    const store = make_store(() => clock);
    store.enqueue(msg("old"), "acme", "busy");
    clock += PENDING_INBOUND_TTL_MS - 1_000;
    store.enqueue(msg("new"), "acme", "busy");

    expect(store.expire()).toEqual([]);

    clock += 2_000; // "old" is now just past 24h
    const expired = store.expire();
    expect(expired.map((e) => e.message_id)).toEqual(["old"]);
    expect(store.peek_channel("ch-1").map((e) => e.message_id)).toEqual(["new"]);
  });

  it("load keeps already-expired entries so the drain can alert on them", async () => {
    await mkdir(join(temp_dir, "state"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [{ ...msg("ancient"), entity_id: "acme", queued_at: "2020-01-01T00:00:00.000Z" }],
      }),
      "utf-8",
    );
    const store = make_store();
    await store.load();
    expect(store.total()).toBe(1);
    expect(store.expire().map((e) => e.message_id)).toEqual(["ancient"]);
  });

  it("the factory builds the path from config and loads what is there", async () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Test" },
      paths: { lobsterfarm_dir: temp_dir },
    });
    expect(pending_inbound_path(config)).toBe(path);

    const first = await create_pending_inbound_store(config);
    stores.push(first);
    first.enqueue(msg("m1"), "acme", "busy");
    await first.flush();

    const second = await create_pending_inbound_store(config);
    expect(second.depth("ch-1")).toBe(1);
  });
});

describe("format_injected_inbound", () => {
  it("gives the agent what it needs to reply: channel, sender, chat_id, message id", () => {
    const text = format_injected_inbound([msg("111", "ch-9", "ship it")], "general");
    expect(text).toContain("#general");
    expect(text).toContain("from ada");
    expect(text).toContain("chat_id=ch-9");
    expect(text).toContain("message_id 111");
    expect(text).toContain("ship it");
  });

  it("is a single line — a raw newline through send-keys would submit early", () => {
    const text = format_injected_inbound(
      [msg("1", "ch-1", "line one\nline two\r\n\n  line three"), msg("2")],
      null,
    );
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain("line one ⏎ line two ⏎ line three");
    expect(text.indexOf("message_id 1]")).toBeLessThan(text.indexOf("message_id 2]"));
    expect(text).toContain("2 Discord messages");
  });

  it("truncates a very long body and points at the original", () => {
    const text = format_injected_inbound([msg("77", "ch-1", "x".repeat(5_000))], "general");
    expect(text.length).toBeLessThan(2_000);
    expect(text).toContain("fetch message_id 77");
  });
});
