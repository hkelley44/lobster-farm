/**
 * The four broker cold-path validations (#84 §4 G0.2), offline half.
 *
 * G0.2 names four scenarios and delegates them to live execution in
 * #broker-room-test. This file proves everything about them that can be proven
 * WITHOUT a daemon restart and WITHOUT a real Discord post, against the real
 * `queue.ts` / `server.ts` / `index.ts` / `protocol.ts` modules over a real
 * unix socket. The live remainder is in
 * `packages/daemon/scripts/broker-cold-path-live.sh`.
 *
 * EVERY test below is named `V<n>.<m> [OFFLINE]` and the describe block for
 * each validation opens with a comment stating what the validation's live-only
 * residue is. Read those comments as part of the assertions: a passing file
 * here is NOT a G0.2 pass, and #84 §10 is explicit that "no step may be
 * self-certified by an agent".
 *
 * Three structural limits apply to the whole file:
 *   L1  The `claude` CLI is absent. Whether a `notifications/claude/channel`
 *       that the shim successfully WROTE is actually routed into the session
 *       (vs. discarded with "Channel notifications skipped: …") is the exact
 *       thing #112/#113/#114/#115 each broke, and it is unobservable here.
 *       The stand-in's ack models the optimistic case by construction.
 *   L2  `pool.ts` is absent. "One session", "cold assign", "cold recreate" and
 *       "reply persists" are pool/tmux/JSONL properties.
 *   L3  Discord is absent. "Reply arrives", "exactly one reply", and reply
 *       authorship are REST/gateway properties.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueueEntry } from "../broker/queue.js";
import {
  RestartableBroker,
  ShimStandIn,
  make_meta,
  raw_broker,
  sleep,
} from "./helpers/broker-cold-path-harness.js";

const CHANNEL = "1537304019146645574"; // #broker-room-test — id only, never contacted
const BOT_ID = 3;

/** Fast but non-degenerate timings: redelivery window and sweep are short so a
 * "did it redeliver?" question resolves in ms, but they stay ordered
 * (sweep < window) exactly as production does (5s < 30s). */
const REDELIVER_MS = 150;
const SWEEP_MS = 25;

describe("broker cold-path harness (#84 §4 G0.2) — offline half", () => {
  let dir: string;
  let socket_path: string;
  let queue_path: string;
  let state_dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "broker-cold-path-"));
    // Own socket + own queue file, both under a temp dir. Never the live
    // ~/.lobsterfarm/state/broker.sock or broker-queue.json, and never a TCP
    // port — nothing here can collide with the running daemon.
    socket_path = join(dir, "harness-broker.sock");
    queue_path = join(dir, "harness-queue.json");
    state_dir = join(dir, `pool-${String(BOT_ID)}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fresh(opts: { redeliver_after_ms?: number; sweep_interval_ms?: number } = {}) {
    return new RestartableBroker(dir, socket_path, queue_path, {
      redeliver_after_ms: opts.redeliver_after_ms ?? REDELIVER_MS,
      sweep_interval_ms: opts.sweep_interval_ms ?? SWEEP_MS,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // V1 — restart → post → single cold assign → reply persists
  //
  // LIVE-ONLY RESIDUE: "restart" (launchd), "single cold assign" (one tmux
  // session, not two — pool.ts), "reply persists" (the reply reached Discord
  // AND the session JSONL exists on disk). None of those three exist in this
  // process. What IS provable offline is the transport contract the cold assign
  // hands to: one enqueue produces exactly one wire delivery with a
  // byte-identical payload, the reply tool round-trips with the owning
  // identity, and the ack clears the durable file.
  // ───────────────────────────────────────────────────────────────────────────
  describe("V1 — cold assign delivers once and the reply round-trips", () => {
    it("V1.1 [OFFLINE] one feed → exactly one wire inbound, payload byte-identical, ack clears the durable file", async () => {
      const broker = fresh();
      await broker.start();
      const shim = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
      try {
        // prepare_broker_session's half of cold start.
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        const meta = make_meta("msg-cold-1", { chat_id: CHANNEL });
        // assign()'s feed_broker_pending: message #1 is enqueued BEFORE any shim
        // exists — the defining property of a cold start.
        broker.current.feed({ channel_id: CHANNEL, content: "cold start one", meta });
        expect(broker.current.queue_depth(CHANNEL)).toBe(1);

        // Shim comes up and registers → backlog flush.
        await shim.connect_and_register();
        await shim.wait_for_inbound(1);

        expect(shim.inbound).toHaveLength(1);
        expect(shim.inbound[0]!.payload.content).toBe("cold start one");
        // Byte-identical meta is load-bearing: the shim passes it straight into
        // the MCP notification the CLI parses into the <channel …> block.
        expect(shim.inbound[0]!.payload.meta).toEqual(meta);

        // The ack (sent by the stand-in) must clear the entry permanently.
        await sleep(SWEEP_MS * 4);
        expect(broker.current.queue_depth(CHANNEL)).toBe(0);
        const file = await broker.read_queue_file();
        expect(file.entries).toHaveLength(0);

        // And no second delivery across several sweeps and a full redelivery
        // window — "single" in the gate's "single cold assign" sense, on the
        // transport. (It says nothing about how many tmux sessions exist.)
        await sleep(REDELIVER_MS * 2);
        expect(shim.inbound).toHaveLength(1);
      } finally {
        shim.kill();
        await broker.stop();
      }
    });

    it("V1.2 [OFFLINE] the reply tool round-trips through the real server with the owning (channel, bot) identity", async () => {
      // Uses the raw wiring so the outbound handler is observable. The real
      // OutboundExecutor is deliberately NOT reached — it would resolve a bot
      // token from <state_dir>/.env and call Discord REST.
      const calls: Array<{ channel_id: string; bot_id: number; tool: string }> = [];
      const { queue, server } = raw_broker({
        socket_path,
        queue_path,
        redeliver_after_ms: REDELIVER_MS,
        sweep_interval_ms: SWEEP_MS,
        outbound: async (channel_id, bot_id, tool) => {
          calls.push({ channel_id, bot_id, tool });
          return { text: "Sent to #broker-room-test", is_error: false };
        },
      });
      await queue.load();
      await server.start();
      const shim = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
      try {
        await shim.connect_and_register();
        const res = await shim.request_outbound("reply", {
          chat_id: CHANNEL,
          text: "offline harness reply",
        });
        // Verbatim pass-through — the agent sees the daemon's string unchanged.
        expect(res).toEqual({ text: "Sent to #broker-room-test", is_error: false });
        // Identity comes from the CONNECTION's register, not from the args.
        expect(calls).toEqual([{ channel_id: CHANNEL, bot_id: BOT_ID, tool: "reply" }]);
      } finally {
        shim.kill();
        await server.stop();
        await queue.flush().catch(() => {});
      }
    });

    it("V1.3 [OFFLINE] an outbound on a channel the broker does not own fails open with a string, never a throw", async () => {
      // This is the agent-visible symptom of the P1 ownership split-brain: the
      // shim is the transport but the facade lost ownership, so every reply the
      // agent attempts comes back as a tool error instead of hanging.
      const broker = fresh();
      await broker.start();
      const shim = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
      try {
        await shim.connect_and_register(); // registered on the wire …
        // … but register_channel was never called on the facade.
        const res = await shim.request_outbound("reply", { chat_id: CHANNEL, text: "x" });
        expect(res.is_error).toBe(true);
        expect(res.text).toContain("not owned by broker");
      } finally {
        shim.kill();
        await broker.stop();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // V2 — kill-session-mid-idle → released → post → cold recreate → reply
  //
  // LIVE-ONLY RESIDUE: nearly all of it. "kill-session" is a tmux kill,
  // "released" is pool.ts's release-to-dark, "cold recreate" is a fresh
  // assign() + CLI spawn through the dev-channels dialog, and "reply" is
  // Discord. Critically, V2.3 below shows WHY: once the channel is dark, a post
  // does not reach the queue at all — the queue is downstream of assign(), so
  // the offline harness cannot even see the inbound that triggers the recreate.
  // What is provable: the release-to-dark CONTRACT (#89/#90) — ownership drops,
  // the backlog survives, and a re-registering shim gets it back.
  // ───────────────────────────────────────────────────────────────────────────
  describe("V2 — release to dark, then cold recreate", () => {
    it("V2.1 [OFFLINE] killing an idle session's socket and deregistering leaves nothing stranded", async () => {
      const broker = fresh();
      await broker.start();
      const shim = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        await shim.connect_and_register();
        // Idle: nothing in flight.
        expect(broker.current.queue_depth(CHANNEL)).toBe(0);

        shim.kill(); // session process dies
        await sleep(SWEEP_MS * 3);
        broker.current.deregister_channel(CHANNEL); // pool's release-to-dark

        expect(broker.current.owns(CHANNEL)).toBe(false);
        expect(broker.current.queue_depth(CHANNEL)).toBe(0);
      } finally {
        await broker.stop();
      }
    });

    it("V2.2 [OFFLINE] killed mid-flight: deregister preserves the unacked entry and a re-registering shim gets it exactly once", async () => {
      const broker = fresh();
      await broker.start();
      const dying = new ShimStandIn({
        socket_path,
        channel_id: CHANNEL,
        bot_id: BOT_ID,
        ack_mode: "never", // the CLI never processed it → no ack
      });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        await dying.connect_and_register();
        broker.current.feed({
          channel_id: CHANNEL,
          content: "in flight when the session died",
          meta: make_meta("msg-inflight", { chat_id: CHANNEL }),
        });
        await dying.wait_for_inbound(1);
        const entry_id = dying.inbound[0]!.payload.id;

        dying.kill();
        broker.current.deregister_channel(CHANNEL);

        // #89: ownership gone, backlog intact — this is the whole point of
        // deregister_channel existing next to release_channel.
        expect(broker.current.owns(CHANNEL)).toBe(false);
        expect(broker.current.queue_depth(CHANNEL)).toBe(1);

        // Cold recreate: pool assigns again, prep re-registers, new shim connects.
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        const reborn = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
        await reborn.connect_and_register();
        await reborn.wait_for_inbound(1);

        expect(reborn.inbound).toHaveLength(1);
        expect(reborn.inbound[0]!.payload.id).toBe(entry_id); // same message, not a copy
        expect(reborn.inbound[0]!.payload.content).toBe("in flight when the session died");

        // And exactly once: no second copy across sweeps + a redelivery window.
        await sleep(REDELIVER_MS * 2);
        expect(reborn.inbound).toHaveLength(1);
        expect(broker.current.queue_depth(CHANNEL)).toBe(0); // acked away
        reborn.kill();
      } finally {
        await broker.stop();
      }
    });

    it("V2.3 [OFFLINE] while dark, feed() is a silent no-op — so the post that triggers the recreate is NOT observable in this harness", async () => {
      // Named as a limit, not a feature. `DiscordBroker.feed` returns early for
      // an unowned channel (broker/index.ts: `if (!owner) return;`). On the live
      // path the post instead goes discord.ts → pool.assign() → cold start →
      // feed_broker_pending. Nothing in this process can stand in for that, so
      // V2's "post → cold recreate" is live-only by construction.
      const broker = fresh();
      await broker.start();
      try {
        expect(broker.current.owns(CHANNEL)).toBe(false);
        broker.current.feed({
          channel_id: CHANNEL,
          content: "post that should wake the channel",
          meta: make_meta("msg-dark", { chat_id: CHANNEL }),
        });
        // Dropped, silently, by design — the queue never sees it.
        expect(broker.current.queue_depth(CHANNEL)).toBe(0);
        expect(
          (await broker.read_queue_file().catch(() => ({ entries: [] }))).entries,
        ).toHaveLength(0);
      } finally {
        await broker.stop();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // V3 — restart with an unacked queued message → redelivered exactly once
  //
  // LIVE-ONLY RESIDUE: the restart itself (process boundary, launchd, pool
  // re-assign, `--resume`). The harness restarts the broker OBJECT against the
  // same socket + same durable file, which exercises the real flush → load
  // round-trip but not the daemon lifecycle.
  //
  // This is the validation the harness can take furthest, and it is also where
  // it found the most. Note V3.4: after an ack the entry is DELETED, so the
  // delivery count is destroyed — "exactly once" has no post-hoc observable on
  // the daemon side at all. See the report.
  // ───────────────────────────────────────────────────────────────────────────
  describe("V3 — restart with an unacked message", () => {
    it("V3.1 [OFFLINE] unacked across a broker restart → redelivered exactly once (not zero, not twice)", async () => {
      const broker = fresh();
      await broker.start();
      const before = new ShimStandIn({
        socket_path,
        channel_id: CHANNEL,
        bot_id: BOT_ID,
        ack_mode: "never",
      });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        await before.connect_and_register();
        broker.current.feed({
          channel_id: CHANNEL,
          content: "survives the restart",
          meta: make_meta("msg-restart", { chat_id: CHANNEL }),
        });
        await before.wait_for_inbound(1);
        const entry_id = before.inbound[0]!.payload.id;
        before.kill();

        // Daemon goes down. stop() flushes the coalesced write first.
        await broker.stop();
        const persisted = await broker.read_queue_file();
        expect(persisted.entries).toHaveLength(1);
        expect(persisted.entries[0]!.id).toBe(entry_id);
        expect(persisted.entries[0]!.status).toBe("delivered");
        expect(persisted.entries[0]!.deliveries).toBe(1);

        // Daemon comes back: same socket, same durable file, fresh objects.
        await broker.restart();
        expect(broker.boot_count).toBe(2);
        // load() reset delivered → pending, because the shim that held it died
        // with the old daemon and will never ack.
        expect(broker.current.queue_depth(CHANNEL)).toBe(1);

        // Post-restart cold recreate registers ownership, then the shim connects.
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        const after = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
        await after.connect_and_register();
        await after.wait_for_inbound(1);

        // EXACTLY ONCE. Wait out several sweeps AND a full redelivery window
        // before asserting the count — a "once" that only holds for 20ms is not
        // the property the gate asks for.
        await sleep(Math.max(REDELIVER_MS * 3, SWEEP_MS * 10));
        expect(after.inbound).toHaveLength(1);
        expect(after.inbound[0]!.payload.id).toBe(entry_id);
        expect(after.inbound[0]!.payload.content).toBe("survives the restart");
        expect(broker.current.queue_depth(CHANNEL)).toBe(0);
        after.kill();
      } finally {
        await broker.stop();
      }
    });

    it("V3.2 [OFFLINE] a reconnect storm (repeated register on the same channel) does not duplicate a delivered-unacked entry", async () => {
      // The real shim re-sends `register` on every reconnect, and
      // handle_register unconditionally calls deliver_backlog. The guard against
      // a duplicate is deliverable_for's redelivery window, not the register
      // path — so this asserts the window actually holds.
      const broker = fresh({ redeliver_after_ms: 5_000 });
      await broker.start();
      const shim = new ShimStandIn({
        socket_path,
        channel_id: CHANNEL,
        bot_id: BOT_ID,
        ack_mode: "never",
      });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        broker.current.feed({
          channel_id: CHANNEL,
          content: "reconnect storm",
          meta: make_meta("msg-storm", { chat_id: CHANNEL }),
        });
        await shim.connect_and_register();
        await shim.wait_for_inbound(1);

        // Five more registers in quick succession, well inside the window.
        for (let i = 0; i < 5; i += 1) {
          const extra = new ShimStandIn({
            socket_path,
            channel_id: CHANNEL,
            bot_id: BOT_ID,
            ack_mode: "never",
          });
          await extra.connect_and_register();
          await sleep(10);
          expect(extra.inbound).toHaveLength(0); // window holds it back
          extra.kill();
        }
        expect(shim.inbound).toHaveLength(1);
      } finally {
        shim.kill();
        await broker.stop();
      }
    });

    it("V3.3 [OFFLINE] HAZARD: downtime longer than dead_letter_after_ms turns the restart redelivery into a dead-letter (redelivered ZERO times)", async () => {
      // `sweep_expired` measures age from `enqueued_at`, which is wall-clock, so
      // daemon downtime counts toward it. With the production default
      // (dead_letter_after_ms = 10 min, broker/server.ts:68 — NOT exposed on
      // DiscordBrokerOptions) a message enqueued just before a crash and
      // restored by a restart more than 10 minutes later is dead-lettered on the
      // first 5s sweep instead of being redelivered. The gate's wording
      // ("redelivered exactly once") is therefore only true for short outages.
      const broker = fresh({ redeliver_after_ms: 50_000 }); // keep attempts out of it
      await broker.start();
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        broker.current.feed({
          channel_id: CHANNEL,
          content: "enqueued right before the crash",
          meta: make_meta("msg-aged", { chat_id: CHANNEL }),
        });
        await broker.stop();

        // 11 minutes of downtime — past the 10 min default horizon.
        await broker.backdate_queue_file(11 * 60_000);
        await broker.restart();
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });

        // Let the first sweep land before any shim shows up — the common case,
        // since a cold CLI start takes seconds.
        await sleep(SWEEP_MS * 6);

        expect(broker.dead_letters).toHaveLength(1);
        expect(broker.dead_letters[0]!.content).toBe("enqueued right before the crash");
        // Zero deliveries: the message was never handed to any shim.
        expect(broker.dead_letters[0]!.deliveries).toBe(0);

        // A shim arriving afterwards gets nothing — dead entries are skipped.
        const late = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
        await late.connect_and_register();
        await sleep(SWEEP_MS * 6);
        expect(late.inbound).toHaveLength(0);
        late.kill();
      } finally {
        await broker.stop();
      }
    });

    it("V3.4 [OFFLINE] HAZARD: the age sweep ignores status, so a message can be delivered AND dead-lettered on the same restart", async () => {
      // Same setup as V3.3 but the shim wins the race and registers before the
      // first sweep. The entry is delivered (deliveries → 1) and then
      // age-swept anyway, because sweep_expired only skips status === "dead".
      // Live consequence: the agent runs the turn and replies, while
      // handle_dead_letter concurrently alerts #alerts AND releases the owning
      // session to dark — a reply plus a spurious "message was dropped" alert
      // plus a recycled session, all for one successfully handled message.
      const broker = fresh({ redeliver_after_ms: 50_000, sweep_interval_ms: 400 });
      await broker.start();
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        broker.current.feed({
          channel_id: CHANNEL,
          content: "delivered and dead-lettered",
          meta: make_meta("msg-both", { chat_id: CHANNEL }),
        });
        await broker.stop();
        await broker.backdate_queue_file(11 * 60_000);
        await broker.restart();
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });

        // Shim registers immediately — beats the 400ms sweep.
        const shim = new ShimStandIn({
          socket_path,
          channel_id: CHANNEL,
          bot_id: BOT_ID,
          ack_mode: "never", // the turn is still running when the sweep fires
        });
        await shim.connect_and_register();
        await shim.wait_for_inbound(1);
        expect(shim.inbound).toHaveLength(1); // delivered to the agent

        await sleep(1200); // let a sweep land
        expect(broker.dead_letters).toHaveLength(1); // …and dead-lettered too
        expect(broker.dead_letters[0]!.deliveries).toBe(1);
        shim.kill();
      } finally {
        await broker.stop();
      }
    });

    it("V3.5 [OFFLINE] OBSERVABILITY: an ack deletes the entry, so the delivery count is unrecoverable after the fact", async () => {
      // Why this matters for the live run: there is no daemon log line for a
      // delivery or a redelivery anywhere in the codebase (verified by grep —
      // no emitted string contains "Redeliver"), and `ack` removes the entry
      // outright. So after a successful round-trip NOTHING on the daemon side
      // records how many times the message was delivered. "Exactly once" must
      // be measured in-flight (poll broker-queue.json before the ack) or on the
      // far side (count replies in Discord / turns in the session JSONL).
      const broker = fresh();
      await broker.start();
      const shim = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        broker.current.feed({
          channel_id: CHANNEL,
          content: "count me",
          meta: make_meta("msg-count", { chat_id: CHANNEL }),
        });
        await shim.connect_and_register();
        await shim.wait_for_inbound(1);
        await sleep(SWEEP_MS * 4);

        const file = await broker.read_queue_file();
        expect(file.entries).toHaveLength(0);
        // No surviving record anywhere of `deliveries: 1`.
        const any_count = (file.entries as QueueEntry[]).some((e) => e.deliveries > 0);
        expect(any_count).toBe(false);
      } finally {
        shim.kill();
        await broker.stop();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // V4 — rapid double-post during cold start → one session, two ordered
  //      replies, no duplicate
  //
  // LIVE-ONLY RESIDUE: "one session" (pool.ts's assigning_channels lock + one
  // tmux pane) and "two replies" (Discord). The pool-side ordering through the
  // assign yield window already has an offline test at
  // broker-first-message.test.ts:356 — but that test asserts on a spy over
  // `broker.feed`, i.e. it stops at the queue's front door. What was NOT
  // covered, and is covered here, is whether that order survives the queue's
  // own sort, the socket, and redelivery.
  // ───────────────────────────────────────────────────────────────────────────
  describe("V4 — rapid double-post during cold start", () => {
    it("V4.1 [OFFLINE] two feeds before any shim exists → exactly two wire inbound, in enqueue order", async () => {
      const broker = fresh();
      await broker.start();
      const shim = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        // True cold start: both messages land while the channel has no shim.
        broker.current.feed({
          channel_id: CHANNEL,
          content: "first",
          meta: make_meta("m1", { chat_id: CHANNEL }),
        });
        broker.current.feed({
          channel_id: CHANNEL,
          content: "second",
          meta: make_meta("m2", { chat_id: CHANNEL }),
        });
        expect(broker.current.queue_depth(CHANNEL)).toBe(2);

        await shim.connect_and_register();
        await shim.wait_for_inbound(2);
        await sleep(REDELIVER_MS * 2);

        // Two, ordered, no duplicate.
        expect(shim.inbound.map((i) => i.payload.content)).toEqual(["first", "second"]);
        expect(shim.inbound).toHaveLength(2);
        expect(new Set(shim.inbound.map((i) => i.payload.id)).size).toBe(2);
        expect(broker.current.queue_depth(CHANNEL)).toBe(0);
      } finally {
        shim.kill();
        await broker.stop();
      }
    });

    it("V4.2 [OFFLINE] an exact enqueued_at tie still delivers in enqueue order (deliverable_for's sort is stable)", async () => {
      // `deliverable_for` orders by `enqueued_at.localeCompare`, and
      // `enqueued_at` has only millisecond resolution. Two posts inside the same
      // millisecond — which is exactly what "rapid double-post" means — produce
      // an exact tie, after which ordering rests entirely on Array#sort being
      // stable (ES2019+) over Map insertion order. That is load-bearing and
      // undocumented, so it gets an explicit test: force the tie rather than
      // hoping for it.
      const { queue, server } = raw_broker({
        socket_path,
        queue_path,
        redeliver_after_ms: REDELIVER_MS,
        sweep_interval_ms: SWEEP_MS,
      });
      await queue.load();
      await server.start();
      const shim = new ShimStandIn({ socket_path, channel_id: CHANNEL, bot_id: BOT_ID });
      try {
        const a = queue.enqueue({
          channel_id: CHANNEL,
          bot_id: BOT_ID,
          content: "first",
          meta: make_meta("m1", { chat_id: CHANNEL }),
        });
        const b = queue.enqueue({
          channel_id: CHANNEL,
          bot_id: BOT_ID,
          content: "second",
          meta: make_meta("m2", { chat_id: CHANNEL }),
        });
        // Force the exact tie (`all()` hands back the live entry objects).
        const tie = "2026-10-31T12:00:00.000Z";
        for (const e of queue.all()) e.enqueued_at = tie;
        expect(queue.deliverable_for(CHANNEL).map((e) => e.id)).toEqual([a.id, b.id]);

        await shim.connect_and_register();
        await shim.wait_for_inbound(2);
        expect(shim.inbound.map((i) => i.payload.content)).toEqual(["first", "second"]);
      } finally {
        shim.kill();
        await server.stop();
        await queue.flush().catch(() => {});
      }
    });

    it("V4.3 [OFFLINE] msg2 arriving while msg1 is delivered-but-unacked goes out after msg1, with no duplicate of msg1", async () => {
      const broker = fresh({ redeliver_after_ms: 5_000 });
      await broker.start();
      const shim = new ShimStandIn({
        socket_path,
        channel_id: CHANNEL,
        bot_id: BOT_ID,
        ack_mode: "never", // agent is still mid-turn on msg1
      });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        await shim.connect_and_register();
        broker.current.feed({
          channel_id: CHANNEL,
          content: "first",
          meta: make_meta("m1", { chat_id: CHANNEL }),
        });
        await shim.wait_for_inbound(1);
        broker.current.feed({
          channel_id: CHANNEL,
          content: "second",
          meta: make_meta("m2", { chat_id: CHANNEL }),
        });
        await shim.wait_for_inbound(2);
        await sleep(SWEEP_MS * 8);

        expect(shim.inbound.map((i) => i.payload.content)).toEqual(["first", "second"]);
      } finally {
        shim.kill();
        await broker.stop();
      }
    });

    it("V4.4 [OFFLINE] HAZARD: if msg1 is never acked, its redelivery lands AFTER msg2 — the agent sees 1, 2, 1", async () => {
      // At-least-once delivery cannot preserve order across a redelivery, and
      // nothing in the broker tries to. If the CLI drops msg1's notification
      // (the #112/#114 failure mode — invisible to the shim, which acks only its
      // own successful write) while msg2 is handled normally, the agent's turn
      // sequence becomes msg1, msg2, msg1. The gate's "two ordered replies, no
      // duplicate" therefore holds only when every ack lands.
      const broker = fresh({ redeliver_after_ms: 200, sweep_interval_ms: 25 });
      await broker.start();
      const shim = new ShimStandIn({
        socket_path,
        channel_id: CHANNEL,
        bot_id: BOT_ID,
        ack_mode: "never",
      });
      try {
        broker.current.register_channel(CHANNEL, { bot_id: BOT_ID, state_dir, chunk_config: {} });
        await shim.connect_and_register();
        broker.current.feed({
          channel_id: CHANNEL,
          content: "first",
          meta: make_meta("m1", { chat_id: CHANNEL }),
        });
        await shim.wait_for_inbound(1);
        const m1_id = shim.inbound[0]!.payload.id;
        broker.current.feed({
          channel_id: CHANNEL,
          content: "second",
          meta: make_meta("m2", { chat_id: CHANNEL }),
        });
        await shim.wait_for_inbound(2);
        shim.ack(shim.inbound[1]!.payload.id); // msg2 handled fine

        await shim.wait_for_inbound(3, 2000);
        expect(shim.inbound.map((i) => i.payload.content)).toEqual(["first", "second", "first"]);
        expect(shim.inbound[2]!.payload.id).toBe(m1_id); // a redelivery, not a new message
      } finally {
        shim.kill();
        await broker.stop();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-cutting: the readiness claim in #84 §3 P5.
  // ───────────────────────────────────────────────────────────────────────────
  describe("readiness verification (#84 §3 P5)", () => {
    it("R1 [OFFLINE] the shim's only startup signal is a stderr line, and it is not the string wait_for_bot_ready looks for", async () => {
      // Asserted against the source text on purpose: the claim under test is
      // about which literals exist, and a behavioural test would need the CLI.
      const { readFile } = await import("node:fs/promises");
      const here = new URL(".", import.meta.url).pathname;
      const shim_src = await readFile(join(here, "../shim/discord-shim.ts"), "utf-8");
      const pool_src = await readFile(join(here, "../pool.ts"), "utf-8");

      // The readiness predicate's literal…
      expect(pool_src).toContain('output.includes("Listening for channel messages")');
      // …appears nowhere in the shim.
      expect(shim_src).not.toContain("Listening for channel messages");
      // What the shim DOES print, and only to stderr (tmux pane, not the daemon log).
      expect(shim_src).toContain("lf-discord-shim: connected to broker for channel");

      // Both readiness helpers are exported and called by nothing but tests.
      const prod_calls = pool_src
        .split("\n")
        .filter((l) => /wait_for_bot_ready(_with_retries)?\s*\(/.test(l))
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
        .filter((l) => !/export async function/.test(l));
      // The single remaining hit is the internal call inside
      // wait_for_bot_ready_with_retries — i.e. no external production caller.
      expect(prod_calls).toHaveLength(1);
      expect(prod_calls[0]).toContain("const ready = await wait_for_bot_ready(");
    });
  });
});
