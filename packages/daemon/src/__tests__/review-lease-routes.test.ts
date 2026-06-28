import type { Server } from "node:http";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityRegistry } from "../registry.js";
import { ReviewLeaseStore } from "../review-lease.js";
import { start_server } from "../server.js";

// Integration coverage for the #60 review-lease HTTP API. Exercises the real
// route table + parser + ReviewLeaseStore through a live HTTP server, so a
// regression in any of those layers (route ordering, path charset, status
// codes) is caught here rather than in production.

const OWNER = "hkelley44";
const REPO = "lobster-farm";
const PR = 60;

function lease_url(port: number, suffix = "review-lease"): string {
  return `http://localhost:${String(port)}/pr/${OWNER}/${REPO}/${String(PR)}/${suffix}`;
}

describe("review-lease HTTP routes (#60)", () => {
  let server: Server;
  let port: number;
  let store: ReviewLeaseStore;

  beforeEach(async () => {
    store = new ReviewLeaseStore();
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
      null, // pool
      null, // github_app
      null, // pr_watches
      null, // alert_router
      store, // review_leases
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

  it("GET review-state reports idle then in_flight", async () => {
    const idle = await fetch(lease_url(port, "review-state"));
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ status: "idle" });

    store.acquire(`${OWNER}/${REPO}`, PR, "daemon-cron");

    const busy = await fetch(lease_url(port, "review-state"));
    const body = (await busy.json()) as { status: string; lease: { holder: string } };
    expect(body.status).toBe("in_flight");
    expect(body.lease.holder).toBe("daemon-cron");
  });

  it("POST acquires a lease (200) and returns it", async () => {
    const res = await fetch(lease_url(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "tidus-manual", session_id: "sess-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lease: { holder: string; session_id?: string } };
    expect(body.lease.holder).toBe("tidus-manual");
    expect(body.lease.session_id).toBe("sess-1");
  });

  it("cron acquires in-process → tidus POST collides with 409 + current_lease", async () => {
    // Simulate the daemon cron grabbing the lease first (in-process call).
    store.acquire(`${OWNER}/${REPO}`, PR, "daemon-cron");

    // Tidus's manual SOP tries to acquire over HTTP and must get 409.
    const res = await fetch(lease_url(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "tidus-manual" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { current_lease: { holder: string; expires_at: string } };
    expect(body.current_lease.holder).toBe("daemon-cron");
    expect(body.current_lease.expires_at).toBeTruthy();
  });

  it("POST is idempotent for the same holder (200, not 409)", async () => {
    await fetch(lease_url(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "tidus-manual" }),
    });
    const again = await fetch(lease_url(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "tidus-manual" }),
    });
    expect(again.status).toBe(200);
  });

  it("POST with an unknown holder → 400", async () => {
    const res = await fetch(lease_url(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "rogue-agent" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE releases the holder's own lease → 204", async () => {
    store.acquire(`${OWNER}/${REPO}`, PR, "tidus-manual");
    const res = await fetch(lease_url(port), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "tidus-manual" }),
    });
    expect(res.status).toBe(204);
    expect(store.get(`${OWNER}/${REPO}`, PR)).toBeNull();
  });

  it("DELETE with no lease → 404", async () => {
    const res = await fetch(lease_url(port), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "tidus-manual" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE across holders → 403, lease survives", async () => {
    store.acquire(`${OWNER}/${REPO}`, PR, "daemon-cron");
    const res = await fetch(lease_url(port), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "tidus-manual" }),
    });
    expect(res.status).toBe(403);
    expect(store.get(`${OWNER}/${REPO}`, PR)?.holder).toBe("daemon-cron");
  });

  it("parses GitHub repo charset in path segments (dots, uppercase, dashes)", async () => {
    const url = `http://localhost:${String(port)}/pr/My-Org/repo.js_v2/7/review-lease`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holder: "daemon-webhook" }),
    });
    expect(res.status).toBe(200);
    expect(store.get("My-Org/repo.js_v2", 7)?.holder).toBe("daemon-webhook");
  });
});
