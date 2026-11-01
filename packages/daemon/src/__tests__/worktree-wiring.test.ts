import { readFileSync } from "node:fs";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKTREE_LEASE_TTL_MS,
  DEFAULT_WORKTREE_OBSERVED_TTL_MS,
  make_worktree_lease_store,
} from "../worktree-lease.js";

/**
 * Guards the #105 composition root.
 *
 * Why this file exists: the store shipped once as 386 lines of fully-tested
 * dead code because the single line in `index.ts` that constructed it was
 * missing. Review re-proved the hole was still open — replacing that
 * construction with `null` left all 26 lease tests green, because no test in
 * the repo can import `index.ts` at all (it ends in a top-level `void main()`,
 * so importing it boots a daemon and binds the real port).
 *
 * Two halves, and both are needed:
 *
 *   1. `make_worktree_lease_store` unit tests — the construction *decision*
 *      (kill-switch polarity, default-on, TTL threading) now lives in a pure
 *      function, so it is directly executable.
 *   2. A structural assertion over `index.ts` source — the one thing left in
 *      the unreachable file is a call with no decisions in it, and this pins
 *      that the call is present and its result reaches both consumers.
 *
 * Half 2 is a source-text assertion, which is a weak form of test, and it is
 * used deliberately and only because `index.ts` cannot be executed. It asserts
 * the minimum that would have caught the original bug.
 */

function config_with(pr_cron?: Record<string, unknown>): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    ...(pr_cron ? { pr_cron } : {}),
  });
}

const WT = "/tmp/lf-wiring-test/worktrees/102-merge-gate-hardening";

describe("make_worktree_lease_store", () => {
  it("constructs a store when there is no pr_cron block at all", () => {
    // The default-on polarity. A machine with no pr_cron config is exactly the
    // machine most likely to collide, so "unconfigured" must mean "protected".
    const config = config_with();
    expect(config.pr_cron).toBeUndefined();

    const store = make_worktree_lease_store(config);
    expect(store).not.toBeNull();
    expect(store?.acquire(WT, "daemon-cron", "op-1").ok).toBe(true);
  });

  it("constructs a store when pr_cron exists but says nothing about the lease", () => {
    // A present block must not accidentally read as "disabled" — the check is
    // `=== false`, not a falsy test, and this pins that.
    const store = make_worktree_lease_store(config_with({ enabled: true }));
    expect(store).not.toBeNull();
  });

  it("constructs a store when the flag is explicitly on", () => {
    expect(make_worktree_lease_store(config_with({ worktree_lease_enabled: true }))).not.toBeNull();
  });

  it("constructs NO store when the flag is explicitly off", () => {
    // Off means "no store exists", not "a store that always says yes". Every
    // call site is null-guarded, so this is the pre-#105 code path.
    expect(make_worktree_lease_store(config_with({ worktree_lease_enabled: false }))).toBeNull();
  });

  it("threads both configured TTLs through to the store", () => {
    const store = make_worktree_lease_store(
      config_with({ worktree_lease_ttl_ms: 1_234_000, worktree_observed_ttl_ms: 56_000 }),
    );
    expect(store).not.toBeNull();
    if (!store) return;

    // The explicit TTL shows up on an acquired lease...
    const got = store.acquire(WT, "daemon-cron", "op-1");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.lease.ttl_ms).toBe(1_234_000);

    // ...and the observed TTL on an observed one. Two separate values so a
    // swapped pair of arguments fails rather than passing by coincidence.
    expect(store.touch_observed("/tmp/lf-wiring-test/other", "sess-x")).toBe("created");
    expect(store.get("/tmp/lf-wiring-test/other")?.ttl_ms).toBe(56_000);
  });

  it("falls back to the module defaults when the TTLs are unset", () => {
    // zod supplies defaults when a pr_cron block is present, so the no-block
    // case is the one that actually exercises the store's own defaults.
    const store = make_worktree_lease_store(config_with());
    const got = store?.acquire(WT, "daemon-cron", "op-1");
    expect(got?.ok).toBe(true);
    if (got?.ok) expect(got.lease.ttl_ms).toBe(DEFAULT_WORKTREE_LEASE_TTL_MS);

    expect(store?.touch_observed("/tmp/lf-wiring-test/other", "sess-x")).toBe("created");
    expect(store?.get("/tmp/lf-wiring-test/other")?.ttl_ms).toBe(DEFAULT_WORKTREE_OBSERVED_TTL_MS);
  });
});

// ── The composition root ──

const INDEX_SRC = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/**
 * The argument list of a call, as source text.
 *
 * Scans paren depth from the opening paren so nested calls and object literals
 * inside the argument list don't terminate it early.
 */
function call_args(src: string, opening: string): string {
  const start = src.indexOf(opening);
  if (start === -1) throw new Error(`no call to ${opening} found in index.ts`);
  let depth = 0;
  for (let i = start + opening.length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(start + opening.length, i);
    }
  }
  throw new Error(`unterminated call to ${opening} in index.ts`);
}

/** Argument names, in order, with comment-only lines and blanks dropped. */
function arg_names(args: string): string[] {
  return args
    .split(",")
    .map((a) => a.replace(/\/\/.*$/gm, "").trim())
    .filter((a) => a.length > 0);
}

describe("#105 index.ts wiring (structural — index.ts cannot be imported)", () => {
  it("imports the factory from worktree-lease.js", () => {
    expect(INDEX_SRC).toContain('import { make_worktree_lease_store } from "./worktree-lease.js";');
  });

  it("calls the factory and binds the result to worktree_leases", () => {
    // This is the exact line whose absence made #105 a no-op the first time.
    expect(INDEX_SRC).toMatch(/const\s+worktree_leases\s*=\s*make_worktree_lease_store\(config\)/);
  });

  it("passes the store to start_server, in the slot immediately before the port", () => {
    const names = arg_names(call_args(INDEX_SRC, "start_server("));

    expect(names).toContain("worktree_leases");
    // The positional hazard from this branch's own history: `worktree_leases`
    // was inserted immediately before `port`, and five test call sites that
    // passed `0` positionally silently started binding the real daemon port
    // 7749. Pinning the adjacency means a future insertion between them has to
    // acknowledge this test.
    expect(names[names.indexOf("worktree_leases") + 1]).toBe("DAEMON_PORT");
  });

  it("passes the store to the PR cron", () => {
    // Both consumers must receive the SAME store — the cron takes explicit
    // holds, the server's Stop-hook route feeds observed occupancy, and a gate
    // reading a different map from the one being written is blind to half the
    // agents on the machine. That was the #103 collider.
    const names = arg_names(call_args(INDEX_SRC, "new PRReviewCron("));
    expect(names).toContain("worktree_leases");
  });
});
