/**
 * Tests for the empty-channel-id defensive guard on the send-family methods of
 * DiscordBot (#319).
 *
 * Background: during shutdown drain, `index.ts` was calling `discord.send("",
 * ...)` which threw inside `client.channels.fetch("")` and produced noisy 404
 * Sentry events on every clean shutdown. The fix is twofold:
 *   1) Each send-family method early-returns on empty/whitespace channel ids
 *      and emits a Sentry breadcrumb (NOT a captureException — we don't want
 *      this paging) so the offending caller is attributable.
 *   2) The shutdown caller in `index.ts` now resolves a real channel via
 *      `find_system_status_channel()` before calling send().
 *
 * These tests cover (1) — the guard. The caller fix in `index.ts` is verified
 * indirectly: the structural change (no more empty-string ternary) is plain
 * to read in the diff and there is no behavioral regression because the
 * previous code never delivered the message anyway.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn(),
      destroy: vi.fn(),
      user: null,
      channels: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
      application: null,
    })),
  };
});

import { DiscordBot } from "../discord.js";
import { EntityRegistry } from "../registry.js";
import * as sentry from "../sentry.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

/**
 * Test subclass that flips `connected = true` so the guard runs ahead of the
 * offline-mode short-circuit, and exposes the underlying discord.js channels
 * mock for assertions.
 */
class TestDiscordBot extends DiscordBot {
  constructor(config: LobsterFarmConfig, registry: EntityRegistry) {
    super(config, registry);
    (this as unknown as { connected: boolean }).connected = true;
  }

  get channels_fetch_mock() {
    return (this as unknown as { client: { channels: { fetch: ReturnType<typeof vi.fn> } } }).client
      .channels.fetch;
  }
}

beforeEach(async () => {
  temp_dir = await mkdtemp(join(tmpdir(), "lf-discord-send-guard-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(temp_dir, { recursive: true, force: true });
});

// ── Tests ──

describe("send() — empty channel_id guard (#319)", () => {
  for (const [label, value] of [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["undefined", undefined as unknown as string],
  ] as const) {
    it(`early-returns and breadcrumbs for ${label}`, async () => {
      const config = make_config();
      const registry = new EntityRegistry(config);
      const bot = new TestDiscordBot(config, registry);

      await bot.send(value, "hello");

      expect(bot.channels_fetch_mock).not.toHaveBeenCalled();
      expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
      expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "discord",
          level: "warning",
          message: "send() called with empty channel_id",
          data: expect.objectContaining({ content_preview: "hello" }),
        }),
      );
      expect(sentry.captureException).not.toHaveBeenCalled();
    });
  }

  it("truncates content_preview to 80 chars", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const long_content = "x".repeat(200);
    await bot.send("", long_content);

    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content_preview: "x".repeat(80) }),
      }),
    );
  });

  it("permits valid channel_id through to fetch (sanity check)", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    // Have fetch return a non-text channel so we exit cleanly without sending.
    bot.channels_fetch_mock.mockResolvedValue(null);

    await bot.send("123456789012345678", "hello");

    expect(bot.channels_fetch_mock).toHaveBeenCalledWith("123456789012345678");
    expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
  });
});

describe("send_status_embed() — empty channel_id guard (#319)", () => {
  it("early-returns on empty channel_id without fetching", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    await bot.send_status_embed("", "planner");

    expect(bot.channels_fetch_mock).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "send_status_embed() called with empty channel_id",
      }),
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("early-returns on whitespace-only channel_id", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    await bot.send_status_embed("   ", "planner");

    expect(bot.channels_fetch_mock).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).toHaveBeenCalled();
  });
});

describe("send_embed() — empty channel_id guard (#319)", () => {
  it("returns null and breadcrumbs without fetching", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const embed = new EmbedBuilder().setDescription("test");
    const result = await bot.send_embed("", embed);

    expect(result).toBeNull();
    expect(bot.channels_fetch_mock).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "send_embed() called with empty channel_id",
      }),
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("send_to_thread() — empty thread_id guard (#319)", () => {
  it("early-returns on empty thread_id without fetching", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    await bot.send_to_thread("", "hello");

    expect(bot.channels_fetch_mock).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "send_to_thread() called with empty channel_id",
        data: expect.objectContaining({ content_preview: "hello" }),
      }),
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("send_as_agent() — empty channel_id guard (#319)", () => {
  it("early-returns on empty channel_id without delegating", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    // If the guard didn't fire, send_as_agent would either hit the webhook
    // path or fall through to send() — both routes ultimately call fetch.
    await bot.send_as_agent("", "hello", "planner");

    expect(bot.channels_fetch_mock).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "send_as_agent() called with empty channel_id",
        data: expect.objectContaining({ content_preview: "hello" }),
      }),
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("still emits exactly one breadcrumb (no double-emit via inner send())", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    await bot.send_as_agent("", "hello", "planner");

    // Outer guard short-circuits — inner send() never runs, so we get one
    // breadcrumb (from send_as_agent), not two.
    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
  });
});

describe("send-family — captureException is never called on empty id (#319)", () => {
  it("none of the guard paths produce a Sentry exception event", async () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);

    const embed = new EmbedBuilder().setDescription("x");
    await bot.send("", "x");
    await bot.send_status_embed("", "planner");
    await bot.send_embed("", embed);
    await bot.send_to_thread("", "x");
    await bot.send_as_agent("", "x", "planner");

    expect(sentry.captureException).not.toHaveBeenCalled();
    // 5 breadcrumbs — one per call.
    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(5);
  });
});
