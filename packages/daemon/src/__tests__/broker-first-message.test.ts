import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──
//
// Mock fs to observe the pending-file write + unlink (the plugin hook path) and
// keep every other fs call inert. child_process is mocked so start_tmux never
// spawns a real tmux / claude — we only care about the delivery decision, not
// the process.

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(""),
    execSync: vi.fn().mockReturnValue(""),
    spawn: vi.fn(),
  };
});

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { DiscordBroker } from "../broker/index.js";
import { BotPool, type PendingMessage, type PoolBot, pending_json_path } from "../pool.js";

// A tmux spawn that "succeeds": close(0) on the next tick.
function fake_tmux_proc(): ChildProcess {
  return {
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      if (ev === "close") setTimeout(() => cb(0), 0);
      return undefined;
    },
  } as unknown as ChildProcess;
}

const PILOT_CHANNEL = "chan-broker-pilot";
const PLUGIN_CHANNEL = "chan-plugin";

let dir: string;

function make_config(broker_enabled: boolean): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: dir },
    discord: {
      server_id: "guild-1",
      broker: { enabled: broker_enabled, pilot_channels: [PILOT_CHANNEL] },
    },
  });
}

function make_bot(id: number, state_dir: string, overrides: Partial<PoolBot> = {}): PoolBot {
  return {
    id,
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: false,
    tmux_session: `pool-${String(id)}`,
    last_active: null,
    assigned_at: null,
    state_dir,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

const PENDING: PendingMessage = {
  user: "hunter",
  channel_id: PILOT_CHANNEL,
  message_id: "m-1",
  content: "hello broker pilot",
  ts: "2026-07-04T10:00:00.000Z",
};

// A TestPool that stubs assign()'s heavy side effects but runs the REAL start_tmux
// so prepare_broker_session registers channel ownership on the broker path.
class TestPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  protected override check_session_jsonl_exists_anywhere(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override check_session_jsonl_exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override watch_session_confirmation(bot: PoolBot): void {
    bot.session_confirmed = true;
  }
  protected override is_tmux_alive(): boolean {
    return true;
  }
  protected override async write_access_json(): Promise<void> {}
  protected override async set_bot_nickname(): Promise<void> {}
  protected override async set_bot_avatar(): Promise<void> {}
  protected override async ensure_entity_channels_allowlisted(): Promise<void> {}
  protected override kill_tmux(): void {}
  protected override async persist(): Promise<void> {}
}

function pending_writes_for(session: string): unknown[] {
  const path = pending_json_path(session);
  return (writeFile as Mock).mock.calls.filter((c: unknown[]) => c[0] === path);
}

describe("assign() first-message delivery forks by transport (issue #87)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = join(tmpdir(), `broker-first-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    (spawn as unknown as Mock).mockImplementation(() => fake_tmux_proc());
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { rm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // Create the real dir the broker queue persists into (the fs mock stubs mkdir,
  // so the queue's atomic write-temp-rename would otherwise ENOENT — cosmetic,
  // but we keep test output clean).
  async function ensure_dir(): Promise<void> {
    const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await mkdir(dir, { recursive: true });
  }

  it("BROKER: enqueues message #1 into the broker queue so the first turn runs", async () => {
    await ensure_dir();
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = new DiscordBroker({
      config,
      socket_path: join(dir, "b.sock"),
      queue_path: join(dir, "q.json"),
    });
    const feed_spy = vi.spyOn(broker, "feed");
    pool.set_broker(broker);

    // state_dir must exist for prepare_broker_session to write broker-mcp.json —
    // otherwise it fails open to the plugin transport. Real mkdir here (the fs
    // mock only stubs the promises API our code calls, not the harness).
    const state_dir = join(dir, "pool-4");
    const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await mkdir(state_dir, { recursive: true });
    // broker-mcp.json is written via the mocked writeFile, so we don't need the
    // file itself — only the state_dir existing for any real reads.

    pool.inject_bots([make_bot(4, state_dir)]);

    const result = await pool.assign(
      PILOT_CHANNEL,
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      PENDING,
    );

    expect(result).not.toBeNull();
    // The broker actually took ownership (prepare_broker_session succeeded).
    expect(pool.broker_owns(PILOT_CHANNEL)).toBe(true);

    // Message #1 is enqueued into the broker queue — this is what drives the
    // first turn on the broker transport. Content + meta mirror steady-state.
    expect(feed_spy).toHaveBeenCalledTimes(1);
    expect(feed_spy).toHaveBeenCalledWith({
      channel_id: PILOT_CHANNEL,
      content: "hello broker pilot",
      meta: {
        chat_id: PILOT_CHANNEL,
        message_id: "m-1",
        user: "hunter",
        user_id: "",
        ts: "2026-07-04T10:00:00.000Z",
      },
    });

    // No lingering pending file: it's unlinked on the broker path so the
    // SessionStart hook no-ops and message #1 isn't double-delivered.
    expect(unlink).toHaveBeenCalledWith(pending_json_path("pool-4"));

    await broker.stop().catch(() => {});
  });

  it("PLUGIN: writes the pending file for the SessionStart hook, never feeds the broker", async () => {
    await ensure_dir();
    // Broker flag ON but this channel is NOT a pilot channel → plugin transport.
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = new DiscordBroker({
      config,
      socket_path: join(dir, "b.sock"),
      queue_path: join(dir, "q.json"),
    });
    const feed_spy = vi.spyOn(broker, "feed");
    pool.set_broker(broker);

    pool.inject_bots([make_bot(3, join(dir, "pool-3"))]);

    const result = await pool.assign(
      PLUGIN_CHANNEL,
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      { ...PENDING, channel_id: PLUGIN_CHANNEL },
    );

    expect(result).not.toBeNull();
    expect(pool.broker_owns(PLUGIN_CHANNEL)).toBe(false);

    // Plugin path is byte-identical to today: pending file written, hook fires.
    expect(pending_writes_for("pool-3").length).toBe(1);
    // The broker is never fed on the plugin path.
    expect(feed_spy).not.toHaveBeenCalled();
    // And the pending file is NOT unlinked (the hook consumes it, not us).
    expect(unlink).not.toHaveBeenCalledWith(pending_json_path("pool-3"));

    await broker.stop().catch(() => {});
  });

  it("BROKER DISABLED: flag off keeps the plugin hook path even on a pilot channel id", async () => {
    // broker.enabled = false → no broker constructed/wired → plugin everywhere.
    const config = make_config(false);
    const pool = new TestPool(config);
    // No set_broker — mirrors index.ts skipping broker construction when disabled.

    pool.inject_bots([make_bot(2, join(dir, "pool-2"))]);

    const result = await pool.assign(
      PILOT_CHANNEL,
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      PENDING,
    );

    expect(result).not.toBeNull();
    expect(pool.broker_owns(PILOT_CHANNEL)).toBe(false);
    // Pending file written (plugin hook path); nothing unlinked.
    expect(pending_writes_for("pool-2").length).toBe(1);
    expect(unlink).not.toHaveBeenCalledWith(pending_json_path("pool-2"));
  });
});

describe("concurrent cold-start: single session, one reply per message (#83)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = join(tmpdir(), `broker-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    (spawn as unknown as Mock).mockImplementation(() => fake_tmux_proc());
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { rm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function ensure_dir(): Promise<void> {
    const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await mkdir(dir, { recursive: true });
  }

  const MSG2: PendingMessage = {
    user: "hunter",
    channel_id: PILOT_CHANNEL,
    message_id: "m-2",
    content: "second message while cold-starting",
    ts: "2026-07-04T10:00:01.000Z",
  };

  it("buffers a concurrent inbound during in-flight assign and drains it after ownership registers, ordered", async () => {
    await ensure_dir();
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = new DiscordBroker({
      config,
      socket_path: join(dir, "b.sock"),
      queue_path: join(dir, "q.json"),
    });
    const feed_spy = vi.spyOn(broker, "feed");
    pool.set_broker(broker);

    const state_dir = join(dir, "pool-4");
    const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await mkdir(state_dir, { recursive: true });
    pool.inject_bots([make_bot(4, state_dir)]);

    // msg1 wins the assign lock. While it's in flight, msg2 loses the lock (assign
    // returns null in discord.ts) and routes here. We simulate that ordering by
    // marking the channel as assigning, buffering msg2, then running assign — which
    // clears the buffer via drain right after registering ownership + feeding msg1.
    (pool as unknown as { assigning_channels: Set<string> }).assigning_channels.add(PILOT_CHANNEL);
    const taken = pool.deliver_or_buffer_broker_inbound(PILOT_CHANNEL, MSG2);
    expect(taken).toBe(true); // buffered, caller must NOT reply "busy"
    // Nothing fed yet — buffered pending drain.
    expect(feed_spy).not.toHaveBeenCalled();
    (pool as unknown as { assigning_channels: Set<string> }).assigning_channels.delete(
      PILOT_CHANNEL,
    );

    const result = await pool.assign(
      PILOT_CHANNEL,
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      PENDING,
    );

    expect(result).not.toBeNull();
    expect(pool.broker_owns(PILOT_CHANNEL)).toBe(true);

    // Exactly two feeds: msg1 (first-turn driver) then the drained msg2 — one
    // session, ordered, one reply per message. No message dropped.
    expect(feed_spy).toHaveBeenCalledTimes(2);
    expect(feed_spy.mock.calls[0]![0]).toMatchObject({ content: "hello broker pilot" });
    expect(feed_spy.mock.calls[1]![0]).toMatchObject({
      content: "second message while cold-starting",
    });

    await broker.stop().catch(() => {});
  });

  it("delivers msg#1 BEFORE a concurrent msg2 that arrives during the assign yield window (#83 ordering)", async () => {
    // This is the real production race the #83 "ordered" invariant guards against.
    // Inside assign(), start_tmux → register_channel flips broker_owns → true while
    // the assign STILL holds its assigning_channels lock; there is then an
    // `await unlink(pending_json)` YIELD before msg#1 is fed. A concurrent msg2
    // arriving in that sub-window routes discord.ts → assign()→null (lock) →
    // deliver_or_buffer_broker_inbound. Ownership is already true — a naive
    // straight-through feed there lands msg2 AHEAD of msg#1 (queue order 2,1),
    // violating ordering. The fix buffers while the assign lock is held and drains
    // msg2 strictly after msg#1.
    //
    // We reproduce the yield injection deterministically by hooking the mocked
    // unlink (which IS the post-register/pre-feed yield inside assign()): when it
    // fires for the pending file, we fire msg2 through the real delivery path while
    // assigning_channels still holds the lock — exactly the concurrent arrival.
    await ensure_dir();
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = new DiscordBroker({
      config,
      socket_path: join(dir, "b.sock"),
      queue_path: join(dir, "q.json"),
    });
    const feed_spy = vi.spyOn(broker, "feed");
    pool.set_broker(broker);

    const state_dir = join(dir, "pool-4");
    const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await mkdir(state_dir, { recursive: true });
    pool.inject_bots([make_bot(4, state_dir)]);

    // Hook the unlink yield: when assign() unlinks pool-4's pending file (after it
    // registered ownership, before it feeds msg#1, lock still held), inject msg2
    // through the production concurrent-inbound path. Guard so it fires once.
    let injected = false;
    (unlink as unknown as Mock).mockImplementation((p: string) => {
      if (!injected && p === pending_json_path("pool-4")) {
        injected = true;
        // At this exact point: broker_owns === true, assigning_channels holds the
        // lock, msg#1 NOT yet fed. This is the window that used to reorder.
        expect(pool.broker_owns(PILOT_CHANNEL)).toBe(true);
        const taken = pool.deliver_or_buffer_broker_inbound(PILOT_CHANNEL, MSG2);
        expect(taken).toBe(true);
      }
      return Promise.resolve(undefined);
    });

    const result = await pool.assign(
      PILOT_CHANNEL,
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      PENDING,
    );

    expect(result).not.toBeNull();
    expect(pool.broker_owns(PILOT_CHANNEL)).toBe(true);

    // Exactly two feeds, and ORDER is msg#1 THEN msg2 — the invariant. Before the
    // fix, msg2 was fed straight through during the yield (call[0] === msg2),
    // failing this ordering assertion.
    expect(feed_spy).toHaveBeenCalledTimes(2);
    expect(feed_spy.mock.calls[0]![0]).toMatchObject({ content: "hello broker pilot" });
    expect(feed_spy.mock.calls[1]![0]).toMatchObject({
      content: "second message while cold-starting",
    });

    await broker.stop().catch(() => {});
  });

  it("feeds a concurrent inbound straight to the queue once the assign lock is released and ownership stands", async () => {
    await ensure_dir();
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = new DiscordBroker({
      config,
      socket_path: join(dir, "b.sock"),
      queue_path: join(dir, "q.json"),
    });
    pool.set_broker(broker);

    const state_dir = join(dir, "pool-4");
    const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await mkdir(state_dir, { recursive: true });
    pool.inject_bots([make_bot(4, state_dir)]);

    // The straight-through feed branch: ownership registered AND no assign in
    // flight (assigning_channels empty). This is the steady-follow-up window —
    // assign() already finished and released its lock, so msg#1 is provably in the
    // queue, and a later inbound is safe to feed directly (no reorder risk). We set
    // up exactly that: ownership registered, no assign lock held. (Contrast the
    // ordering test above, where the assign lock IS held mid-yield and the same
    // call buffers instead.)
    broker.register_channel(PILOT_CHANNEL, {
      bot_id: 4,
      state_dir,
      chunk_config: {},
    });
    expect(pool.broker_owns(PILOT_CHANNEL)).toBe(true);
    // No assign in flight — the discriminator that permits straight-through.
    expect(
      (pool as unknown as { assigning_channels: Set<string> }).assigning_channels.has(
        PILOT_CHANNEL,
      ),
    ).toBe(false);

    const feed_spy = vi.spyOn(broker, "feed");
    const taken = pool.deliver_or_buffer_broker_inbound(PILOT_CHANNEL, MSG2);

    expect(taken).toBe(true);
    // Fed straight through — ownership stands and no assign is racing, so the
    // message lands on the live session as an ordered follow-up rather than being
    // dropped as "busy".
    expect(feed_spy).toHaveBeenCalledTimes(1);
    expect(feed_spy.mock.calls[0]![0]).toMatchObject({ content: MSG2.content });

    await broker.stop().catch(() => {});
  });

  it("returns false for a plugin channel — caller takes the unchanged 'busy' path", async () => {
    await ensure_dir();
    const config = make_config(true); // broker ON, but PLUGIN_CHANNEL not a pilot
    const pool = new TestPool(config);
    const broker = new DiscordBroker({
      config,
      socket_path: join(dir, "b.sock"),
      queue_path: join(dir, "q.json"),
    });
    pool.set_broker(broker);

    const taken = pool.deliver_or_buffer_broker_inbound(PLUGIN_CHANNEL, {
      ...MSG2,
      channel_id: PLUGIN_CHANNEL,
    });

    expect(taken).toBe(false);

    await broker.stop().catch(() => {});
  });

  it("returns false when no cold-start is underway (genuinely exhausted pool)", async () => {
    await ensure_dir();
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = new DiscordBroker({
      config,
      socket_path: join(dir, "b.sock"),
      queue_path: join(dir, "q.json"),
    });
    pool.set_broker(broker);

    // No ownership, no in-flight assign → nothing to attach the message to.
    const taken = pool.deliver_or_buffer_broker_inbound(PILOT_CHANNEL, MSG2);

    expect(taken).toBe(false);

    await broker.stop().catch(() => {});
  });
});
