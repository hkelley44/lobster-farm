/**
 * #107 — the four formerly-driverless assign() callers now synthesize a
 * message driver for broker channels (paths 7–9 here; path 10, HTTP
 * POST /pool/assign, is covered in pool-assign-http.test.ts).
 *
 * Each caller is driven through the REAL private handler on DiscordBot with a
 * faked pool, asserting:
 *   - broker channel → assign() receives a synthesized PendingMessage built
 *     from the triggering user action;
 *   - plugin channel → assign() receives NO pending_message (byte-identical
 *     to today, the flag-OFF merge gate);
 *   - null-handling: each caller's null branch still behaves (audited per the
 *     #107 technical note — the guard changed assign()'s contract).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordBot, type RoomArchive, write_room_archive } from "../discord.js";
import type { PendingMessage } from "../pool.js";
import type { EntityRegistry } from "../registry.js";
import type { RoutedMessage } from "../router.js";

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

const BROKER_CHANNEL = "chan-broker-pilot";
const PLUGIN_CHANNEL = "chan-plugin";
const ENTITY = "entity-1";

let temp_dir: string;

interface FakePool {
  channel_uses_broker: ReturnType<typeof vi.fn>;
  assign: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function make_fake_pool(assign_result: unknown = null): FakePool {
  return {
    channel_uses_broker: vi.fn((channel_id: string) => channel_id === BROKER_CHANNEL),
    assign: vi.fn().mockResolvedValue(assign_result),
    release: vi.fn().mockResolvedValue(undefined),
    // set_pool() wires these handlers/listeners on the real pool; inert here.
    set_nickname_handler: vi.fn(),
    set_avatar_handler: vi.fn(),
    on: vi.fn(),
  } as unknown as FakePool;
}

function make_target(channel_id: string) {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    channel_id,
    react: vi.fn().mockResolvedValue(undefined),
    author_name: "hunter",
  };
}

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
    agents: { builder: { name: "Ben" }, planner: { name: "Tidus" } },
    discord: {
      server_id: "guild-1",
      broker: { enabled: true, pilot_channels: [BROKER_CHANNEL] },
    },
  });
}

interface EntityConfigShape {
  entity: {
    id: string;
    channels: {
      category_id: string | null;
      list: Array<{ type: string; id: string; purpose?: string; dynamic?: boolean }>;
    };
  };
}

function make_bot_under_test(
  pool: FakePool,
  entity_config?: EntityConfigShape,
): { bot: DiscordBot; internals: Record<string, unknown> } {
  const registry = {
    get: vi.fn(() => entity_config),
    load_all: vi.fn(),
    count: () => 1,
    get_active: () => [],
  } as unknown as EntityRegistry;

  const bot = new DiscordBot(make_config(), registry);
  bot.set_pool(pool as never);
  const internals = bot as unknown as Record<string, unknown>;

  // Stub everything that would touch the real Discord API / config files.
  vi.spyOn(internals, "create_channel" as never).mockImplementation(
    // A fresh room/resume channel: broker pilot id or plugin id, driven by the
    // test through this mutable field.
    () => Promise.resolve((internals.__next_channel_id as string) ?? PLUGIN_CHANNEL),
  );
  vi.spyOn(internals, "persist_entity_config" as never).mockResolvedValue(undefined as never);
  vi.spyOn(internals, "build_channel_map" as never).mockImplementation(() => undefined);
  vi.spyOn(internals, "send" as never).mockResolvedValue(undefined as never);
  vi.spyOn(internals, "delete_channel" as never).mockResolvedValue(undefined as never);

  return { bot, internals };
}

function routed(channel_id: string): RoutedMessage {
  return {
    entity_id: ENTITY,
    channel_type: "general",
    content: "",
    author: "hunter",
    channel_id,
  };
}

function entity_config(): EntityConfigShape {
  return {
    entity: { id: ENTITY, channels: { category_id: "cat-1", list: [] } },
  };
}

/** Extract the pending_message argument (position 7) from an assign() call. */
function pending_arg(pool: FakePool, call = 0): PendingMessage | undefined {
  return pool.assign.mock.calls[call]![6] as PendingMessage | undefined;
}

describe("driverless callers now pass a broker driver (#107 paths 7–9)", () => {
  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "driverless-callers-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  // ── Path 7: /swap ──

  describe("/swap", () => {
    async function run_swap(pool: FakePool, channel_id: string) {
      const { bot, internals } = make_bot_under_test(pool);
      // /swap resolves the entity from the channel map.
      (internals.channel_map as Map<string, unknown>).set(channel_id, {
        entity_id: ENTITY,
        channel_type: "general",
      });
      const target = make_target(channel_id);
      await (internals.handle_swap_command as (a: string[], t: unknown) => Promise<void>).call(
        bot,
        ["builder"],
        target,
      );
      return target;
    }

    it("BROKER channel: synthesizes the driver from the swap event", async () => {
      const pool = make_fake_pool({ bot_id: 1 });
      await run_swap(pool, BROKER_CHANNEL);

      expect(pool.release).toHaveBeenCalledWith(BROKER_CHANNEL);
      expect(pool.assign).toHaveBeenCalledTimes(1);
      const driver = pending_arg(pool);
      expect(driver).toBeDefined();
      expect(driver!.channel_id).toBe(BROKER_CHANNEL);
      expect(driver!.user).toBe("hunter");
      expect(driver!.content).toContain("hunter swapped you in as the builder archetype");
      expect(driver!.ts).toBeTruthy();
      // The rest of the call shape is unchanged.
      expect(pool.assign.mock.calls[0]!.slice(0, 3)).toEqual([BROKER_CHANNEL, ENTITY, "builder"]);
    });

    it("PLUGIN channel: passes NO pending_message — byte-identical to today", async () => {
      const pool = make_fake_pool({ bot_id: 1 });
      await run_swap(pool, PLUGIN_CHANNEL);
      expect(pool.assign).toHaveBeenCalledTimes(1);
      expect(pending_arg(pool)).toBeUndefined();
    });

    it("null-handling audit: a null assign still reports 'no pool bots' — with a driver always passed, null now only means exhaustion", async () => {
      const pool = make_fake_pool(null);
      const target = await run_swap(pool, BROKER_CHANNEL);
      expect(pending_arg(pool)).toBeDefined(); // the guard can never be the cause
      expect(target.reply).toHaveBeenCalledWith("No pool bots available for swap.");
    });
  });

  // ── Path 8: /room without initial context ──

  describe("/room without context", () => {
    async function run_room(pool: FakePool, new_channel_id: string, args: string[]) {
      const { bot, internals } = make_bot_under_test(pool, entity_config());
      internals.__next_channel_id = new_channel_id;
      const target = make_target("chan-origin");
      await (
        internals.handle_room_command as (
          a: string[],
          r: RoutedMessage,
          t: unknown,
        ) => Promise<void>
      ).call(bot, args, routed("chan-origin"), target);
      return target;
    }

    it("BROKER room, no context: synthesizes the driver from the creation event", async () => {
      const pool = make_fake_pool({ bot_id: 1 });
      await run_room(pool, BROKER_CHANNEL, ["warroom"]);

      expect(pool.assign).toHaveBeenCalledTimes(1);
      const driver = pending_arg(pool);
      expect(driver).toBeDefined();
      expect(driver!.channel_id).toBe(BROKER_CHANNEL);
      expect(driver!.content).toContain("Room #warroom created by hunter");
      expect(driver!.content).toContain(ENTITY);
    });

    it("BROKER room WITH context: the user's context stays the driver (pre-existing branch untouched)", async () => {
      const pool = make_fake_pool({ bot_id: 1 });
      await run_room(pool, BROKER_CHANNEL, ["warroom", "ship", "the", "thing"]);
      const driver = pending_arg(pool);
      expect(driver!.content).toBe("ship the thing");
    });

    it("PLUGIN room, no context: passes NO pending_message — byte-identical to today", async () => {
      const pool = make_fake_pool({ bot_id: 1 });
      await run_room(pool, PLUGIN_CHANNEL, ["warroom"]);
      expect(pending_arg(pool)).toBeUndefined();
    });
  });

  // ── Path 9: /resume (spec table: "/open — resume archived room") ──

  describe("/resume archived room", () => {
    async function run_resume(pool: FakePool, new_channel_id: string) {
      const archive: RoomArchive = {
        name: "warroom",
        channel_id: "chan-old",
        session_id: "sess-archived",
        entity_id: ENTITY,
        archetype: "builder",
        archived_at: "2026-08-01T00:00:00Z",
        closed_at: "2026-08-01T00:00:00Z",
      };
      await write_room_archive(ENTITY, archive, { lobsterfarm_dir: temp_dir });

      const pool_local = pool;
      const { bot, internals } = make_bot_under_test(pool_local, entity_config());
      internals.__next_channel_id = new_channel_id;
      const target = make_target("chan-origin");
      await (
        internals.handle_resume_command as (
          a: string[],
          r: RoutedMessage,
          t: unknown,
        ) => Promise<void>
      ).call(bot, ["warroom"], routed("chan-origin"), target);
      return target;
    }

    it("BROKER channel: synthesizes the driver from the resume event, keeps --resume continuity", async () => {
      const pool = make_fake_pool({ bot_id: 1 });
      await run_resume(pool, BROKER_CHANNEL);

      expect(pool.assign).toHaveBeenCalledTimes(1);
      const call = pool.assign.mock.calls[0]!;
      // Archived session still resumed (positional contract unchanged) …
      expect(call.slice(0, 5)).toEqual([
        BROKER_CHANNEL,
        ENTITY,
        "builder",
        "sess-archived",
        "work_room",
      ]);
      // … and the driver rides alongside.
      const driver = pending_arg(pool);
      expect(driver).toBeDefined();
      expect(driver!.content).toContain("Session warroom resumed by hunter");
    });

    it("PLUGIN channel: passes NO pending_message — byte-identical to today", async () => {
      const pool = make_fake_pool({ bot_id: 1 });
      await run_resume(pool, PLUGIN_CHANNEL);
      expect(pending_arg(pool)).toBeUndefined();
    });

    it("null-handling audit: a null assign still falls back to 'send a message to auto-assign'", async () => {
      const pool = make_fake_pool(null);
      const target = await run_resume(pool, BROKER_CHANNEL);
      expect(pending_arg(pool)).toBeDefined();
      const replies = target.reply.mock.calls.map((c) => String(c[0]));
      expect(replies.some((r) => r.includes("no pool bots available"))).toBe(true);
    });
  });
});
