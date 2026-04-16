import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

vi.mock("../actions.js", () => ({
  detect_review_outcome: vi.fn().mockResolvedValue("approved"),
}));

vi.mock("../persistence.js", () => ({
  load_pr_reviews: vi.fn().mockResolvedValue({}),
  save_pr_reviews: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    concurrency: { max_active_sessions: 2, max_queue_depth: 20 },
  });
}

function make_entity(github_user?: string): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: "alpha",
      name: "Alpha",
      status: "active",
      repos: [],
      accounts: github_user ? { github: { user: github_user } } : {},
      channels: { category_id: "", list: [] },
      memory: { path: "/tmp/memory" },
      secrets: { vault: "1password", vault_name: "alpha" },
    },
  });
}

// ── Tests ──

describe("PR cron — author-based alert labeling", () => {
  let alerts: string[];
  let mock_registry: {
    get: ReturnType<typeof vi.fn>;
    get_active: ReturnType<typeof vi.fn>;
    get_all: ReturnType<typeof vi.fn>;
  };
  let mock_session_manager: {
    spawn: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  let mock_alert_router: { post_alert: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    alerts = [];

    mock_registry = {
      get: vi.fn(),
      get_active: vi.fn().mockReturnValue([]),
      get_all: vi.fn().mockReturnValue([]),
    };

    mock_session_manager = {
      spawn: vi.fn().mockResolvedValue({ session_id: "test-session" }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    mock_alert_router = {
      post_alert: vi.fn().mockImplementation((payload: { title: string; body: string }) => {
        // Combine title + body for backward-compatible string assertions
        alerts.push(`${payload.title}: ${payload.body}`);
        return Promise.resolve({ message_id: null });
      }),
    };
  });

  async function create_cron() {
    const { PRReviewCron } = await import("../pr-cron.js");
    return new PRReviewCron(
      mock_registry as any,
      mock_session_manager as any,
      make_config(),
      null, // discord
      null, // github_app
      null, // pr_watches
      mock_alert_router as any,
    );
  }

  async function trigger_review(
    cron: any,
    author_login: string,
    outcome: "approved" | "changes_requested" | "pending",
  ) {
    const { detect_review_outcome } = await import("../actions.js");
    (detect_review_outcome as ReturnType<typeof vi.fn>).mockResolvedValue(outcome);

    const pr = {
      number: 42,
      title: "fix: improve session handling",
      headRefName: "fix/42-session",
      updatedAt: new Date().toISOString(),
      url: "https://github.com/org/repo/pull/42",
      author: { login: author_login },
    };

    // Access private method through any — this is the most direct way to test
    // the alert message formatting without setting up the full poll + spawn flow
    await (cron as any).handle_review_completion("alpha", "/tmp/repo", pr, outcome);
  }

  it("labels internal PR without 'External' prefix when author matches github.user", async () => {
    mock_registry.get.mockReturnValue(make_entity("test-org"));
    const cron = await create_cron();

    await trigger_review(cron, "test-org", "changes_requested");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("PR #42");
    expect(alerts[0]).not.toContain("External");
    expect(alerts[0]).not.toContain("@test-org");
  });

  it("labels external PR with 'External' prefix and @author when author differs", async () => {
    mock_registry.get.mockReturnValue(make_entity("test-org"));
    const cron = await create_cron();

    await trigger_review(cron, "contributor123", "changes_requested");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("External");
    expect(alerts[0]).toContain("@contributor123");
    expect(alerts[0]).toContain("PR #42");
  });

  it("treats all non-feature PRs as external when entity has no github.user", async () => {
    mock_registry.get.mockReturnValue(make_entity()); // No github user configured
    const cron = await create_cron();

    await trigger_review(cron, "test-org", "changes_requested");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("External");
    expect(alerts[0]).toContain("@test-org");
    expect(alerts[0]).toContain("PR #42");
  });

  it("labels approved+merged internal PR without 'External'", async () => {
    mock_registry.get.mockReturnValue(make_entity("test-org"));

    const cron = await create_cron();

    // Mock the private check_pr_merged to return true
    (cron as any).check_pr_merged = vi.fn().mockResolvedValue(true);

    await trigger_review(cron, "test-org", "approved");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("PR #42");
    expect(alerts[0]).toContain("approved and merged to main");
    expect(alerts[0]).not.toContain("External");
  });

  it("labels approved+merged external PR with 'External' and @author", async () => {
    mock_registry.get.mockReturnValue(make_entity("test-org"));
    const cron = await create_cron();

    (cron as any).check_pr_merged = vi.fn().mockResolvedValue(true);

    await trigger_review(cron, "outsider", "approved");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("External");
    expect(alerts[0]).toContain("@outsider");
    expect(alerts[0]).toContain("approved and merged to main");
  });

  it("labels approved but unmerged external PR with human merge note", async () => {
    mock_registry.get.mockReturnValue(make_entity("test-org"));
    const cron = await create_cron();

    (cron as any).check_pr_merged = vi.fn().mockResolvedValue(false);

    await trigger_review(cron, "outsider", "approved");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("awaiting human merge");
    expect(alerts[0]).toContain("@outsider");
  });

  it("still spawns fixer for both internal and external PRs needing changes", async () => {
    mock_registry.get.mockReturnValue(make_entity("test-org"));
    const cron = await create_cron();

    // Stub the fixer spawn to track calls
    const spawn_fixer = vi.fn().mockResolvedValue(undefined);
    (cron as any).spawn_external_pr_fixer = spawn_fixer;

    // Internal PR
    await trigger_review(cron, "test-org", "changes_requested");
    expect(spawn_fixer).toHaveBeenCalledTimes(1);

    // External PR
    await trigger_review(cron, "outsider", "changes_requested");
    expect(spawn_fixer).toHaveBeenCalledTimes(2);
  });
});
