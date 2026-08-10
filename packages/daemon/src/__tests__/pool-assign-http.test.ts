/**
 * #107 path 10 — POST /pool/assign gains an optional `pending_message` and
 * refuses (422) a driverless assign on a broker-owned channel, surfacing the
 * choke-point guard honestly at the HTTP layer. Plugin channels keep today's
 * contract byte-for-byte.
 *
 * Live-HTTP harness (real route table + parser), faked pool — same pattern as
 * review-lease-routes.test.ts.
 */

import type { Server } from "node:http";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingMessage } from "../pool.js";
import type { EntityRegistry } from "../registry.js";
import { start_server } from "../server.js";

const BROKER_CHANNEL = "chan-broker-pilot";
const PLUGIN_CHANNEL = "chan-plugin";

describe("POST /pool/assign broker driver contract (#107)", () => {
  let server: Server;
  let port: number;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    assign = vi.fn().mockResolvedValue({
      bot_id: 1,
      channel_id: BROKER_CHANNEL,
      entity_id: "entity-1",
      archetype: "planner",
      session_id: "sess-1",
      tmux_session: "pool-1",
    });
    const pool = {
      assign,
      channel_uses_broker: (channel_id: string) => channel_id === BROKER_CHANNEL,
      get_status: () => ({ total: 0, free: 0, assigned: 0, parked: 0, assignments: [] }),
    } as never;

    const registry = { get_active: () => [] } as unknown as EntityRegistry;
    const config = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
    const session_manager = { get_active: () => [] } as never;
    const queue = {
      get_stats: () => ({ pending: 0, active: 0, total: 0 }),
      get_pending: () => [],
      get_active: () => [],
    } as never;

    server = start_server(
      registry,
      config,
      session_manager,
      queue,
      null, // commander
      null, // discord
      pool,
      null, // github_app
      null, // pr_watches
      null, // alert_router
      null, // review_leases
      0, // ephemeral port
    );
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function post_assign(body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${String(port)}/pool/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("broker channel WITHOUT pending_message → 422 with an explanatory error, assign() never called", async () => {
    const res = await post_assign({
      channel_id: BROKER_CHANNEL,
      entity_id: "entity-1",
      archetype: "planner",
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("broker-owned");
    expect(body.error).toContain("pending_message");
    expect(assign).not.toHaveBeenCalled();
  });

  it("broker channel WITH pending_message → 200; driver normalized and forwarded to assign()", async () => {
    const res = await post_assign({
      channel_id: BROKER_CHANNEL,
      entity_id: "entity-1",
      archetype: "planner",
      pending_message: { content: "kick off the pilot", user: "hunter" },
    });

    expect(res.status).toBe(200);
    expect(assign).toHaveBeenCalledTimes(1);
    const driver = assign.mock.calls[0]![6] as PendingMessage;
    expect(driver.content).toBe("kick off the pilot");
    expect(driver.user).toBe("hunter");
    expect(driver.channel_id).toBe(BROKER_CHANNEL); // stamped server-side
    expect(driver.message_id).toBe("");
    expect(driver.ts).toBeTruthy();
  });

  it("pending_message defaults: user falls back to 'http-api', ts to now", async () => {
    await post_assign({
      channel_id: BROKER_CHANNEL,
      entity_id: "entity-1",
      archetype: "planner",
      pending_message: { content: "minimal driver" },
    });
    const driver = assign.mock.calls[0]![6] as PendingMessage;
    expect(driver.user).toBe("http-api");
    expect(Number.isNaN(Date.parse(driver.ts))).toBe(false);
  });

  it("malformed pending_message (missing content) → 400, assign() never called", async () => {
    const res = await post_assign({
      channel_id: BROKER_CHANNEL,
      entity_id: "entity-1",
      archetype: "planner",
      pending_message: { user: "hunter" },
    });
    expect(res.status).toBe(400);
    expect(assign).not.toHaveBeenCalled();
  });

  it("PLUGIN channel without pending_message: contract byte-identical to today (assign called with undefined driver, 200)", async () => {
    const res = await post_assign({
      channel_id: PLUGIN_CHANNEL,
      entity_id: "entity-1",
      archetype: "planner",
      resume_session_id: "sess-old",
    });

    expect(res.status).toBe(200);
    expect(assign).toHaveBeenCalledTimes(1);
    const call = assign.mock.calls[0]!;
    expect(call[0]).toBe(PLUGIN_CHANNEL);
    expect(call[1]).toBe("entity-1");
    expect(call[2]).toBe("planner");
    expect(call[3]).toBe("sess-old");
    expect(call[6]).toBeUndefined(); // no synthesized driver on the plugin path
  });

  it("null assign (pool exhausted) still → 503, unchanged", async () => {
    assign.mockResolvedValue(null);
    const res = await post_assign({
      channel_id: PLUGIN_CHANNEL,
      entity_id: "entity-1",
      archetype: "planner",
    });
    expect(res.status).toBe(503);
  });

  it("missing required fields still → 400, unchanged", async () => {
    const res = await post_assign({ channel_id: BROKER_CHANNEL });
    expect(res.status).toBe(400);
    expect(assign).not.toHaveBeenCalled();
  });
});
