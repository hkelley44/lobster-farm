/**
 * Atomic-write failure paths: the temp file must not survive a failed write.
 *
 * Why this file exists separately from the atomic-write tests in
 * pool-persistence.test.ts: those cover the SUCCESS path ("no temp files left"
 * after a write that worked), which passes just as happily with a leaking
 * failure path. Live `~/.lobsterfarm/state/` had collected four orphaned
 * `pr-reviews.json.<hex>.tmp` files from four distinct dates — every one of
 * them complete, valid JSON, so they were left behind *after* a successful
 * `writeFile`, by a `rename` that didn't complete. Proving the fix therefore
 * requires making the write fail on purpose, which means mocking
 * `node:fs/promises`; isolating that mock here keeps it off every other suite.
 */
import { mkdir, mkdtemp, readdir, writeFile as real_write_file, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fault injection. Both hooks delegate to the real implementation unless a
// test arms them, so everything else on disk behaves normally.
const { faults } = vi.hoisted(() => ({
  faults: { write: null as Error | null, rename: null as Error | null },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.write) throw faults.write;
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) throw faults.rename;
      return actual.rename(...args);
    },
  };
});

import { save_active_incidents } from "../alert-router.js";
import { BrokerQueue } from "../broker/queue.js";
import {
  ACTIVE_INCIDENTS_FILE,
  BROKER_QUEUE_FILE,
  SENTRY_TRIAGES_FILE,
  save_deploy_triage,
  save_pool_state,
  save_pr_reviews,
  save_pr_watches,
  sweep_stale_state_temps,
} from "../persistence.js";
import { save_triage_state } from "../sentry-triage.js";

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

/** Temp-file siblings left in the state dir, if any. */
async function leftover_temps(): Promise<string[]> {
  try {
    return (await readdir(join(temp_dir, "state"))).filter((f) => f.endsWith(".tmp"));
  } catch {
    return [];
  }
}

/** Every state writer that throws on failure, so the guarantee is asserted for
 * all of them rather than only the one that happened to leak in production.
 *
 * The last two live outside persistence.ts (`alert-router.ts`,
 * `sentry-triage.ts`) and were converted to the shared helper after review —
 * they are listed here because the guarantee is per-writer, not per-module.
 * `broker/queue.ts` is the seventh and gets its own test below: it swallows
 * persist failures rather than throwing, so it cannot be asserted with
 * `rejects.toThrow`. */
const savers: { name: string; save: (config: LobsterFarmConfig) => Promise<void> }[] = [
  { name: "save_pr_reviews", save: (c) => save_pr_reviews({}, c) },
  { name: "save_pool_state", save: (c) => save_pool_state([], c) },
  { name: "save_pr_watches", save: (c) => save_pr_watches({}, c) },
  { name: "save_deploy_triage", save: (c) => save_deploy_triage({}, c) },
  { name: "save_active_incidents", save: (c) => save_active_incidents({}, c) },
  {
    name: "save_triage_state",
    save: (c) =>
      save_triage_state(
        {
          triages: {},
          stats: { total_triaged: 0, issues_created: 0, dismissed: 0, last_triage_at: "" },
        },
        c,
      ),
  },
];

describe("atomic write failure paths leave no temp file", () => {
  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "persistence-atomic-test-"));
    faults.write = null;
    faults.rename = null;
  });

  afterEach(async () => {
    faults.write = null;
    faults.rename = null;
    await rm(temp_dir, { recursive: true, force: true });
  });

  for (const { name, save } of savers) {
    it(`${name}: a failed rename removes the temp file`, async () => {
      // The production failure shape: writeFile succeeds (hence a complete,
      // valid JSON temp on disk), then rename fails.
      faults.rename = new Error("EXDEV simulated");

      await expect(save(make_config())).rejects.toThrow("EXDEV simulated");

      expect(await leftover_temps()).toEqual([]);
    });
  }

  it("a failed writeFile leaves no temp file either", async () => {
    faults.write = new Error("ENOSPC simulated");

    await expect(save_pr_reviews({}, make_config())).rejects.toThrow("ENOSPC simulated");

    expect(await leftover_temps()).toEqual([]);
  });

  it("surfaces the ORIGINAL write error, not an error from the cleanup", async () => {
    // The cleanup unlinks a file that may not exist (writeFile never created
    // it). If that ENOENT were allowed to propagate it would mask the real
    // cause and make this class of failure undebuggable.
    faults.write = new Error("ENOSPC simulated");

    await expect(save_pr_reviews({}, make_config())).rejects.toThrow("ENOSPC simulated");
  });

  it("a successful write still leaves exactly the target file", async () => {
    // Guard against "fixing" the leak by never writing: the happy path must be
    // untouched.
    await save_pr_reviews({}, make_config());

    const files = await readdir(join(temp_dir, "state"));
    expect(files).toEqual(["pr-reviews.json"]);
  });

  it("broker queue: a failed rename removes the temp file, and the failure is still swallowed", async () => {
    // The seventh writer, and the one that mattered most: broker-queue.json is
    // rewritten on every enqueue and every ack, and `run_persist_loop` catches
    // and logs persist failures. So before the shared-helper conversion a
    // failing rename here leaked a temp *silently and forever* while the daemon
    // kept running.
    //
    // Both halves of the contract are asserted: the temp is gone (the fix) and
    // the rejection is still absorbed with a log rather than propagated (what
    // the fix must not change).
    const queue_path = join(temp_dir, "state", BROKER_QUEUE_FILE);
    await mkdir(join(temp_dir, "state"), { recursive: true });
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new BrokerQueue({ path: queue_path });

    faults.rename = new Error("EXDEV simulated");
    queue.enqueue({
      channel_id: "ch-1",
      bot_id: 0,
      content: "hi",
      meta: { chat_id: "ch-1", message_id: "m1", user: "u", user_id: "1", ts: "0" },
    });

    // Resolves, not rejects — the swallow is intact.
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(error_spy).toHaveBeenCalledWith(
      expect.stringContaining("[broker-queue] Persist failed"),
    );
    expect(await leftover_temps()).toEqual([]);

    error_spy.mockRestore();
  });
});

describe("sweep_stale_state_temps", () => {
  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "persistence-sweep-test-"));
    faults.write = null;
    faults.rename = null;
  });

  afterEach(async () => {
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("removes orphaned temps and keeps real state files", async () => {
    const state_path = join(temp_dir, "state");
    await mkdir(state_path, { recursive: true });

    // The exact four names found in live state, plus the real file they
    // shadow and an unrelated file that must survive.
    const orphans = [
      "pr-reviews.json.ed346133.tmp",
      "pr-reviews.json.94e6fd31.tmp",
      "pr-reviews.json.6d7eb1b9.tmp",
      "pr-reviews.json.7d2d6563.tmp",
    ];
    for (const name of [...orphans, "pr-reviews.json", "notes.txt"]) {
      await real_write_file(join(state_path, name), "{}", "utf-8");
    }

    const removed = await sweep_stale_state_temps(make_config());

    expect(removed.sort()).toEqual([...orphans].sort());
    expect((await readdir(state_path)).sort()).toEqual(["notes.txt", "pr-reviews.json"]);
  });

  it("leaves files that only look like temps alone", async () => {
    // The pattern is anchored to our own state basenames + `.<8 hex>.tmp`, so
    // the sweep cannot claim something another tool parked in the state dir.
    const state_path = join(temp_dir, "state");
    await mkdir(state_path, { recursive: true });
    const keepers = [
      "pr-reviews.json.tmp", // no hex segment
      "pr-reviews.json.zzzzzzzz.tmp", // not hex
      "pr-reviews.json.ed34613.tmp", // 7 hex, not 8
      "pr-reviews.json.ed346133.tmp.bak", // not the suffix
      // Correct suffix shape, basename we do not own. A suffix-only pattern
      // matched this, which is what made "can never claim another tool's file"
      // an unbacked claim about a routine that deletes.
      "foo.deadbeef.tmp",
      "someone-elses.json.deadbeef.tmp",
    ];
    for (const name of keepers) {
      await real_write_file(join(state_path, name), "{}", "utf-8");
    }

    expect(await sweep_stale_state_temps(make_config())).toEqual([]);
    expect((await readdir(state_path)).sort()).toEqual([...keepers].sort());
  });

  it("sweeps temps for every registered state writer, not just the four in persistence.ts", async () => {
    // The anchored pattern trades "matches anything" for "matches a known list",
    // so the list has to actually cover all seven writers — a missing entry is a
    // silent never-swept leak rather than a loud failure.
    const state_path = join(temp_dir, "state");
    await mkdir(state_path, { recursive: true });
    const orphans = [
      "pr-reviews.json.00000001.tmp",
      "pool-state.json.00000002.tmp",
      "pr-watches.json.00000003.tmp",
      "deploy-triage.json.00000004.tmp",
      `${BROKER_QUEUE_FILE}.00000005.tmp`,
      `${ACTIVE_INCIDENTS_FILE}.00000006.tmp`,
      `${SENTRY_TRIAGES_FILE}.00000007.tmp`,
    ];
    for (const name of orphans) {
      await real_write_file(join(state_path, name), "{}", "utf-8");
    }

    expect((await sweep_stale_state_temps(make_config())).sort()).toEqual([...orphans].sort());
    expect(await readdir(state_path)).toEqual([]);
  });

  it("is a no-op when the state dir does not exist yet", async () => {
    // First boot on a fresh machine must not fail here.
    await expect(sweep_stale_state_temps(make_config())).resolves.toEqual([]);
  });

  it("refuses to sweep the real state root during tests (#102 Gap 3)", async () => {
    // The guard that `write_json_atomic` has always had, applied to the sweep.
    // Without it, any caller built on a config with no `paths` override unlinks
    // temps out of the developer's live `~/.lobsterfarm/state/` — including one
    // a running daemon is mid-`rename` on, which fails that rename with ENOENT
    // and rejects its persist. The write guard exists because a test did exactly
    // that accident (#102 Gap 3); this path deletes instead of writing.
    //
    // `homedir()` is redirected to a sandbox for the duration, so "the real
    // state root" here is a fake one holding a decoy temp. That is deliberate:
    // asserting the guard against the developer's actual state dir would mean
    // that *removing* the guard makes this very test delete live files. The
    // decoy assertion is what proves the hazard — with the guard gone, the
    // decoy is unlinked and this test fails on both counts, harmlessly.
    // Vitest's default `forks` pool gives each test file its own process, so
    // the HOME mutation cannot leak into another suite.
    expect(process.env.NODE_ENV).toBe("test");
    const fake_home = await mkdtemp(join(tmpdir(), "persistence-fake-home-"));
    const real_home = process.env.HOME;
    try {
      process.env.HOME = fake_home;
      const fake_state = join(fake_home, ".lobsterfarm", "state");
      await mkdir(fake_state, { recursive: true });
      await real_write_file(join(fake_state, "pr-reviews.json.deadbee1.tmp"), "{}", "utf-8");

      const unsafe = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
      await expect(sweep_stale_state_temps(unsafe)).rejects.toThrow(/Refusing to write\/delete/);
      expect(await readdir(fake_state)).toEqual(["pr-reviews.json.deadbee1.tmp"]);
    } finally {
      if (real_home === undefined) delete process.env.HOME;
      else process.env.HOME = real_home;
      await rm(fake_home, { recursive: true, force: true });
    }
  });
});
