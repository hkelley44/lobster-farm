import { mkdtemp, rm } from "node:fs/promises";
import { type Socket, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BrokerEnvelope, NdjsonDecoder, encode_envelope } from "../broker/protocol.js";
import type { InboundMeta } from "../broker/protocol.js";
import { BrokerQueue } from "../broker/queue.js";
import { BrokerServer, type OutboundHandler } from "../broker/server.js";

const META: InboundMeta = {
  chat_id: "chan-1",
  message_id: "m1",
  user: "hunter",
  user_id: "u1",
  ts: "2026-07-03T00:00:00.000Z",
};

/** A thin test client over the unix socket: collects decoded envelopes and lets
 * a test await the next one matching a predicate. */
class TestClient {
  readonly socket: Socket;
  private decoder = new NdjsonDecoder();
  private received: BrokerEnvelope[] = [];
  private waiters: Array<{
    pred: (e: BrokerEnvelope) => boolean;
    resolve: (e: BrokerEnvelope) => void;
  }> = [];

  constructor(path: string) {
    this.socket = connect(path);
    this.socket.setEncoding("utf-8");
    this.socket.on("data", (chunk: string) => {
      const { envelopes } = this.decoder.push(chunk);
      for (const env of envelopes) {
        this.received.push(env);
        const idx = this.waiters.findIndex((w) => w.pred(env));
        if (idx !== -1) {
          const [w] = this.waiters.splice(idx, 1);
          w!.resolve(env);
        }
      }
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("error", reject);
    });
  }

  send(env: BrokerEnvelope): void {
    this.socket.write(encode_envelope(env));
  }

  next(pred: (e: BrokerEnvelope) => boolean, timeout_ms = 2000): Promise<BrokerEnvelope> {
    const existing = this.received.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for envelope")),
        timeout_ms,
      );
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("BrokerServer IPC", () => {
  let dir: string;
  let socket_path: string;
  let queue: BrokerQueue;
  let server: BrokerServer;
  let client: TestClient | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "broker-server-test-"));
    socket_path = join(dir, "broker.sock");
    queue = new BrokerQueue({ path: join(dir, "queue.json"), redeliver_after_ms: 50 });
  });

  afterEach(async () => {
    client?.close();
    client = null;
    await server.stop();
    // Drain the queue's coalesced persistence before removing the temp dir —
    // otherwise a late atomic write races the rmdir (test-only teardown quirk).
    await queue.flush().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  async function start(outbound?: OutboundHandler): Promise<void> {
    server = new BrokerServer({
      socket_path,
      queue,
      outbound: outbound ?? (async () => ({ text: "ok", is_error: false })),
      sweep_interval_ms: 30, // fast sweep for redelivery tests
    });
    await server.start();
  }

  it("delivers a queued inbound to a registered shim, then acks it away", async () => {
    await start();
    const entry = queue.enqueue({ channel_id: "chan-1", bot_id: 5, content: "hi", meta: META });

    client = new TestClient(socket_path);
    await client.ready();
    client.send({ type: "register", channel_id: "chan-1", bot_id: 5 });

    const inbound = (await client.next((e) => e.type === "inbound")) as Extract<
      BrokerEnvelope,
      { type: "inbound" }
    >;
    // The delivered payload is byte-identical to the plugin's notification shape.
    expect(inbound.payload.id).toBe(entry.id);
    expect(inbound.payload.content).toBe("hi");
    expect(inbound.payload.meta).toEqual(META);

    // Ack it → the durable queue drops it.
    client.send({ type: "ack", id: entry.id });
    await vi.waitFor(() => expect(queue.all()).toHaveLength(0));
  });

  it("redelivers an un-acked message on the sweep", async () => {
    await start();
    queue.enqueue({ channel_id: "chan-1", bot_id: 5, content: "redeliver-me", meta: META });

    client = new TestClient(socket_path);
    await client.ready();
    client.send({ type: "register", channel_id: "chan-1", bot_id: 5 });

    // First delivery on register.
    await client.next((e) => e.type === "inbound");
    // Without an ack, the sweep re-delivers after the redelivery window.
    await vi.waitFor(
      () => {
        const inbounds = queue.all().filter((e) => e.deliveries >= 2);
        expect(inbounds.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );
  });

  it("round-trips an outbound_request through the handler using the connection's identity", async () => {
    const seen: Array<{ channel_id: string; bot_id: number; tool: string }> = [];
    const outbound: OutboundHandler = async (channel_id, bot_id, tool) => {
      seen.push({ channel_id, bot_id, tool });
      return { text: "sent (id: 42)", is_error: false };
    };
    await start(outbound);

    client = new TestClient(socket_path);
    await client.ready();
    client.send({ type: "register", channel_id: "chan-1", bot_id: 9 });
    client.send({
      type: "outbound_request",
      request_id: "req-1",
      tool: "reply",
      args: { chat_id: "chan-1", text: "hey" },
    });

    const resp = (await client.next((e) => e.type === "outbound_response")) as Extract<
      BrokerEnvelope,
      { type: "outbound_response" }
    >;
    expect(resp.request_id).toBe("req-1");
    expect(resp.text).toBe("sent (id: 42)");
    expect(resp.is_error).toBe(false);
    // Identity is drawn from the registered connection, not the request.
    expect(seen).toEqual([{ channel_id: "chan-1", bot_id: 9, tool: "reply" }]);
  });

  it("an outbound handler throw becomes a fail-open error response", async () => {
    const outbound: OutboundHandler = async () => {
      throw new Error("REST exploded");
    };
    await start(outbound);

    client = new TestClient(socket_path);
    await client.ready();
    client.send({ type: "register", channel_id: "chan-1", bot_id: 1 });
    client.send({ type: "outbound_request", request_id: "r", tool: "react", args: {} });

    const resp = (await client.next((e) => e.type === "outbound_response")) as Extract<
      BrokerEnvelope,
      { type: "outbound_response" }
    >;
    expect(resp.is_error).toBe(true);
    expect(resp.text).toContain("react failed: REST exploded");
  });

  it("newest registration wins ownership on reconnect", async () => {
    await start();
    queue.enqueue({ channel_id: "chan-1", bot_id: 5, content: "for-newest", meta: META });

    const first = new TestClient(socket_path);
    await first.ready();
    first.send({ type: "register", channel_id: "chan-1", bot_id: 5 });
    await first.next((e) => e.type === "inbound");
    first.close();

    // A reconnecting shim registers again and should receive the redelivered
    // (still un-acked) backlog.
    client = new TestClient(socket_path);
    await client.ready();
    client.send({ type: "register", channel_id: "chan-1", bot_id: 5 });
    const inbound = await client.next((e) => e.type === "inbound");
    expect(inbound.type).toBe("inbound");
  });
});
