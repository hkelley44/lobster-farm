import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingInboundStore } from "../pending-inbound.js";
import { PENDING_INJECT_MIN_AGE_MS } from "../pool.js";
import type { ChannelTarget, InboundDeliveredEvent, PendingMessage, PoolBot } from "../pool.js";
import type { EntityRegistry } from "../registry.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

const { notify_mock } = vi.hoisted(() => ({ notify_mock: vi.fn(async () => {}) }));
vi.mock("../actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../actions.js")>();
  return { ...actual, notify: notify_mock };
});

const IDLE_PROMPT = ["● Done.", "╭────╮", "│ ❯  │", "╰────╯", "  ⏵⏵ bypass permissions on"].join(
  "\n",
);
const WORKING = ["✻ Thinking… (esc to interrupt)", "│ ❯  │"].join("\n");
const TRUST_DIALOG = [" Quick safety check", " ❯ 1. Yes, I trust this folder"].join("\n");

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    last_inbound_at: null,
    last_processing_at: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

function msg(id: string, channel_id = "ch-1"): PendingMessage {
  return {
    user: "ada",
    channel_id,
    message_id: id,
    content: `content ${id}`,
    ts: new Date().toISOString(),
  };
}

class TestBotPool extends BotPoolTestBase {
  alive = new Map<string, boolean>();
  panes = new Map<string, string | null>();
  transcript = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  send_ok = true;

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  protected override is_tmux_alive(session_name: string): boolean {
    return this.alive.get(session_name) ?? false;
  }
  protected override read_pane(tmux_session: string): string | null {
    return this.panes.get(tmux_session) ?? null;
  }
  protected override async transcript_has_message(_bot: PoolBot, id: string): Promise<boolean> {
    return this.transcript.has(id);
  }
  // Every bot counts as busy so eviction never frees a slot behind the test's back.
  override is_bot_idle(): boolean {
    return false;
  }
}

describe("BotPool pending-inbound drain", () => {
  let pool: TestBotPool;
  let store: PendingInboundStore;
  let start_tmux: ReturnType<typeof vi.spyOn>;
  let delivered: InboundDeliveredEvent[];
  let targets: Map<string, ChannelTarget | null | undefined>;

  const target = (entity_id = "acme"): ChannelTarget => ({
    entity_id,
    archetype: "planner",
    channel_type: "general",
    channel_name: "general",
  });

  /** Move the clock so every queued entry is past the injection min-age. */
  function age(ms = PENDING_INJECT_MIN_AGE_MS + 1_000): void {
    vi.setSystemTime(Date.now() + ms);
  }

  function live_bot(id: number, channel_id: string, overrides: Partial<PoolBot> = {}): PoolBot {
    const bot = make_bot({
      id,
      state: "assigned",
      channel_id,
      entity_id: "acme",
      archetype: "planner",
      session_id: `sess-${String(id)}`,
      assigned_at: new Date(),
      last_active: new Date(),
      ...overrides,
    });
    pool.alive.set(bot.tmux_session, true);
    pool.panes.set(bot.tmux_session, IDLE_PROMPT);
    return bot;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    temp_dir = await mkdtemp(join(tmpdir(), "pool-pending-inbound-"));
    notify_mock.mockClear();

    pool = new TestBotPool(make_config());
    const entity: EntityConfig = {
      entity: {
        id: "acme",
        name: "Acme",
        description: "",
        status: "active",
        repos: [],
        accounts: {},
        channels: { category_id: "", list: [{ type: "general" as const, id: "ch-1" }] },
        memory: { path: "/tmp/memory", auto_extract: true },
        secrets: { vault: "1password", vault_name: "entity-acme" },
      },
    };
    (pool as unknown as { registry: EntityRegistry }).registry = {
      get: (id: string) => (id === "acme" ? entity : undefined),
      get_all: () => [entity],
      get_active: () => [entity],
      count: () => 1,
    } as unknown as EntityRegistry;

    for (const method of [
      "kill_tmux",
      "write_access_json",
      "set_bot_nickname",
      "set_bot_avatar",
      "persist",
      "resolve_github_token_ref",
    ] as const) {
      vi.spyOn(pool as unknown as Record<string, unknown>, method as never).mockImplementation(
        (() => undefined) as never,
      );
    }
    start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "send_via_tmux" as never,
    ).mockImplementation((async (session: string, text: string) => {
      pool.sent.push({ session, text });
      return pool.send_ok;
    }) as never);

    store = new PendingInboundStore({ path: join(temp_dir, "state", "pending-inbound.json") });
    pool.set_pending_inbound(store);
    targets = new Map([
      ["ch-1", target()],
      ["ch-2", target()],
    ]);
    pool.set_channel_resolver((channel_id) =>
      targets.has(channel_id) ? targets.get(channel_id) : null,
    );
    delivered = [];
    pool.on("inbound:delivered", (e: InboundDeliveredEvent) => delivered.push(e));
  });

  afterEach(async () => {
    await pool.shutdown();
    await store.flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("queue_inbound reports the channel's place in line", () => {
    expect(pool.queue_inbound(msg("a1", "ch-1"), "acme", "busy")).toEqual({
      position: 1,
      depth: 1,
    });
    expect(pool.queue_inbound(msg("b1", "ch-2"), "acme", "busy")).toEqual({
      position: 2,
      depth: 1,
    });
    expect(pool.queue_inbound(msg("a2", "ch-1"), "acme", "busy")).toEqual({
      position: 1,
      depth: 2,
    });
    expect(pool.pending_inbound_depth("ch-1")).toBe(2);
    expect(pool.get_status().pending_inbound).toEqual({
      total: 3,
      by_channel: { "ch-1": 2, "ch-2": 1 },
    });
  });

  it("queue_inbound is a no-op (null) when no store is wired", () => {
    const bare = new TestBotPool(make_config());
    expect(bare.queue_inbound(msg("m1"), "acme", "busy")).toBeNull();
    expect(bare.pending_inbound_depth("ch-1")).toBe(0);
    expect(bare.should_queue_steady_inbound("ch-1")).toBe(false);
    expect(bare.get_status().pending_inbound).toBeUndefined();
  });

  it("a freed slot starts a session for the OLDEST waiting channel, driven by its first message", async () => {
    pool.inject_bots([make_bot({ id: 1 })]); // one free bot
    pool.queue_inbound(msg("b1", "ch-2"), "acme", "busy");
    pool.queue_inbound(msg("a1", "ch-1"), "acme", "busy");

    await pool.drain_pending_inbound();

    // ch-2 was first in line and takes the only bot.
    expect(start_tmux).toHaveBeenCalledTimes(1);
    const bot = pool.get_assignment("ch-2");
    expect(bot).toBeDefined();
    // The first message rides in as the SessionStart pending file.
    const env = (start_tmux.mock.calls[0] as unknown[])[6] as Record<string, string>;
    expect(env.LF_PENDING_FILE).toBeDefined();

    expect(store.depth("ch-2")).toBe(0);
    expect(store.depth("ch-1")).toBe(1); // still waiting — no slot
    expect(delivered).toEqual([
      { channel_id: "ch-2", message_ids: ["b1"], how: "first_turn", archetype: "planner" },
    ]);
    // The first turn is handed over without a receipt, so the probe is armed.
    expect(bot!.last_inbound_at).not.toBeNull();
  });

  it("leaves the message queued when no bot can be assigned", async () => {
    pool.inject_bots([live_bot(1, "ch-other")]); // busy elsewhere, not evictable
    pool.queue_inbound(msg("a1"), "acme", "busy");

    await pool.drain_pending_inbound();

    expect(start_tmux).not.toHaveBeenCalled();
    expect(store.depth("ch-1")).toBe(1);
    expect(delivered).toEqual([]);
  });

  it("release() triggers a drain, so the queued channel gets the freed bot", async () => {
    pool.inject_bots([live_bot(1, "ch-other")]);
    pool.queue_inbound(msg("a1"), "acme", "busy");
    await pool.drain_pending_inbound();
    expect(store.depth("ch-1")).toBe(1);

    await pool.release("ch-other");
    await vi.advanceTimersByTimeAsync(1_500);
    // The scheduled drain does real file I/O (the pending-message file) that
    // fake timers cannot advance — give the event loop a few real turns.
    for (let i = 0; i < 50 && !pool.get_assignment("ch-1"); i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(pool.get_assignment("ch-1")).toBeDefined();
    expect(store.depth("ch-1")).toBe(0);
  });

  it("follow-ups queued behind the first message are typed in afterwards, in order, as one turn", async () => {
    pool.inject_bots([make_bot({ id: 1 })]);
    pool.queue_inbound(msg("a1"), "acme", "busy");
    pool.queue_inbound(msg("a2"), "acme", "assigning");
    pool.queue_inbound(msg("a3"), "acme", "assigning");

    await pool.drain_pending_inbound(); // starts the session with a1
    expect(store.peek_channel("ch-1").map((e) => e.message_id)).toEqual(["a2", "a3"]);

    const bot = pool.get_assignment("ch-1")!;
    pool.alive.set(bot.tmux_session, true);
    pool.panes.set(bot.tmux_session, IDLE_PROMPT);
    age();
    await pool.drain_pending_inbound();

    expect(pool.sent).toHaveLength(1);
    const text = pool.sent[0]!.text;
    expect(text.indexOf("message_id a2")).toBeLessThan(text.indexOf("message_id a3"));
    expect(text).toContain("#general");
    expect(store.depth("ch-1")).toBe(0);
    expect(delivered.at(-1)).toEqual({
      channel_id: "ch-1",
      message_ids: ["a2", "a3"],
      how: "injected",
      archetype: "planner",
    });
  });

  it("does not inject until the entries are old enough for the plugin to have delivered", async () => {
    pool.inject_bots([live_bot(1, "ch-1")]);
    pool.queue_inbound(msg("m1"), "acme", "not_ready");

    await pool.drain_pending_inbound();
    expect(pool.sent).toHaveLength(0);
    expect(store.depth("ch-1")).toBe(1);

    age();
    await pool.drain_pending_inbound();
    expect(pool.sent).toHaveLength(1);
  });

  it.each([
    ["while a turn is running", WORKING],
    ["into a dialog", TRUST_DIALOG],
    ["when the pane is unreadable", null],
  ])("never types %s", async (_label, pane) => {
    const bot = live_bot(1, "ch-1");
    pool.inject_bots([bot]);
    pool.panes.set(bot.tmux_session, pane);
    pool.queue_inbound(msg("m1"), "acme", "not_ready");
    age();

    await pool.drain_pending_inbound();

    expect(pool.sent).toHaveLength(0);
    expect(store.depth("ch-1")).toBe(1);
  });

  it("keeps the entry when the injection is not confirmed, and sends it once when it later succeeds", async () => {
    pool.inject_bots([live_bot(1, "ch-1")]);
    pool.queue_inbound(msg("m1"), "acme", "not_ready");
    age();

    pool.send_ok = false;
    await pool.drain_pending_inbound();
    expect(store.depth("ch-1")).toBe(1);
    expect(store.peek_channel("ch-1")[0]?.attempts).toBe(1);
    expect(delivered).toEqual([]);

    pool.send_ok = true;
    await pool.drain_pending_inbound();
    await pool.drain_pending_inbound(); // nothing left to send
    expect(pool.sent).toHaveLength(2); // one failed attempt + one success, no third
    expect(store.depth("ch-1")).toBe(0);
  });

  it("skips a message the plugin delivered after all (id already in the transcript)", async () => {
    pool.inject_bots([live_bot(1, "ch-1")]);
    pool.queue_inbound(msg("seen"), "acme", "not_ready");
    pool.queue_inbound(msg("missed"), "acme", "not_ready");
    pool.transcript.add("seen");
    age();

    await pool.drain_pending_inbound();

    expect(pool.sent).toHaveLength(1);
    expect(pool.sent[0]!.text).not.toContain("message_id seen");
    expect(pool.sent[0]!.text).toContain("message_id missed");
    expect(store.depth("ch-1")).toBe(0);
    expect(delivered.map((e) => [e.how, e.message_ids])).toEqual([
      ["plugin_delivered", ["seen"]],
      ["injected", ["missed"]],
    ]);
  });

  it("waits for a dead session to be restarted rather than dropping its queue", async () => {
    const bot = live_bot(1, "ch-1");
    pool.inject_bots([bot]);
    pool.alive.set(bot.tmux_session, false);
    pool.queue_inbound(msg("m1"), "acme", "not_ready");
    age();

    await pool.drain_pending_inbound();

    expect(pool.sent).toHaveLength(0);
    expect(store.depth("ch-1")).toBe(1);
  });

  describe("should_queue_steady_inbound (cold-start window)", () => {
    it("queues for a session that has not run a turn since it was spawned", () => {
      pool.inject_bots([live_bot(1, "ch-1", { last_processing_at: null })]);
      expect(pool.should_queue_steady_inbound("ch-1")).toBe(true);
    });

    it("trusts the plugin once the session has processed a turn", () => {
      const bot = live_bot(1, "ch-1");
      pool.inject_bots([bot]);
      vi.setSystemTime(Date.now() + 1_000);
      pool.mark_processed(bot.session_id!);
      expect(pool.is_plugin_ready(bot)).toBe(true);
      expect(pool.should_queue_steady_inbound("ch-1")).toBe(false);
    });

    it("a turn processed by a PREVIOUS process is not evidence for the new one", async () => {
      const bot = live_bot(1, "ch-1");
      pool.inject_bots([bot]);
      vi.setSystemTime(Date.now() + 1_000);
      pool.mark_processed(bot.session_id!);
      expect(pool.is_plugin_ready(bot)).toBe(true);

      // The CLI is respawned (crash restart) — same session id, new plugin.
      vi.setSystemTime(Date.now() + 1_000);
      start_tmux.mockRestore();
      vi.spyOn(
        pool as unknown as Record<string, unknown>,
        "uses_broker" as never,
      ).mockImplementation((() => {
        throw new Error("stop after the bookkeeping");
      }) as never);
      await (pool as unknown as { start_tmux: (...a: unknown[]) => Promise<void> })
        .start_tmux(bot, "planner", "acme", temp_dir, bot.session_id, true, {}, "ch-1")
        .catch(() => {});

      expect(pool.is_plugin_ready(bot)).toBe(false);
    });

    it("keeps queueing behind messages already waiting, even for a ready session", () => {
      const bot = live_bot(1, "ch-1");
      pool.inject_bots([bot]);
      vi.setSystemTime(Date.now() + 1_000);
      pool.mark_processed(bot.session_id!);
      store.enqueue(msg("earlier"), "acme", "not_ready");
      expect(pool.should_queue_steady_inbound("ch-1")).toBe(true);
    });

    it("is false for an unassigned channel", () => {
      pool.inject_bots([make_bot({ id: 1 })]);
      expect(pool.should_queue_steady_inbound("ch-1")).toBe(false);
    });
  });

  it("a finished turn (Stop hook) schedules delivery of queued follow-ups", async () => {
    const bot = live_bot(1, "ch-1");
    pool.inject_bots([bot]);
    pool.queue_inbound(msg("m1"), "acme", "assigning");
    age();

    pool.mark_processed(bot.session_id!);
    await vi.advanceTimersByTimeAsync(PENDING_INJECT_MIN_AGE_MS + 2_000);

    expect(pool.sent).toHaveLength(1);
    expect(store.depth("ch-1")).toBe(0);
  });

  it("holds everything while the channel map is not available yet (gateway not ready)", async () => {
    pool.inject_bots([make_bot({ id: 1 })]);
    targets.set("ch-1", undefined);
    pool.queue_inbound(msg("a1"), "acme", "busy");

    await pool.drain_pending_inbound();

    expect(start_tmux).not.toHaveBeenCalled();
    expect(store.depth("ch-1")).toBe(1);
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("drops — with an alert — messages whose channel is no longer mapped", async () => {
    pool.inject_bots([make_bot({ id: 1 })]);
    pool.queue_inbound(msg("gone", "ch-deleted"), "acme", "busy");

    await pool.drain_pending_inbound();

    expect(store.total()).toBe(0);
    expect(notify_mock).toHaveBeenCalledTimes(1);
    expect(String(notify_mock.mock.calls[0]?.[1])).toContain("no longer mapped");
  });

  it("expires entries older than 24h with one alert per entity", async () => {
    pool.inject_bots([live_bot(1, "ch-other")]);
    pool.queue_inbound(msg("a1"), "acme", "busy");
    pool.queue_inbound(msg("a2"), "acme", "busy");
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);

    await pool.drain_pending_inbound();

    expect(store.total()).toBe(0);
    expect(notify_mock).toHaveBeenCalledTimes(1);
    expect(String(notify_mock.mock.calls[0]?.[1])).toContain("2 queued Discord message(s)");
  });

  it("gives up on a channel whose session keeps failing to start, with an alert", async () => {
    pool.inject_bots([make_bot({ id: 1 })]);
    start_tmux.mockRejectedValue(new Error("tmux failed with code 1"));
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});
    pool.queue_inbound(msg("a1"), "acme", "busy");

    for (let i = 0; i < 4; i++) await pool.drain_pending_inbound();
    expect(store.depth("ch-1")).toBe(1); // still retrying

    await pool.drain_pending_inbound();
    expect(store.depth("ch-1")).toBe(0);
    expect(String(notify_mock.mock.calls.at(-1)?.[1])).toContain("failed to start 5 times");
    error_spy.mockRestore();
  });

  it("one channel's failure does not stop delivery to the next", async () => {
    const a = live_bot(1, "ch-1");
    const b = live_bot(2, "ch-2");
    pool.inject_bots([a, b]);
    pool.queue_inbound(msg("a1", "ch-1"), "acme", "not_ready");
    pool.queue_inbound(msg("b1", "ch-2"), "acme", "not_ready");
    age();
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = (
      pool as unknown as { transcript_has_message: (b: PoolBot, id: string) => Promise<boolean> }
    ).transcript_has_message.bind(pool);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "transcript_has_message" as never,
    ).mockImplementation((async (bot: PoolBot, id: string) => {
      if (bot.id === 1) throw new Error("boom");
      return original(bot, id);
    }) as never);

    await expect(pool.drain_pending_inbound()).resolves.toBeUndefined();

    expect(store.depth("ch-1")).toBe(1);
    expect(store.depth("ch-2")).toBe(0);
    error_spy.mockRestore();
  });

  it("does nothing while the pool is draining for shutdown", async () => {
    pool.inject_bots([make_bot({ id: 1 })]);
    pool.queue_inbound(msg("a1"), "acme", "busy");
    pool.drain();

    await pool.drain_pending_inbound();

    expect(start_tmux).not.toHaveBeenCalled();
    expect(store.depth("ch-1")).toBe(1);
  });

  it("queued messages survive a restart and are delivered by the next daemon", async () => {
    pool.inject_bots([live_bot(1, "ch-other")]);
    pool.queue_inbound(msg("a1"), "acme", "busy");
    await pool.shutdown(); // flushes the store

    const reloaded = new PendingInboundStore({
      path: join(temp_dir, "state", "pending-inbound.json"),
    });
    await reloaded.load();
    expect(reloaded.peek_channel("ch-1").map((e) => e.message_id)).toEqual(["a1"]);
  });
});
