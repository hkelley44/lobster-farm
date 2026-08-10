/**
 * Gateway watchdog (#107) — deaf-connection detection for the daemon's single
 * Discord gateway.
 *
 * Centralizing inbound on one gateway (epic #84) makes that gateway a single
 * point of failure: if it silently dies, EVERY brokered channel goes dark at
 * once — and today's daemon gateway (slash commands, alert routing) has the
 * same exposure, which is why this watchdog is NOT broker-flag-gated. It is
 * pure detection/heal: zero behavior change while the gateway is healthy.
 *
 * Liveness signal: WS heartbeat-ack recency, NOT messageCreate recency — quiet
 * servers are legitimately silent for hours, but heartbeats always flow on a
 * live connection. On discord.js v14 (verified against 14.25.1) the client
 * mirrors @discordjs/ws `HeartbeatComplete` events onto each
 * `client.ws.shards` entry as `shard.lastPingTimestamp` (epoch ms of the last
 * acked heartbeat; -1 before the first ack). Discord's HELLO dictates the
 * heartbeat interval (~41.25s by default), so N missed intervals ≈ N × 41.25s
 * of ack silence.
 *
 * Decision rule (spec #107, Open Question 2 default): sustained silence of
 * `missed_intervals` (default 3 ≈ 2 min) heartbeat intervals while no shard is
 * in a connecting/resuming state → the gateway is dead and discord.js's own
 * recovery isn't running → destroy and re-login the client ("recycle").
 * While a shard IS connecting/resuming, discord.js's auto-reconnect owns
 * recovery and the watchdog stays out of the way.
 *
 * Alerting assumes Discord itself may be the sick component: the Sentry event
 * fires FIRST (out-of-band), then a best-effort Discord alert after the
 * recycle (when a fresh client may actually be able to deliver it).
 *
 * Everything is injectable (probe, recycle, alert, clock) so tests can drive
 * `tick()` deterministically with no real Discord and no real timers.
 */

import * as sentry from "./sentry.js";

/** Point-in-time gateway health, produced by the host's probe. */
export interface GatewaySnapshot {
  /** Epoch ms of the most recent heartbeat ack across all shards, or null if
   * no ack has been observed yet (fresh login). */
  last_heartbeat_ack_ms: number | null;
  /** True when any shard is actively connecting / identifying / resuming —
   * discord.js's own recovery is in flight, so the watchdog must not fire. */
  connecting: boolean;
}

export interface GatewayWatchdogOptions {
  /** Read the gateway's current health. Must never throw (a throw is treated
   * as "no signal", which counts toward silence). */
  probe: () => GatewaySnapshot;
  /** Destroy + re-login the client. Awaited; a rejection is captured and the
   * watchdog re-arms for another full threshold. */
  recycle: (reason: string) => Promise<void>;
  /** Best-effort Discord alert, called AFTER the Sentry event and AFTER the
   * recycle attempt. Failures are swallowed. */
  alert?: (message: string) => Promise<void>;
  /** Discord heartbeat interval. Default 41_250ms (discord.js v14 HELLO default). */
  heartbeat_interval_ms?: number;
  /** Consecutive missed heartbeat intervals that count as sustained death.
   * Default 3 (≈ 2 min). */
  missed_intervals?: number;
  /** How often the liveness check runs. Default 30s. */
  check_interval_ms?: number;
  /** Hard deadline on one `recycle()` attempt (destroy + login). A login
   * handshake can HANG (network partition, DNS stall) rather than reject —
   * without a deadline the `recycling` guard would stay latched and the
   * watchdog would go permanently silent, the exact wedge it exists to
   * prevent. On timeout the attempt is abandoned and the watchdog re-arms for
   * another full threshold. Default 60s. */
  recycle_timeout_ms?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

export class GatewayWatchdog {
  private readonly probe: () => GatewaySnapshot;
  private readonly recycle: (reason: string) => Promise<void>;
  private readonly alert?: (message: string) => Promise<void>;
  private readonly threshold_ms: number;
  private readonly check_interval_ms: number;
  private readonly recycle_timeout_ms: number;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Floor for the silence window: set at start(), after every recycle, and on
   * a connecting→not-connecting transition, so (a) a fresh login gets a full
   * threshold of grace before its first ack, (b) a recycle can't immediately
   * re-trigger, and (c) a just-completed resume isn't punished for its stale
   * pre-disruption ack timestamp. */
  private baseline_ms = 0;
  /** Re-entrancy guard: a recycle (destroy + login) spans multiple check
   * intervals; overlapping ticks must not stack recycles. Cleared even when
   * the recycle HANGS — see recycle_timeout_ms. */
  private recycling = false;
  /** True while the last-observed snapshot had a shard in a connecting state.
   * Lets tick() detect the connecting→not-connecting edge: at that moment
   * `shard.lastPingTimestamp` still holds the last PRE-disruption ack (the
   * first post-resume heartbeat is up to ~41s away), so without a baseline
   * reset a long-but-successful resume would be recycled the instant it
   * completed — the opposite of "transient resume never recycles". */
  private was_connecting = false;

  constructor(opts: GatewayWatchdogOptions) {
    this.probe = opts.probe;
    this.recycle = opts.recycle;
    this.alert = opts.alert;
    const heartbeat = opts.heartbeat_interval_ms ?? 41_250;
    const missed = opts.missed_intervals ?? 3;
    this.threshold_ms = heartbeat * missed;
    this.check_interval_ms = opts.check_interval_ms ?? 30_000;
    this.recycle_timeout_ms = opts.recycle_timeout_ms ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Start the periodic liveness check. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.baseline_ms = this.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.check_interval_ms);
    // Never keep the process alive just for the watchdog.
    this.timer.unref?.();
    console.log(
      `[gateway-watchdog] armed — recycle after ${String(Math.round(this.threshold_ms / 1000))}s ` +
        `of heartbeat-ack silence (check every ${String(this.check_interval_ms / 1000)}s)`,
    );
  }

  /** Stop the periodic check. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One liveness evaluation. Public so tests (and `force_recycle` callers) can
   * drive it deterministically without timers.
   */
  async tick(): Promise<void> {
    if (this.recycling) return;

    let snapshot: GatewaySnapshot;
    try {
      snapshot = this.probe();
    } catch (err) {
      // A throwing probe is itself a "no signal" — but log it, since it means
      // the host wiring is broken, not (necessarily) the gateway.
      console.error(`[gateway-watchdog] probe threw: ${String(err)}`);
      snapshot = { last_heartbeat_ack_ms: null, connecting: false };
    }

    if (snapshot.connecting) {
      // discord.js auto-reconnect is in flight — its recovery owns the
      // gateway right now. Transient disconnect/resume cycles land here and
      // must NOT trigger a recycle.
      this.was_connecting = true;
      return;
    }

    if (this.was_connecting) {
      // connecting→not-connecting edge: discord.js just finished a connect or
      // resume. The ack timestamp is still the last PRE-disruption one (next
      // heartbeat lands within ~1 interval), so grant the same grace a fresh
      // login gets — otherwise a legitimately-recovered connection would be
      // recycled on the first tick after a long outage.
      this.was_connecting = false;
      this.baseline_ms = this.now();
      console.log(
        "[gateway-watchdog] shard left connecting state — resume/reconnect complete; re-arming with a fresh grace window",
      );
      return;
    }

    const now = this.now();
    const last_signal = Math.max(snapshot.last_heartbeat_ack_ms ?? 0, this.baseline_ms);
    const silence_ms = now - last_signal;
    if (silence_ms < this.threshold_ms) return;

    await this.run_recycle(
      `no gateway heartbeat ack for ${String(Math.round(silence_ms / 1000))}s ` +
        `(threshold ${String(Math.round(this.threshold_ms / 1000))}s) with no reconnect in flight`,
    );
  }

  /**
   * Immediate recycle, bypassing the silence threshold — for signals that are
   * definitively terminal (e.g. discord.js `invalidated`, after which the
   * client will never reconnect on its own).
   */
  async force_recycle(reason: string): Promise<void> {
    if (this.recycling) return;
    await this.run_recycle(reason);
  }

  // ── Internal ──

  private async run_recycle(reason: string): Promise<void> {
    this.recycling = true;
    try {
      // Sentry FIRST — out-of-band of Discord, which may be the sick component.
      sentry.captureMessage(`Gateway watchdog recycling Discord client: ${reason}`, "error", {
        tags: { module: "gateway-watchdog" },
      });
      console.error(`[gateway-watchdog] gateway presumed dead — recycling client: ${reason}`);

      // Bound the attempt with a hard deadline: destroy+login can HANG (never
      // settle) under a network partition rather than reject, and an unguarded
      // await here would latch `recycling` forever — permanently silencing the
      // watchdog. On timeout the in-flight attempt is abandoned; that is safe
      // because the NEXT attempt's recycle destroys the abandoned client
      // before building a fresh one (see DiscordBot.recycle_client), and if
      // the abandoned login eventually completes on its own, the client it
      // logged in is the live `this.client` — also fine.
      let recycled = false;
      const attempt = this.recycle(reason).then(
        () => "ok" as const,
        (err: unknown) => ({ err }),
      );
      const deadline = new Promise<"timeout">((resolve) => {
        const t = setTimeout(() => resolve("timeout"), this.recycle_timeout_ms);
        t.unref?.();
      });
      const outcome = await Promise.race([attempt, deadline]);
      if (outcome === "ok") {
        recycled = true;
        console.log("[gateway-watchdog] client recycled — gateway re-login complete");
      } else if (outcome === "timeout") {
        console.error(
          `[gateway-watchdog] recycle TIMED OUT after ${String(this.recycle_timeout_ms)}ms — abandoning attempt, will retry after the next silence threshold`,
        );
        sentry.captureException(
          new Error(`gateway recycle timed out after ${String(this.recycle_timeout_ms)}ms`),
          { tags: { module: "gateway-watchdog", phase: "recycle-timeout" } },
        );
      } else {
        console.error(`[gateway-watchdog] recycle FAILED: ${String(outcome.err)}`);
        sentry.captureException(outcome.err, {
          tags: { module: "gateway-watchdog", phase: "recycle" },
        });
      }

      // Best-effort Discord alert AFTER the recycle attempt — on success the
      // fresh client can actually deliver it; on failure it's a hail mary.
      try {
        await this.alert?.(
          recycled
            ? `♻️ Discord gateway watchdog: gateway went silent (${reason}) — client recycled and reconnected.`
            : `🔴 Discord gateway watchdog: gateway went silent (${reason}) and the recycle FAILED — check daemon logs. Will retry after the next silence threshold.`,
        );
      } catch {
        // Expected when Discord itself is down — Sentry already has the event.
      }
    } finally {
      // Re-arm with a full grace window whether the recycle succeeded, failed,
      // or timed out: success needs time for the first ack; failure/timeout
      // retries after another full threshold instead of hot-looping
      // destroy/login. The connecting-edge tracker resets too — the recycle
      // replaced the client, so any pre-recycle state is stale.
      this.baseline_ms = this.now();
      this.was_connecting = false;
      this.recycling = false;
    }
  }
}
