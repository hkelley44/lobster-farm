import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRReviewCron } from "../pr-cron.js";
import { ReviewLeaseStore } from "../review-lease.js";

// Integration coverage for the cron arm of the #60 review mutex. Exercises the
// real PRReviewCron.review_pr acquire/skip path against a shared lease store —
// the same store Tidus's manual SOP and the webhook handler contend on.

vi.mock("../issue-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../issue-utils.js")>("../issue-utils.js");
  return {
    ...actual,
    extract_linked_issues: vi.fn(() => []),
    fetch_issue_context: vi.fn(async () => ""),
  };
});

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  cronCheckInStart: vi.fn(() => "checkin-id"),
  cronCheckInFinish: vi.fn(),
}));

const REPO_PATH = "/tmp/test-repo";
const REPO_URL = "https://github.com/test-org/lobster-farm.git";
const OWNER_REPO = "test-org/lobster-farm";

function make_entity(): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: "lobster-farm",
      name: "lobster-farm",
      memory: { path: "~/.lobsterfarm/entities/lobster-farm" },
      secrets: { vault_name: "entity-lobster-farm" },
      channels: { category_id: "111111111111111111", list: [] },
      repos: [{ name: "lobster-farm", url: REPO_URL, path: REPO_PATH }],
    },
  });
}

const OPEN_PR = {
  number: 6010,
  title: "Test PR",
  headRefName: "feature/test",
  updatedAt: "2026-06-27T10:00:00Z",
  url: "https://github.com/test-org/lobster-farm/pull/6010",
  body: "Closes #1",
  author: { login: "testuser" },
  isDraft: false,
};

/** Exposes the private review_pr and injects a session-manager spy + lease store. */
class TestCron extends PRReviewCron {
  spawn_spy = vi.fn().mockResolvedValue({ session_id: "sess-cron-1" });

  constructor(leases: ReviewLeaseStore) {
    const session_manager = {
      spawn: undefined as unknown,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    super(
      { get: () => make_entity(), get_active: () => [make_entity()] } as never,
      session_manager as never,
      LobsterFarmConfigSchema.parse({ user: { name: "Test" } }),
      null,
      null,
      null,
      null,
      leases,
    );
    // Wire the spawn spy after super() so `this` is available.
    session_manager.spawn = this.spawn_spy;
  }

  run_review_pr(): Promise<void> {
    type Fn = (
      entity_id: string,
      repo_path: string,
      pr: typeof OPEN_PR,
      entity_config: EntityConfig,
    ) => Promise<void>;
    const fn = (this as unknown as { review_pr: Fn }).review_pr.bind(this);
    return fn("lobster-farm", REPO_PATH, OPEN_PR, make_entity());
  }
}

describe("PRReviewCron review mutex (#60)", () => {
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log_spy.mockRestore();
    vi.restoreAllMocks();
  });

  it("cron acquires the lease before spawning — a later tidus acquire collides (409 path)", async () => {
    const leases = new ReviewLeaseStore();
    const cron = new TestCron(leases);

    await cron.run_review_pr();

    // Cron spawned a reviewer and holds the lease.
    expect(cron.spawn_spy).toHaveBeenCalledTimes(1);
    expect(leases.get(OWNER_REPO, OPEN_PR.number)?.holder).toBe("daemon-cron");

    // Tidus's manual SOP would acquire over HTTP — the store returns conflict,
    // which the route maps to 409.
    const tidus = leases.acquire(OWNER_REPO, OPEN_PR.number, "tidus-manual");
    expect(tidus.ok).toBe(false);
    if (!tidus.ok) expect(tidus.current_lease.holder).toBe("daemon-cron");
  });

  it("cron skips the spawn when the lease is already held (e.g. by tidus)", async () => {
    const leases = new ReviewLeaseStore();
    // Tidus grabbed the lease first.
    leases.acquire(OWNER_REPO, OPEN_PR.number, "tidus-manual");

    const cron = new TestCron(leases);
    await cron.run_review_pr();

    // No reviewer spawned — the cron backed off this tick.
    expect(cron.spawn_spy).not.toHaveBeenCalled();
    // Tidus's lease is untouched.
    expect(leases.get(OWNER_REPO, OPEN_PR.number)?.holder).toBe("tidus-manual");
  });

  it("releases the lease when the reviewer session completes", async () => {
    const leases = new ReviewLeaseStore();
    const cron = new TestCron(leases);

    // Capture the on('session:completed') handler the cron registers.
    const on_calls: Array<[string, (...args: unknown[]) => void]> = [];
    const sm = (cron as unknown as { session_manager: { on: ReturnType<typeof vi.fn> } })
      .session_manager;
    sm.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      on_calls.push([event, handler]);
    });

    await cron.run_review_pr();
    expect(leases.get(OWNER_REPO, OPEN_PR.number)?.holder).toBe("daemon-cron");

    // Fire the completion handler — lease must be released.
    const completed = on_calls.find(([e]) => e === "session:completed")?.[1];
    expect(completed).toBeDefined();
    completed!({ session_id: "sess-cron-1", exit_code: 0 });

    expect(leases.get(OWNER_REPO, OPEN_PR.number)).toBeNull();
  });
});
