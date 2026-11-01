import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityRegistry } from "../registry.js";
import { ReviewLeaseStore } from "../review-lease.js";
import { start_server } from "../server.js";

// Composition-root coverage for the #104 staging promotion.
//
// The unit tests in staging-promotion.test.ts stub git entirely. That proves
// the gates, but a green unit suite proves nothing about WIRING — a sibling
// branch on this repo shipped 386 fully-tested lines that never ran because
// the store was never instantiated in index.ts. So this file drives the real
// route table, the real ReviewLeaseStore, and REAL git against throwaway
// repositories created under the OS temp dir.
//
// Nothing here touches a real LobsterFarm repo, a real remote, or the network:
// "origin" is a local bare repo, and the only credentials involved are absent.
//
// The assertions deliberately check the BARE REPO'S REFS, not just the HTTP
// status. A refusal that still moved `main` would be a passing test over a
// broken gate.

const OWNER = "hkelley44";
const REPO = "lobster-farm";
const OWNER_REPO = `${OWNER}/${REPO}`;
const PR = 104;
const APPROVER = "Test";

const SIGNOFF = {
  approved_by: APPROVER,
  approved_at: "2026-10-31T12:00:00Z",
  source: "discord://alerts/message/123",
};

/** Run git with a deterministic identity, no global config bleed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      // Capture stderr rather than inheriting it — git's push/checkout progress
      // chatter would otherwise bury the suite's own output.
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

interface Fixture {
  root: string;
  origin: string;
  clone: string;
  main_sha: string;
  staging_sha: string;
}

/**
 * Build a throwaway origin + clone where `staging` is one commit ahead of
 * `main` — the state SOP 4a.next promotes from.
 */
function make_repo_fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "lf-staging-promo-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");

  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });

  git(clone, "commit", "--allow-empty", "-m", "base commit on main");
  git(clone, "push", "origin", "main");
  const main_sha = git(clone, "rev-parse", "HEAD");

  git(clone, "checkout", "-b", "staging");
  git(clone, "commit", "--allow-empty", "-m", "feature merged into staging");
  git(clone, "push", "origin", "staging");
  const staging_sha = git(clone, "rev-parse", "HEAD");

  // Leave the clone off both branches so nothing depends on checkout state —
  // the promotion must work purely from remote refs.
  git(clone, "checkout", "--detach", "HEAD");

  return { root, origin, clone, main_sha, staging_sha };
}

/** Where `main` actually points on the remote. The real proof. */
function origin_main(fx: Fixture): string {
  return git(fx.origin, "rev-parse", "refs/heads/main");
}

function promotion_url(port: number): string {
  return `http://localhost:${String(port)}/pr/${OWNER}/${REPO}/${String(PR)}/staging-promotion`;
}

describe("staging-promotion HTTP route (#104)", () => {
  let server: Server;
  let port: number;
  let store: ReviewLeaseStore;
  let fx: Fixture;

  beforeEach(async () => {
    fx = make_repo_fixture();
    store = new ReviewLeaseStore();

    // A registry whose single active entity owns the throwaway repo, so
    // find_entity_for_repo resolves the slug to our temp clone.
    const registry = {
      get_active: () => [
        {
          entity: {
            id: "test-entity",
            repos: [{ url: `https://github.com/${OWNER_REPO}.git`, path: fx.clone }],
          },
        },
      ],
    } as unknown as EntityRegistry;

    const config = LobsterFarmConfigSchema.parse({ user: { name: APPROVER } });
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
    rmSync(fx.root, { recursive: true, force: true });
  });

  async function post_promotion(body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(promotion_url(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it("fixture sanity: origin/main starts behind origin/staging", () => {
    expect(origin_main(fx)).toBe(fx.main_sha);
    expect(fx.staging_sha).not.toBe(fx.main_sha);
  });

  it("PROMOTES end-to-end: real HTTP → real lease → real git fast-forward", async () => {
    const { status, json } = await post_promotion({ signoff: SIGNOFF });

    expect(status).toBe(200);
    expect(json).toEqual({
      outcome: {
        kind: "promoted",
        main_sha: fx.staging_sha,
        previous_main_sha: fx.main_sha,
      },
    });

    // The ref actually moved on the remote.
    expect(origin_main(fx)).toBe(fx.staging_sha);
  });

  it("REFUSES when another review holds the lease — and main does NOT move", async () => {
    // The daemon cron is mid-review on this PR. This is the #102 property,
    // now covering the staging path: no promote while a review is in flight.
    store.acquire(OWNER_REPO, PR, "daemon-cron", { session_id: "review-7" });

    const { status, json } = await post_promotion({ signoff: SIGNOFF });

    expect(status).toBe(409);
    expect(JSON.stringify(json)).toContain("daemon-cron");

    // The real assertion: the remote is untouched.
    expect(origin_main(fx)).toBe(fx.main_sha);
  });

  it("REFUSES with no sign-off — promotion is never automatic", async () => {
    const { status } = await post_promotion({});
    expect(status).toBe(400);
    expect(origin_main(fx)).toBe(fx.main_sha);
  });

  it.each([
    ["missing approved_by", { approved_at: SIGNOFF.approved_at, source: SIGNOFF.source }],
    ["missing source", { approved_by: APPROVER, approved_at: SIGNOFF.approved_at }],
    ["blank approved_by", { ...SIGNOFF, approved_by: "  " }],
    ["non-object signoff", "yes please"],
  ])("REFUSES a malformed sign-off (%s) and leaves main alone", async (_label, signoff) => {
    const { status } = await post_promotion({ signoff });
    expect(status).toBe(400);
    expect(origin_main(fx)).toBe(fx.main_sha);
  });

  it("REFUSES a sign-off from someone who is not the configured human", async () => {
    const { status, json } = await post_promotion({
      signoff: { ...SIGNOFF, approved_by: "Ben" },
    });
    expect(status).toBe(403);
    expect(JSON.stringify(json)).toContain("signoff_unauthorized");
    expect(origin_main(fx)).toBe(fx.main_sha);
  });

  it("releases the lease after a promotion so the next review isn't blocked", async () => {
    await post_promotion({ signoff: SIGNOFF });
    expect(store.get(OWNER_REPO, PR)).toBeNull();
  });

  it("releases the lease even when the promotion is refused", async () => {
    await post_promotion({ signoff: { ...SIGNOFF, approved_by: "Ben" } });
    expect(store.get(OWNER_REPO, PR)).toBeNull();
  });

  it("is idempotent — a second sign-off relay is a no-op, not an error", async () => {
    const first = await post_promotion({ signoff: SIGNOFF });
    expect(first.status).toBe(200);

    const second = await post_promotion({ signoff: SIGNOFF });
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.json)).toContain("already_current");
    expect(origin_main(fx)).toBe(fx.staging_sha);
  });

  it("REFUSES and reports divergence when main has commits staging lacks", async () => {
    // Put a commit on origin/main that staging does not contain. SOP 4a.next
    // says escalate — never merge-commit, rebase, or force-push.
    git(fx.clone, "checkout", "-B", "diverge", fx.main_sha);
    git(fx.clone, "commit", "--allow-empty", "-m", "hotfix straight to main");
    git(fx.clone, "push", "origin", "HEAD:refs/heads/main");
    const diverged_main = origin_main(fx);
    expect(diverged_main).not.toBe(fx.main_sha);

    const { status, json } = await post_promotion({ signoff: SIGNOFF });

    expect(status).toBe(409);
    expect(JSON.stringify(json)).toContain("diverged");
    // main must be exactly where the hotfix left it — nothing force-pushed.
    expect(origin_main(fx)).toBe(diverged_main);
  });

  it("reports no_staging_branch for a main-only repo (SOP 4b)", async () => {
    git(fx.clone, "push", "origin", "--delete", "staging");

    const { status, json } = await post_promotion({ signoff: SIGNOFF });

    expect(status).toBe(404);
    expect(JSON.stringify(json)).toContain("no_staging_branch");
    expect(origin_main(fx)).toBe(fx.main_sha);
  });

  it("404s for a slug no active entity owns", async () => {
    const res = await fetch(
      `http://localhost:${String(port)}/pr/someone/else/7/staging-promotion`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signoff: SIGNOFF }),
      },
    );
    expect(res.status).toBe(404);
    expect(origin_main(fx)).toBe(fx.main_sha);
  });

  it("does not let an agent acquire the daemon-staging holder over HTTP", async () => {
    // If an agent could take this holder it would stall every promotion on a
    // 409 — or release the lease out from under one in flight.
    const res = await fetch(
      `http://localhost:${String(port)}/pr/${OWNER}/${REPO}/${String(PR)}/review-lease`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holder: "daemon-staging" }),
      },
    );
    expect(res.status).toBe(400);
    expect(store.get(OWNER_REPO, PR)).toBeNull();

    // The three legitimate holders still work.
    const ok = await fetch(
      `http://localhost:${String(port)}/pr/${OWNER}/${REPO}/${String(PR)}/review-lease`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holder: "tidus-manual" }),
      },
    );
    expect(ok.status).toBe(200);
  });

  it("does not let an agent RELEASE a daemon-staging lease over HTTP", async () => {
    store.acquire(OWNER_REPO, PR, "daemon-staging", { session_id: "promote-live" });

    const res = await fetch(
      `http://localhost:${String(port)}/pr/${OWNER}/${REPO}/${String(PR)}/review-lease`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holder: "daemon-staging" }),
      },
    );
    expect(res.status).toBe(400);
    // Still held — the in-flight promotion keeps its lease.
    expect(store.get(OWNER_REPO, PR)?.holder).toBe("daemon-staging");
  });
});
