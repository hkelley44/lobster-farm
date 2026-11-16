import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock discord.js so DiscordBot can be instantiated without a live websocket.
vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn(),
      destroy: vi.fn(),
      user: { id: "daemon-bot" },
      channels: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
      application: null,
    })),
  };
});

import { DiscordBot } from "../discord.js";
import type { BotPool, InboundDeliveredEvent, PendingMessage } from "../pool.js";
import { EntityRegistry } from "../registry.js";

/**
 * handle_message → pending-inbound queue. These pin the three windows in which
 * the daemon used to see a message and then lose it: every bot busy, an assign
 * already in flight for the channel, and a session whose plugin is not yet
 * known to be listening.
 */

interface FakeMessage {
  author: { bot: boolean; id: string; displayName: string };
  channelId: string;
  id: string;
  content: string;
  createdTimestamp: number;
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  reactions: { cache: Map<string, { users: { remove: ReturnType<typeof vi.fn> } }> };
}

function fake_message(id: string, content = "hello"): FakeMessage {
  const reactions = new Map<string, { users: { remove: ReturnType<typeof vi.fn> } }>();
  return {
    author: { bot: false, id: "user-1", displayName: "ada" },
    channelId: "ch-1",
    id,
    content,
    createdTimestamp: 1_700_000_000_000,
    react: vi.fn(async (emoji: string) => {
      reactions.set(emoji, { users: { remove: vi.fn(async () => {}) } });
    }),
    reply: vi.fn(async () => {}),
    reactions: { cache: reactions },
  };
}

class TestDiscordBot extends DiscordBot {
  typing: string[] = [];

  async invoke(msg: FakeMessage): Promise<void> {
    await (this as unknown as { handle_message: (m: FakeMessage) => Promise<void> }).handle_message(
      msg,
    );
  }
  map_channel(channel_id: string): void {
    (
      this as unknown as { channel_map: Map<string, { entity_id: string; channel_type: string }> }
    ).channel_map.set(channel_id, { entity_id: "acme", channel_type: "general" });
  }
  override start_typing_loop(channel_id: string): void {
    this.typing.push(channel_id);
  }
  override start_commander_typing_loop(): void {}
  override async find_command_center_channel(): Promise<string | null> {
    return null;
  }
  protected async send_status_embed(): Promise<void> {}
}

/** A pool double exposing exactly what handle_message touches. */
function make_pool(overrides: Partial<Record<string, unknown>> = {}) {
  const pool = {
    get_assignment: vi.fn(() => undefined as unknown),
    is_session_alive: vi.fn(() => true),
    has_stale_oauth: vi.fn(() => false),
    assign: vi.fn(async () => null as unknown),
    deliver_or_buffer_broker_inbound: vi.fn(() => false),
    channel_uses_broker: vi.fn(() => false),
    is_assigning: vi.fn(() => false),
    pending_inbound_depth: vi.fn(() => 0),
    queue_inbound: vi.fn(() => ({ position: 1, depth: 1 }) as unknown),
    should_queue_steady_inbound: vi.fn(() => false),
    arm_inbound_probe: vi.fn(),
    touch: vi.fn(),
    mark_inbound: vi.fn(),
    broker_owns: vi.fn(() => false),
    feed_broker_inbound: vi.fn(),
    ...overrides,
  };
  return pool;
}

describe("handle_message — pending-inbound queue", () => {
  let tmp_dir: string;
  let bot: TestDiscordBot;
  let log_spy: ReturnType<typeof vi.spyOn>;

  function use_pool(pool: ReturnType<typeof make_pool>): void {
    (bot as unknown as { _pool: BotPool })._pool = pool as unknown as BotPool;
  }
  function inbound_logs(): string[] {
    return log_spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[inbound]"));
  }

  beforeEach(async () => {
    tmp_dir = join(tmpdir(), `discord-busy-queue-${randomUUID()}`);
    await mkdir(tmp_dir, { recursive: true });
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Test" },
      discord: { server_id: "111222333" },
      paths: { lobsterfarm_dir: tmp_dir },
    });
    bot = new TestDiscordBot(config, new EntityRegistry(config));
    bot.map_channel("ch-1");
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Not vi.restoreAllMocks(): that would also strip the discord.js Client
    // mock's implementation and break every later construction.
    log_spy.mockRestore();
    await rm(tmp_dir, { recursive: true }).catch(() => {});
  });

  it("all bots busy: stores the message, says so honestly, and keeps ⏳ on it", async () => {
    const pool = make_pool({ queue_inbound: vi.fn(() => ({ position: 2, depth: 1 })) });
    use_pool(pool);
    const message = fake_message("m1", "please deploy");

    await bot.invoke(message);

    expect(pool.assign).toHaveBeenCalledTimes(1);
    expect(pool.queue_inbound).toHaveBeenCalledTimes(1);
    const [pending, entity_id, reason] = pool.queue_inbound.mock.calls[0] as unknown as [
      PendingMessage,
      string,
      string,
    ];
    expect(pending).toMatchObject({
      message_id: "m1",
      channel_id: "ch-1",
      user: "ada",
      content: "please deploy",
    });
    expect(entity_id).toBe("acme");
    expect(reason).toBe("busy");

    const reply = String(message.reply.mock.calls[0]?.[0]);
    expect(reply).toContain("Queued (position 2)");
    expect(reply).not.toContain("will be picked up");
    // ⏳ was added and never removed.
    expect(message.reactions.cache.get("⏳")?.users.remove).not.toHaveBeenCalled();
    expect(inbound_logs()).toEqual(["[inbound] channel=ch-1 message=m1 outcome=queued_busy"]);
  });

  it("never promises pickup when the message could not be stored", async () => {
    const pool = make_pool({ queue_inbound: vi.fn(() => null) });
    use_pool(pool);
    const message = fake_message("m1");

    await bot.invoke(message);

    const reply = String(message.reply.mock.calls[0]?.[0]);
    expect(reply).toContain("send it again");
    expect(reply).not.toContain("will be picked up");
    expect(reply).not.toContain("Queued");
    expect(message.reactions.cache.get("⏳")?.users.remove).toHaveBeenCalled();
  });

  it("second message during an in-flight assign is stored silently — no assign, no 'busy' reply", async () => {
    const pool = make_pool({ is_assigning: vi.fn(() => true) });
    use_pool(pool);
    const message = fake_message("m2");

    await bot.invoke(message);

    expect(pool.assign).not.toHaveBeenCalled();
    expect(pool.queue_inbound).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: "m2" }),
      "acme",
      "assigning",
    );
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.react).toHaveBeenCalledWith("⏳");
    expect(inbound_logs()).toEqual(["[inbound] channel=ch-1 message=m2 outcome=queued_assigning"]);
  });

  it("a message for a channel that already has a queue joins it instead of overtaking", async () => {
    const pool = make_pool({ pending_inbound_depth: vi.fn(() => 2) });
    use_pool(pool);

    await bot.invoke(fake_message("m3"));

    expect(pool.assign).not.toHaveBeenCalled();
    expect(pool.queue_inbound).toHaveBeenCalledWith(expect.anything(), "acme", "busy");
  });

  it("broker channels keep their own cold-start buffer", async () => {
    const pool = make_pool({
      channel_uses_broker: vi.fn(() => true),
      is_assigning: vi.fn(() => true),
      deliver_or_buffer_broker_inbound: vi.fn(() => true),
    });
    use_pool(pool);
    const message = fake_message("m1");

    await bot.invoke(message);

    expect(pool.queue_inbound).not.toHaveBeenCalled();
    expect(pool.deliver_or_buffer_broker_inbound).toHaveBeenCalledTimes(1);
    expect(message.react).toHaveBeenCalledWith("👀");
    expect(inbound_logs()).toEqual(["[inbound] channel=ch-1 message=m1 outcome=broker"]);
  });

  it("an assign() that throws queues the message instead of losing it", async () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = make_pool({
      assign: vi.fn(async () => {
        throw new Error("tmux failed with code 1");
      }),
    });
    use_pool(pool);

    await expect(bot.invoke(fake_message("m1"))).resolves.toBeUndefined();

    expect(pool.queue_inbound).toHaveBeenCalledWith(expect.anything(), "acme", "busy");
    error_spy.mockRestore();
  });

  it("successful cold start: 👀, probe armed for the first turn, nothing queued", async () => {
    const pool = make_pool({ assign: vi.fn(async () => ({ bot_id: 1 })) });
    use_pool(pool);
    const message = fake_message("m1");

    await bot.invoke(message);

    expect(pool.queue_inbound).not.toHaveBeenCalled();
    expect(pool.arm_inbound_probe).toHaveBeenCalledWith(
      "ch-1",
      expect.objectContaining({ message_id: "m1" }),
    );
    expect(message.react).toHaveBeenCalledWith("👀");
    expect(bot.typing).toEqual(["ch-1"]);
    expect(inbound_logs()).toEqual(["[inbound] channel=ch-1 message=m1 outcome=first_turn"]);
  });

  describe("steady state (a session is assigned and alive)", () => {
    const assigned = { id: 1, archetype: "planner" };

    it("queues the message when the session's plugin is not yet known to be listening", async () => {
      const pool = make_pool({
        get_assignment: vi.fn(() => assigned),
        should_queue_steady_inbound: vi.fn(() => true),
      });
      use_pool(pool);
      const message = fake_message("m1");

      await bot.invoke(message);

      expect(pool.queue_inbound).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: "m1" }),
        "acme",
        "not_ready",
      );
      // Not handed to the plugin, so the deaf probe must not be armed for it.
      expect(pool.mark_inbound).not.toHaveBeenCalled();
      expect(message.react).toHaveBeenCalledWith("⏳");
      expect(message.reply).not.toHaveBeenCalled();
      expect(inbound_logs()).toEqual([
        "[inbound] channel=ch-1 message=m1 outcome=queued_not_ready",
      ]);
    });

    it("leaves a ready session to its plugin, recording the message for the probe", async () => {
      const pool = make_pool({ get_assignment: vi.fn(() => assigned) });
      use_pool(pool);
      const message = fake_message("m1", "status?");

      await bot.invoke(message);

      expect(pool.queue_inbound).not.toHaveBeenCalled();
      expect(pool.mark_inbound).toHaveBeenCalledWith(
        "ch-1",
        expect.objectContaining({ message_id: "m1", content: "status?" }),
      );
      expect(message.react).not.toHaveBeenCalled();
      expect(inbound_logs()).toEqual(["[inbound] channel=ch-1 message=m1 outcome=plugin"]);
    });

    it("falls back to the plugin path when queueing fails", async () => {
      const pool = make_pool({
        get_assignment: vi.fn(() => assigned),
        should_queue_steady_inbound: vi.fn(() => true),
        queue_inbound: vi.fn(() => null),
      });
      use_pool(pool);

      await bot.invoke(fake_message("m1"));

      expect(pool.mark_inbound).toHaveBeenCalled();
    });

    it("a pool that throws from the readiness check cannot break message handling", async () => {
      const pool = make_pool({
        get_assignment: vi.fn(() => assigned),
        should_queue_steady_inbound: vi.fn(() => {
          throw new Error("boom");
        }),
      });
      use_pool(pool);

      await expect(bot.invoke(fake_message("m1"))).resolves.toBeUndefined();
      expect(pool.mark_inbound).toHaveBeenCalled();
    });
  });

  it("swaps ⏳ → 👀 and starts the typing loop when the pool delivers a queued message", async () => {
    const remove = vi.fn(async () => {});
    const react = vi.fn(async () => {});
    const fetch_message = vi.fn(async () => ({
      reactions: { cache: new Map([["⏳", { users: { remove } }]]) },
      react,
    }));
    const client = {
      user: { id: "daemon-bot" },
      channels: {
        fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { fetch: fetch_message } })),
      },
    };
    (bot as unknown as { client: unknown }).client = client;

    const event: InboundDeliveredEvent = {
      channel_id: "ch-1",
      message_ids: ["m1", "m2"],
      how: "injected",
      archetype: "planner",
    };
    await (
      bot as unknown as { on_inbound_delivered: (e: InboundDeliveredEvent) => Promise<void> }
    ).on_inbound_delivered(event);

    expect(fetch_message).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("daemon-bot");
    expect(react).toHaveBeenCalledWith("👀");
    expect(bot.typing).toEqual(["ch-1"]);

    // Delivered by the plugin after all: reactions updated, no typing loop.
    bot.typing = [];
    await (
      bot as unknown as { on_inbound_delivered: (e: InboundDeliveredEvent) => Promise<void> }
    ).on_inbound_delivered({ ...event, how: "plugin_delivered" });
    expect(bot.typing).toEqual([]);
  });
});
