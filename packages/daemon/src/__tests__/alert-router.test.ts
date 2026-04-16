import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import type { EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_COLOR_AMBER,
  ALERT_COLOR_GREEN,
  ALERT_COLOR_RED,
  type ActiveIncidentsState,
  AlertRouter,
  daily_thread_title,
  load_active_incidents,
  save_active_incidents,
} from "../alert-router.js";

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// ── Test infrastructure ──

/** Minimal DiscordBot mock with the methods alert-router needs. */
function make_discord_mock() {
  return {
    get_entity_channel_id: vi.fn((_entity: string, _type: string) => "alerts-channel-123"),
    send_embed: vi.fn(async () => "msg-001"),
    create_thread_from_message: vi.fn(async () => "thread-001"),
    send_to_thread: vi.fn(async () => {}),
    edit_message_embed: vi.fn(async () => true),
    find_thread_by_name: vi.fn(async () => null),
    send: vi.fn(async () => {}),
  };
}

type DiscordMock = ReturnType<typeof make_discord_mock>;

let tmp_dir: string;
let config: LobsterFarmConfig;

beforeEach(async () => {
  tmp_dir = join(tmpdir(), `alert-router-test-${randomUUID().slice(0, 8)}`);
  await mkdir(join(tmp_dir, "state"), { recursive: true });
  config = {
    paths: { lobsterfarm_dir: tmp_dir, projects_dir: tmp_dir },
  } as unknown as LobsterFarmConfig;
});

afterEach(async () => {
  await rm(tmp_dir, { recursive: true, force: true });
});

// ── daily_thread_title ──

describe("daily_thread_title", () => {
  it("formats with emoji, em dash, weekday and date", () => {
    // Wednesday, April 15, 2026
    const now = new Date(2026, 3, 15);
    expect(daily_thread_title(now)).toBe("📋 Activity — Wed Apr 15");
  });

  it("handles single-digit days", () => {
    // Sunday, January 5, 2025
    const now = new Date(2025, 0, 5);
    expect(daily_thread_title(now)).toBe("📋 Activity — Sun Jan 5");
  });
});

// ── Tier 1: action_required ──

describe("post_alert — action_required", () => {
  it("sends an embed to the alerts channel top-level", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "action_required",
      title: "⚠️ Deploy failed on main",
      body: "Workflow 'CI' failed. https://github.com/...",
    });

    expect(result.message_id).toBe("msg-001");
    expect(result.thread_id).toBeUndefined();
    expect(discord.send_embed).toHaveBeenCalledOnce();

    // Verify embed color defaults to red
    const embed_arg = discord.send_embed.mock.calls[0]![1] as EmbedBuilder;
    expect(embed_arg.data.color).toBe(ALERT_COLOR_RED);
    expect(embed_arg.data.title).toBe("⚠️ Deploy failed on main");
  });

  it("uses amber color when specified", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    await router.post_alert({
      entity_id: "test-entity",
      tier: "action_required",
      title: "Approval needed",
      body: "Agent needs human approval",
      embed_color: ALERT_COLOR_AMBER,
    });

    const embed_arg = discord.send_embed.mock.calls[0]![1] as EmbedBuilder;
    expect(embed_arg.data.color).toBe(ALERT_COLOR_AMBER);
  });
});

// ── Tier 2: routine ──

describe("post_alert — routine", () => {
  it("creates a daily thread on first event and posts there", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "routine",
      title: "PR #42 merged",
      body: "feat: add funding endpoint",
    });

    // Should have created the thread
    expect(discord.send_embed).toHaveBeenCalledOnce(); // placeholder message
    expect(discord.create_thread_from_message).toHaveBeenCalledOnce();
    expect(discord.send_to_thread).toHaveBeenCalledOnce();
    expect(result.thread_id).toBe("thread-001");
  });

  it("reuses cached thread on subsequent events", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    // First event creates the thread
    await router.post_alert({
      entity_id: "test-entity",
      tier: "routine",
      title: "PR #42 merged",
      body: "feat: add funding endpoint",
    });

    // Second event reuses the cached thread
    await router.post_alert({
      entity_id: "test-entity",
      tier: "routine",
      title: "PR #43 opened",
      body: "fix: rate limit handling",
    });

    // Thread creation should happen only once
    expect(discord.create_thread_from_message).toHaveBeenCalledOnce();
    // But send_to_thread should be called twice
    expect(discord.send_to_thread).toHaveBeenCalledTimes(2);
  });

  it("finds existing thread on daemon restart (cache miss)", async () => {
    const discord = make_discord_mock();
    discord.find_thread_by_name.mockResolvedValue("existing-thread-999");
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "routine",
      title: "PR #42 merged",
      body: "feat: add funding endpoint",
    });

    // Should NOT create a new thread
    expect(discord.create_thread_from_message).not.toHaveBeenCalled();
    // Should post to the found thread
    expect(discord.send_to_thread).toHaveBeenCalledWith(
      "existing-thread-999",
      expect.stringContaining("PR #42 merged"),
    );
    expect(result.thread_id).toBe("existing-thread-999");
  });

  it("falls back to channel if thread creation fails", async () => {
    const discord = make_discord_mock();
    discord.send_embed.mockResolvedValue(null); // embed send fails
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "routine",
      title: "PR #42 merged",
      body: "feat: add funding endpoint",
    });

    // Should fall back to direct channel send
    expect(discord.send).toHaveBeenCalledOnce();
    expect(result.message_id).toBeNull();
  });
});

// ── Tier 3: incident_open ──

describe("post_alert — incident_open", () => {
  it("posts top-level embed, creates thread, persists state", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "incident_open",
      title: "🔴 P0: NullRef in order_executor.py",
      body: "Production error affecting order execution",
    });

    expect(result.message_id).toBe("msg-001");
    expect(result.thread_id).toBe("thread-001");

    // Verify embed was sent with red color
    const embed_arg = discord.send_embed.mock.calls[0]![1] as EmbedBuilder;
    expect(embed_arg.data.color).toBe(ALERT_COLOR_RED);

    // Verify thread was created from the embed message
    expect(discord.create_thread_from_message).toHaveBeenCalledWith(
      "alerts-channel-123",
      "msg-001",
      "🔴 P0: NullRef in order_executor.py",
    );

    // Verify incident was persisted
    const incidents = await load_active_incidents(config);
    expect(incidents["thread-001"]).toBeDefined();
    expect(incidents["thread-001"]!.entity_id).toBe("test-entity");
    expect(incidents["thread-001"]!.message_id).toBe("msg-001");
  });
});

// ── Tier 3: incident_update ──

describe("post_alert — incident_update", () => {
  it("posts to the incident thread", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "incident_update",
      title: "Ray diagnosis",
      body: "Root cause: connection pool exhaustion in db/pool.py",
      incident_id: "thread-001",
    });

    expect(discord.send_to_thread).toHaveBeenCalledWith(
      "thread-001",
      "Root cause: connection pool exhaustion in db/pool.py",
    );
    expect(result.thread_id).toBe("thread-001");
  });

  it("warns and returns null when incident_id is missing", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "incident_update",
      title: "Update",
      body: "Some update",
      // no incident_id
    });

    expect(discord.send_to_thread).not.toHaveBeenCalled();
    expect(result.message_id).toBeNull();
  });
});

// ── resolve_incident ──

describe("resolve_incident", () => {
  it("edits the original embed to green and removes from state", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    // Pre-populate an active incident
    const incidents: ActiveIncidentsState = {
      "thread-001": {
        entity_id: "test-entity",
        thread_id: "thread-001",
        message_id: "msg-001",
        channel_id: "alerts-channel-123",
        title: "🔴 P0: NullRef in order_executor.py",
        created_at: new Date().toISOString(),
      },
    };
    await save_active_incidents(incidents, config);

    await router.resolve_incident("thread-001", "Fixed in PR #99");

    // Verify embed was edited to green
    expect(discord.edit_message_embed).toHaveBeenCalledOnce();
    const [ch_id, msg_id, embed] = discord.edit_message_embed.mock.calls[0]!;
    expect(ch_id).toBe("alerts-channel-123");
    expect(msg_id).toBe("msg-001");
    expect((embed as EmbedBuilder).data.color).toBe(ALERT_COLOR_GREEN);
    expect((embed as EmbedBuilder).data.title).toContain("Resolved");

    // Verify resolution message was posted to thread
    expect(discord.send_to_thread).toHaveBeenCalledWith(
      "thread-001",
      expect.stringContaining("Fixed in PR #99"),
    );

    // Verify incident was removed from persistent state
    const state = await load_active_incidents(config);
    expect(state["thread-001"]).toBeUndefined();
  });

  it("no-ops gracefully for unknown incident IDs", async () => {
    const discord = make_discord_mock();
    const router = new AlertRouter(discord as unknown as any, config);

    // Should not throw
    await router.resolve_incident("nonexistent-thread", "Fixed in PR #99");
    expect(discord.edit_message_embed).not.toHaveBeenCalled();
  });
});

// ── State persistence round-trip ──

describe("active incidents persistence", () => {
  it("round-trips through save/load", async () => {
    const incidents: ActiveIncidentsState = {
      "thread-abc": {
        entity_id: "my-entity",
        thread_id: "thread-abc",
        message_id: "msg-xyz",
        channel_id: "ch-123",
        title: "P0: Something broke",
        created_at: "2026-04-15T10:00:00.000Z",
      },
    };

    await save_active_incidents(incidents, config);
    const loaded = await load_active_incidents(config);

    expect(loaded).toEqual(incidents);
  });

  it("returns empty object when file does not exist", async () => {
    // Use a fresh config pointing to a directory with no state file
    const fresh_dir = join(tmpdir(), `alert-router-empty-${randomUUID().slice(0, 8)}`);
    await mkdir(join(fresh_dir, "state"), { recursive: true });
    const fresh_config = {
      paths: { lobsterfarm_dir: fresh_dir, projects_dir: fresh_dir },
    } as unknown as LobsterFarmConfig;

    const loaded = await load_active_incidents(fresh_config);
    expect(loaded).toEqual({});

    await rm(fresh_dir, { recursive: true, force: true });
  });
});

// ── No Discord (offline) ──

describe("post_alert — no Discord", () => {
  it("returns null message_id when Discord is null", async () => {
    const router = new AlertRouter(null, config);

    const result = await router.post_alert({
      entity_id: "test-entity",
      tier: "action_required",
      title: "Deploy failed",
      body: "...",
    });

    expect(result.message_id).toBeNull();
  });
});

// ── No alerts channel ──

describe("post_alert — no alerts channel", () => {
  it("returns null when entity has no alerts channel", async () => {
    const discord = make_discord_mock();
    discord.get_entity_channel_id.mockReturnValue(null);
    const router = new AlertRouter(discord as unknown as any, config);

    const result = await router.post_alert({
      entity_id: "missing-entity",
      tier: "action_required",
      title: "Deploy failed",
      body: "...",
    });

    expect(result.message_id).toBeNull();
    expect(discord.send_embed).not.toHaveBeenCalled();
  });
});
