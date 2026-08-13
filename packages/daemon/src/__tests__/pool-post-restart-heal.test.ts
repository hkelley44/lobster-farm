/**
 * Post-restart pool auto-heal (#106).
 *
 * The 2026-08-01→08-04 incident: a daemon restart proactively resumed pool
 * sessions that came back alive in tmux but never re-established Discord
 * message delivery — empty prompts, `no transcript` — and the rooms stayed
 * silently dark for days until an operator manually recycled each bot
 * (POST /pool/release + /pool/assign).
 *
 * These tests pin the automated version of that fix:
 *   - `resume_parked_bots` arms probation (+ the probe's inbound marker) for
 *     every resumed bot whose resume nudge was actually injected;
 *   - `heal_post_restart` recycles exactly the sessions with ZERO evidence of
 *     having run a turn since resume, emits one aggregate alert listing what
 *     was healed, and — critically — leaves quiet-but-healthy sessions alone
 *     (the false-positive guard).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedPoolBot } from "../persistence.js";
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// notify() makes a Discord webhook call — mock it so the aggregate heal alert
// can be asserted on without touching the network.
const { notify_mock } = vi.hoisted(() => ({ notify_mock: vi.fn(async () => {}) }));
vi.mock("../actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../actions.js")>();
  return { ...actual, notify: notify_mock };
});

// Mock fs writes so the resume-nudge pending file and pool persistence never
// touch the real filesystem.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(""),
    spawn: vi.fn(),
  };
});

import { writeFile } from "node:fs/promises";

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

function make_candidate(
  id: number,
  channel_id: string,
  session_id: string,
  entity_id = "lobster-farm",
): PersistedPoolBot {
  return {
    id,
    state: "assigned",
    channel_id,
    entity_id,
    archetype: "planner",
    channel_type: null,
    session_id,
    last_active: new Date().toISOString(),
  };
}

/**
 * Test pool with controllable pane-idle state and JSONL-activity evidence, so
 * a "resumed but never ran a turn" session can be simulated without tmux or
 * real transcripts.
 */
class TestBotPool extends BotPoolTestBase {
  private idle = new Map<number, boolean>();
  /** session_id → "JSONL modified since baseline" */
  private jsonl_activity = new Map<string, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  inject_resume_candidates(candidates: PersistedPoolBot[]): void {
    (this as unknown as { resume_candidates: PersistedPoolBot[] }).resume_candidates = candidates;
  }

  set_bot_idle_state(bot_id: number, idle: boolean): void {
    this.idle.set(bot_id, idle);
  }

  set_jsonl_activity(session_id: string, active: boolean): void {
    this.jsonl_activity.set(session_id, active);
  }

  // Default idle — the dangerous state the heal must judge correctly.
  override is_bot_idle(bot: PoolBot): boolean {
    return this.idle.get(bot.id) ?? true;
  }

  protected override async session_jsonl_modified_since(session_id: string): Promise<boolean> {
    return this.jsonl_activity.get(session_id) ?? false;
  }

  async run_heal(): Promise<void> {
    await (this as unknown as { heal_post_restart: () => Promise<void> }).heal_post_restart();
  }

  probation_size(): number {
    return (this as unknown as { post_restart_probation: Map<number, unknown> })
      .post_restart_probation.size;
  }
}

describe("post-restart pool auto-heal (#106)", () => {
  let pool: TestBotPool;
  let start_tmux_spy: Mock;

  /** Park a bot + register it as a resume candidate, then run the resume. */
  async function resume_bots(
    entries: Array<{ id: number; channel_id: string; session_id: string }>,
  ): Promise<void> {
    pool.inject_bots(
      entries.map((e) =>
        make_bot({
          id: e.id,
          state: "parked",
          channel_id: e.channel_id,
          entity_id: "lobster-farm",
          archetype: "planner",
          session_id: e.session_id,
        }),
      ),
    );
    pool.inject_resume_candidates(
      entries.map((e) => make_candidate(e.id, e.channel_id, e.session_id)),
    );
    await pool.resume_parked_bots();
  }

  /**
   * Age the resumed bots past the liveness warm-up window (#106 review).
   * `heal_post_restart` refuses to judge a session younger than
   * LIVENESS_WARMUP_MS (boot-noise readings are untrustworthy); real runs
   * satisfy this because the heal fires minutes after resume. Tests call the
   * heal immediately, so they backdate `assigned_at` to simulate that gap.
   */
  function age_bots(ms = 10 * 60 * 1000): void {
    for (const bot of pool.get_bots()) {
      if (bot.assigned_at) bot.assigned_at = new Date(bot.assigned_at.getTime() - ms);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    temp_dir = join(tmpdir(), `pool-post-restart-heal-${Date.now()}`);
    pool = new TestBotPool(make_config());

    for (const method of [
      "kill_tmux",
      "write_access_json",
      "set_bot_nickname",
      "set_bot_avatar",
      "persist",
    ] as const) {
      vi.spyOn(pool as unknown as Record<string, unknown>, method as never).mockImplementation(
        (() => undefined) as never,
      );
    }
    start_tmux_spy = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never) as unknown as Mock;
    // Sessions are alive in tmux — the incident state is alive-but-deaf, and
    // dead tmux belongs to the crash-restart machinery, not this heal.
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      true as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("arms probation + the probe's inbound marker for a resumed bot whose nudge was injected", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);

    const bot = pool.get_bots()[0]!;
    expect(bot.state).toBe("assigned");
    // The nudge is a genuinely injected message — the steady-state probe is
    // armed so a deaf resume is also catchable at the 90s threshold.
    expect(bot.last_inbound_at).not.toBeNull();
    expect(pool.probation_size()).toBe(1);
  });

  it("does NOT arm probation when the nudge write failed (an idle session with nothing injected is not deaf)", async () => {
    (writeFile as Mock).mockRejectedValueOnce(new Error("disk full"));

    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);

    const bot = pool.get_bots()[0]!;
    expect(bot.state).toBe("assigned");
    expect(bot.last_inbound_at).toBeNull();
    expect(pool.probation_size()).toBe(0);

    await pool.run_heal();
    // Nothing to judge — no recycle beyond the original resume spawn, no alert.
    expect(start_tmux_spy).toHaveBeenCalledTimes(1);
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("recycles a resumed session with zero turn evidence and alerts what was healed", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);
    age_bots(); // past the liveness warm-up — readings are trustworthy now
    // Idle pane, no stop-hook stamp, no JSONL activity → the deaf signature.
    pool.set_bot_idle_state(3, true);
    pool.set_jsonl_activity("sess-aaa", false);

    await pool.run_heal();

    // One spawn for the resume, one for the recycle's fresh assignment.
    expect(start_tmux_spy).toHaveBeenCalledTimes(2);
    const recycle_args = start_tmux_spy.mock.calls[1] as unknown[];
    // The recycle resumes the stashed session for conversation continuity...
    expect(recycle_args[4]).toBe("sess-aaa");
    expect(recycle_args[5]).toBe(true);
    // ...and injects a recovery message to drive the fresh session's first turn.
    expect((recycle_args[6] as Record<string, string>).LF_PENDING_FILE).toBeDefined();

    // The channel is responsive again: an assigned bot with the session.
    const assigned = pool
      .get_bots()
      .find((b) => b.channel_id === "ch-general" && b.state === "assigned");
    expect(assigned).toBeDefined();

    // One aggregate alert naming the healed channel; probation fully consumed.
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    expect(
      messages.some((m) => m.includes("Post-restart auto-heal") && m.includes("ch-general")),
    ).toBe(true);
    expect(pool.probation_size()).toBe(0);
  });

  it("leaves a quiet-but-healthy session alone when the stop hook stamped its nudge turn", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);

    age_bots();
    // The session processed its resume nudge (Stop hook fired), then went
    // legitimately idle in a quiet room. A quiet channel is not a deaf channel.
    pool.mark_processed("sess-aaa");
    pool.set_bot_idle_state(3, true);
    pool.set_jsonl_activity("sess-aaa", false);

    await pool.run_heal();

    expect(start_tmux_spy).toHaveBeenCalledTimes(1); // resume only — no recycle
    expect(notify_mock).not.toHaveBeenCalled();
    const bot = pool.get_bots()[0]!;
    expect(bot.state).toBe("assigned");
    expect(bot.session_id).toBe("sess-aaa");
  });

  it("treats JSONL activity since resume as healthy even without a stop-hook stamp", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);
    age_bots();
    pool.set_bot_idle_state(3, true);
    // The transcript moved since the resume — a turn ran (or is running),
    // regardless of what the pane heuristic thinks.
    pool.set_jsonl_activity("sess-aaa", true);

    await pool.run_heal();

    expect(start_tmux_spy).toHaveBeenCalledTimes(1);
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("treats a visibly-working pane as healthy (long first turn in flight)", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);
    age_bots();
    pool.set_bot_idle_state(3, false);
    pool.set_jsonl_activity("sess-aaa", false);

    await pool.run_heal();

    expect(start_tmux_spy).toHaveBeenCalledTimes(1);
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("skips probation entries whose assignment moved on before the heal ran", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);
    // The channel was released (operator action, eviction, …) before the pass.
    const bot = pool.get_bots()[0]!;
    bot.state = "free";
    bot.channel_id = null;
    bot.session_id = null;

    await pool.run_heal();

    expect(start_tmux_spy).toHaveBeenCalledTimes(1);
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("regression: restart with one healthy and one deaf resume → every channel responsive again, only the deaf one recycled", async () => {
    await resume_bots([
      { id: 3, channel_id: "ch-general", session_id: "sess-aaa" },
      { id: 4, channel_id: "ch-homepage", session_id: "sess-bbb" },
    ]);

    age_bots();
    // Bot 3 processed its nudge; bot 4 is the incident signature.
    pool.mark_processed("sess-aaa");
    pool.set_bot_idle_state(3, true);
    pool.set_bot_idle_state(4, true);
    pool.set_jsonl_activity("sess-aaa", false);
    pool.set_jsonl_activity("sess-bbb", false);

    await pool.run_heal();

    // 2 resume spawns + exactly 1 recycle spawn (for bot 4's channel).
    expect(start_tmux_spy).toHaveBeenCalledTimes(3);

    // Every previously-assigned channel has an assigned bot again.
    for (const channel of ["ch-general", "ch-homepage"]) {
      const assigned = pool
        .get_bots()
        .find((b) => b.channel_id === channel && b.state === "assigned");
      expect(assigned, `channel ${channel} must be responsive after the heal`).toBeDefined();
    }

    // The aggregate alert names only the healed channel.
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    const heal_alert = messages.find((m) => m.includes("Post-restart auto-heal"));
    expect(heal_alert).toBeDefined();
    expect(heal_alert).toContain("ch-homepage");
    expect(heal_alert).not.toContain("ch-general");
  });

  it("refuses to judge a session still inside the liveness warm-up window (#106 review)", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);
    // NOT aged: assigned_at ≈ now, so boot-noise readings are untrustworthy.
    // Deaf-looking evidence must NOT trigger a recycle yet.
    pool.set_bot_idle_state(3, true);
    pool.set_jsonl_activity("sess-aaa", false);

    await pool.run_heal();

    // No recycle, no alert — and the armed marker survives so the steady-state
    // probe judges the session once it clears warm-up.
    expect(start_tmux_spy).toHaveBeenCalledTimes(1); // resume spawn only
    expect(notify_mock).not.toHaveBeenCalled();
    const bot = pool.get_bots()[0]!;
    expect(bot.state).toBe("assigned");
    expect(bot.last_inbound_at).not.toBeNull();
    // Pin the real post-skip state: the pass is one-shot, so the probation
    // entry is CONSUMED on warm-up skip (nothing re-schedules this pass) —
    // the fallback for a genuinely-deaf session is the steady-state probe
    // reading the still-armed marker above, not a second heal pass.
    expect(pool.probation_size()).toBe(0);
  });

  it("stops recycling when a drain starts (shutdown safety)", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);
    age_bots();
    pool.set_bot_idle_state(3, true);
    pool.set_jsonl_activity("sess-aaa", false);

    (pool as unknown as { _draining: boolean })._draining = true;
    await pool.run_heal();

    // Draining daemon must not release/reassign anything.
    expect(start_tmux_spy).toHaveBeenCalledTimes(1); // resume spawn only
    expect(notify_mock).not.toHaveBeenCalled();
  });

  it("schedule_post_restart_heal is a no-op when nothing is on probation", async () => {
    vi.useFakeTimers();
    try {
      pool.schedule_post_restart_heal(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(notify_mock).not.toHaveBeenCalled();
      expect(start_tmux_spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedule_post_restart_heal runs the pass after the delay", async () => {
    await resume_bots([{ id: 3, channel_id: "ch-general", session_id: "sess-aaa" }]);
    age_bots();
    pool.set_bot_idle_state(3, true);
    pool.set_jsonl_activity("sess-aaa", false);

    vi.useFakeTimers();
    try {
      pool.schedule_post_restart_heal(1_000);
      expect(start_tmux_spy).toHaveBeenCalledTimes(1); // not yet
      await vi.advanceTimersByTimeAsync(1_500);
      // Let the async heal settle.
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(start_tmux_spy).toHaveBeenCalledTimes(2);
    const messages = notify_mock.mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => m.includes("Post-restart auto-heal"))).toBe(true);
  });
});
