import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArchetypeRole, LobsterFarmConfig } from "@lobster-farm/shared";
import { DEFAULT_ARCHETYPES, entity_dir, expand_home, lobsterfarm_dir } from "@lobster-farm/shared";
import type { ChannelType } from "@lobster-farm/shared";
import { notify } from "./actions.js";
import type { ChannelOwnership, DiscordBroker } from "./broker/index.js";
import { SHIM_MCP_SERVER_KEY } from "./broker/protocol.js";
import type { InboundMeta } from "./broker/protocol.js";
import { resolve_binary } from "./env.js";
import { NO_SESSION, extract_session_learnings } from "./hooks.js";
import { resolve_effort, resolve_model_id } from "./models.js";
import { load_pool_state, save_pool_state } from "./persistence.js";
import type { PersistedBotAvatarState, PersistedPoolBot } from "./persistence.js";
import {
  LIVENESS_WARMUP_MS,
  PLUGIN_DEAF_THRESHOLD_MS,
  evaluate_plugin_liveness,
  is_tmux_session_idle,
} from "./plugin-liveness.js";
import { scan_and_recover } from "./rate-limit-recovery.js";
import type { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";
import { find_session_file } from "./session-context.js";
import { sq } from "./shell.js";

// ── Types ──

export interface PoolBot {
  id: number;
  state: "free" | "assigned" | "parked";
  channel_id: string | null;
  entity_id: string | null;
  archetype: ArchetypeRole | null;
  channel_type: ChannelType | null;
  session_id: string | null;
  /** True once the Claude Code JSONL transcript for `session_id` has been observed
   * on disk — only confirmed sessions are persisted to pool-state.json, so a
   * daemon restart during the pre-confirmation window will never try to
   * `--resume` a phantom session that Claude never materialized. See issue #256. */
  session_confirmed: boolean;
  tmux_session: string;
  last_active: Date | null;
  /** When this bot was assigned to its current channel. Used for uptime calculation. */
  assigned_at: Date | null;
  /** When the daemon last routed an inbound human message to this assigned bot.
   * Set at the discord.ts steady-state `touch()` call-site. Drives the
   * plugin-liveness probe (#73): the inbound→bot path is pure MCP plugin with
   * no daemon send-keys, so this timestamp is the daemon's only record that a
   * message was handed to a live-but-possibly-deaf bot. In-memory only —
   * never persisted (a fresh daemon has no in-flight inbound to probe). */
  last_inbound_at: Date | null;
  /** When the plugin-liveness probe (#73) last observed this bot actually
   * processing (tmux pane non-idle). Used to distinguish "received the inbound
   * and started working" (healthy) from "stayed idle at the prompt the whole
   * time" (plugin deaf). In-memory only. */
  last_processing_at: Date | null;
  state_dir: string;
  /** Claude CLI model ID used for this session (e.g., "claude-opus-4-6"). */
  model: string | null;
  /** Claude CLI effort level used for this session (e.g., "high"). */
  effort: string | null;
  /** The archetype whose avatar was last set on this bot's Discord profile.
   * Used to skip redundant avatar updates when the archetype hasn't changed. */
  last_avatar_archetype: ArchetypeRole | null;
  /** When the avatar was last set via the Discord API. Used for rate limit safety
   * (~2 changes per hour per bot, we enforce a 30-minute cooldown). */
  last_avatar_set_at: Date | null;
}

export interface PoolAssignment {
  bot_id: number;
  channel_id: string;
  entity_id: string;
  archetype: ArchetypeRole;
  session_id: string | null;
  tmux_session: string;
}

export interface PoolStatus {
  total: number;
  free: number;
  assigned: number;
  parked: number;
  assignments: Array<{
    bot_id: number;
    channel_id: string;
    entity_id: string;
    archetype: string;
    state: string;
    last_active: string | null;
  }>;
}

/** Activity state computed on demand from observable signals (tmux pane, timestamps). */
export type ActivityState = "idle" | "working" | "waiting_for_human" | "active_conversation";

// ── Tmux idle detection ──

/** Re-exported from the shared probe module so existing pool importers keep
 * working. The live pane-idle reading is shared with the commander probe (#77). */
export { is_tmux_session_idle };

// ── Pending file paths ──

/** Canonical path for the legacy pending-message .txt file used by the
 * tmux send-keys drain path. Retained for backward compatibility with
 * drain_pending_files() (belt-and-suspenders — see issue #279). */
export function pending_file_path(tmux_session: string): string {
  return `/tmp/lf-pending-${tmux_session}.txt`;
}

/** Canonical path for the SessionStart-hook pending-message JSON file.
 * Written by the daemon before spawning `claude`; consumed by the
 * session-start-inject.sh hook during Claude CLI init. See issue #290. */
export function pending_json_path(tmux_session: string): string {
  return `/tmp/lf-pending-${tmux_session}.json`;
}

/** Payload written to pending_json_path(). Keep field names stable —
 * session-start-inject.sh parses this directly via jq. */
export interface PendingMessage {
  /** Display name of the Discord user who sent the message. */
  user: string;
  /** Discord channel ID where the message was sent. */
  channel_id: string;
  /** Discord message ID (Snowflake), for future reply-to support. */
  message_id: string;
  /** Raw message content. */
  content: string;
  /** ISO-8601 timestamp of when the daemon received the message. */
  ts: string;
}

/** Write a PendingMessage to the session's JSON pending-file path.
 * Returns the absolute file path so callers can set LF_PENDING_FILE on the
 * spawn env. Best-effort — throws only on unexpected filesystem errors. */
export async function write_pending_message(
  tmux_session: string,
  msg: PendingMessage,
): Promise<string> {
  const path = pending_json_path(tmux_session);
  await writeFile(path, `${JSON.stringify(msg)}\n`, "utf-8");
  return path;
}

// ── Bot readiness polling ──

/**
 * Poll a tmux pane until the Claude Code bot is ready (prompt + plugin indicators).
 *
 * Ready when the pane output contains "❯" OR "bypass permissions" — these indicate
 * the Claude process is at the prompt and the MCP plugin is connected.
 *
 * Returns true if the bot became ready within the timeout, false otherwise.
 */
export async function wait_for_bot_ready(
  tmux_session: string,
  opts?: { timeout_ms?: number; poll_ms?: number },
): Promise<boolean> {
  const timeout = opts?.timeout_ms ?? 30_000;
  const poll = opts?.poll_ms ?? 500;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, poll));
    try {
      const output = execFileSync("tmux", ["capture-pane", "-t", tmux_session, "-p"], {
        encoding: "utf-8",
        timeout: 2000,
      });
      if (
        output.includes("Listening for channel messages") &&
        (output.includes("❯") || output.includes("bypass permissions"))
      ) {
        return true;
      }
    } catch {
      /* tmux pane not ready yet */
    }
  }
  return false;
}

/**
 * Wait for a bot to be ready with retries and tmux liveness checks.
 *
 * Calls wait_for_bot_ready up to `max_attempts` times. Between attempts,
 * checks if the tmux session is still alive — bails early if it died.
 *
 * Returns true if the bot became ready, false if all attempts were exhausted
 * or the tmux session died.
 */
export async function wait_for_bot_ready_with_retries(
  tmux_session: string,
  opts?: { timeout_ms?: number; poll_ms?: number; max_attempts?: number },
): Promise<boolean> {
  const max_attempts = opts?.max_attempts ?? 3;

  for (let attempt = 1; attempt <= max_attempts; attempt++) {
    const ready = await wait_for_bot_ready(tmux_session, {
      timeout_ms: opts?.timeout_ms,
      poll_ms: opts?.poll_ms,
    });
    if (ready) return true;

    // Between retries, check if the tmux session is still alive
    if (attempt < max_attempts) {
      try {
        execFileSync("tmux", ["has-session", "-t", tmux_session], { stdio: "ignore" });
      } catch {
        // Session died — no point retrying
        console.log(`[pool] Tmux session ${tmux_session} died during readiness wait — bailing`);
        return false;
      }
      console.log(
        `[pool] Bot ${tmux_session} not ready after attempt ${String(attempt)}/${String(max_attempts)} — retrying`,
      );
    }
  }

  return false;
}

// ── Keystroke injection with submit-race retry ──

/**
 * Full visible pane content, or `null` if the capture itself failed (dead/killed
 * session, timeout). A failed read is NOT the same as a genuinely empty pane —
 * callers must treat `null` as "indeterminate" and never infer submit success
 * from it, or a dead session would silently mask a dropped message (#65).
 */
function capture_pane(tmux_session: string): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", tmux_session, "-p"], {
      encoding: "utf-8",
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

/**
 * Inject a message into a tmux pane via send-keys and verify the submit landed.
 *
 * tmux `send-keys` for the message text and the subsequent Enter are racy: if
 * the Enter arrives before the input is committed (or during a redraw), it's
 * dropped and the text sits in the input box, unsubmitted — the agent never
 * starts a turn and the message is silently lost (issue #65).
 *
 * After sending text + Enter, this polls the pane for a bounded window to
 * confirm the turn actually started. A submit is considered confirmed when the
 * pane shows an active-turn indicator ("esc to interrupt") OR the input box no
 * longer contains the message text. If the text is still sitting unsubmitted
 * after the poll window, a bare Enter is re-sent — up to `max_retries` times.
 *
 * Logs a warning whenever a retry was needed so submit-race frequency is
 * measurable in the daemon logs.
 *
 * @param tmux_session - tmux session name (e.g., "pool-4")
 * @param message - message text to type into the input box
 * @param opts.poll_ms - poll interval while waiting for confirmation (default 200ms)
 * @param opts.confirm_ms - how long to wait for confirmation per attempt (default 800ms)
 * @param opts.max_retries - max bare-Enter retries after the initial submit (default 3)
 * @returns true if the submit was confirmed, false if it remained unconfirmed
 */
export async function send_keys_with_submit_retry(
  tmux_session: string,
  message: string,
  opts?: { poll_ms?: number; confirm_ms?: number; max_retries?: number },
): Promise<boolean> {
  const poll_ms = opts?.poll_ms ?? 200;
  const confirm_ms = opts?.confirm_ms ?? 800;
  const max_retries = opts?.max_retries ?? 3;

  // Send the message text and the initial submit in one send-keys call. If the
  // session died between the at-prompt check and now, this throws — log and
  // treat as not-confirmed so the retry/give-up path handles it rather than
  // aborting the surrounding health-check iteration mid-loop.
  try {
    execFileSync("tmux", ["send-keys", "-t", tmux_session, message, "Enter"], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch (err) {
    console.warn(`[pool] Initial send-keys failed for ${tmux_session}: ${String(err)}`);
    return false;
  }

  // A turn started if the status bar shows the active-generation indicator, or
  // the input box no longer echoes the message text we just typed. Scan the
  // whole pane — long input wraps across lines, so a last-line check would
  // falsely report "submitted" for wrapped text still sitting in the box.
  //
  // A failed pane read (null) is indeterminate, NOT confirmed — returning true
  // there would fail-open and silently mask a dropped message on a dead session.
  // Warn once (not per-poll) so a dead session doesn't spam the log.
  let warned_pane_read = false;
  const submit_confirmed = (): boolean => {
    const pane = capture_pane(tmux_session);
    if (pane === null) {
      if (!warned_pane_read) {
        warned_pane_read = true;
        console.warn(
          `[pool] Pane read failed for ${tmux_session} — cannot confirm submit (treating as not confirmed)`,
        );
      }
      return false;
    }
    if (pane.includes("esc to interrupt")) return true;
    return !pane.includes(message);
  };

  for (let retry = 0; retry <= max_retries; retry++) {
    const deadline = Date.now() + confirm_ms;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, poll_ms));
      if (submit_confirmed()) {
        if (retry > 0) {
          console.warn(
            `[pool] Submit confirmed for ${tmux_session} after ${String(retry)} retry(ies) — keystroke submit race`,
          );
        }
        return true;
      }
    }

    // Still unsubmitted after the poll window — re-send a bare Enter (bounded).
    if (retry < max_retries) {
      console.warn(
        `[pool] Submit not confirmed for ${tmux_session} (text still in input box) — re-sending Enter (retry ${String(retry + 1)}/${String(max_retries)})`,
      );
      try {
        execFileSync("tmux", ["send-keys", "-t", tmux_session, "Enter"], {
          stdio: "ignore",
          timeout: 5000,
        });
      } catch (err) {
        console.warn(`[pool] Re-send Enter failed for ${tmux_session}: ${String(err)}`);
        return false;
      }
    }
  }

  console.warn(
    `[pool] Submit never confirmed for ${tmux_session} after ${String(max_retries)} retries — could not confirm submit (pane unreadable or input stuck, session may be dead); message may be dropped`,
  );
  return false;
}

// ── Claude Code JSONL session tracking ──

/**
 * Encode an absolute filesystem path into Claude Code's project-slug format.
 *
 * Claude Code stores each session's JSONL transcript at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The encoding replaces
 * every `/` and `.` in the absolute path with `-`.
 *
 * Example:
 *   /Users/farm/.lobsterfarm/entities/lobster-farm/repos/lobster-farm
 *   → -Users-farm--lobsterfarm-entities-lobster-farm-repos-lobster-farm
 */
export function encode_project_slug(abs_path: string): string {
  return abs_path.replace(/[/.]/g, "-");
}

/** Absolute path to the JSONL transcript Claude Code will write for this session. */
export function claude_session_jsonl_path(working_dir: string, session_id: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encode_project_slug(working_dir),
    `${session_id}.jsonl`,
  );
}

/** Returns true iff the session's JSONL transcript exists on disk under the
 * project slug that corresponds to `working_dir`. Claude Code only creates
 * the JSONL on the session's first write, so this is how we distinguish a
 * "real" session from one that never committed anything.
 *
 * This is the targeted check used during confirmation — we know the cwd of
 * the tmux session we spawned, so we look in exactly that project slug. */
export async function session_jsonl_exists(
  working_dir: string,
  session_id: string,
): Promise<boolean> {
  try {
    await access(claude_session_jsonl_path(working_dir, session_id));
    return true;
  } catch {
    return false;
  }
}

/** Returns true iff a JSONL transcript for `session_id` exists under *any*
 * project slug in `~/.claude/projects/`. Used when restoring state from
 * pool-state.json on daemon restart, where the original cwd (e.g. a feature
 * worktree) may differ from the entity_dir the restart will actually use. */
export async function session_jsonl_exists_anywhere(session_id: string): Promise<boolean> {
  const projects_dir = join(homedir(), ".claude", "projects");
  const filename = `${session_id}.jsonl`;
  try {
    const entries = await readdir(projects_dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await access(join(projects_dir, entry.name, filename));
        return true;
      } catch {
        // not in this project dir
      }
    }
  } catch {
    // ~/.claude/projects missing or unreadable — treat as "not found"
  }
  return false;
}

// ── Agent name resolution ──

function resolve_agent_name(archetype: ArchetypeRole, config: LobsterFarmConfig): string {
  switch (archetype) {
    case "planner":
      return config.agents.planner.name.toLowerCase();
    case "designer":
      return config.agents.designer.name.toLowerCase();
    case "builder":
      return config.agents.builder.name.toLowerCase();
    case "operator":
      return config.agents.operator.name.toLowerCase();
    case "commander":
      return config.agents.commander.name.toLowerCase();
    case "marketer":
      return config.agents.marketer.name.toLowerCase();
    case "reviewer":
      return "reviewer";
  }
}

function resolve_agent_display_name(archetype: ArchetypeRole, config: LobsterFarmConfig): string {
  switch (archetype) {
    case "planner":
      return config.agents.planner.name;
    case "designer":
      return config.agents.designer.name;
    case "builder":
      return config.agents.builder.name;
    case "operator":
      return config.agents.operator.name;
    case "commander":
      return config.agents.commander.name;
    case "marketer":
      return config.agents.marketer.name;
    case "reviewer":
      return "Reviewer";
  }
}

/** Extract bot user ID from a Discord bot token (first segment is base64-encoded user ID).
 * Returns only the non-secret user ID — the token itself is not retained. */
function bot_user_id_from_token(token: string): string | null {
  try {
    const first_segment = token.split(".")[0];
    if (!first_segment) return null;
    return Buffer.from(first_segment, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Callback for setting a bot's Discord nickname. Provided by the Discord module
 * so the pool doesn't need direct access to bot tokens or the Discord API. */
export type NicknameHandler = (user_id: string, display_name: string) => Promise<void>;

/** Callback for setting a bot's Discord profile avatar using its own token.
 * Provided by the Discord module — the pool never touches raw tokens.
 * @param state_dir - The bot's channel directory (contains .env with token)
 * @param agent_name - Lowercase agent name used to find the avatar file */
export type AvatarHandler = (state_dir: string, agent_name: string) => Promise<void>;

/** Rate limit cooldown for avatar changes (30 minutes). Discord allows ~2 per
 * hour per bot — this gives comfortable margin. */
export const AVATAR_COOLDOWN_MS = 30 * 60 * 1000;

// ── Plugin-liveness probe (#73, #77) ──

/** Re-exported from the shared probe module so existing pool importers keep
 * working. The decision logic lives in `plugin-liveness.ts` and is shared with
 * the commander probe (#77). */
export { LIVENESS_WARMUP_MS, PLUGIN_DEAF_THRESHOLD_MS };

/** Sliding window for the deaf auto-recycle loop guard (#106). Recycles per
 * channel are counted inside this window; see `deaf_recycle_history`. */
export const DEAF_RECYCLE_WINDOW_MS = 60 * 60 * 1000;

/** Max automatic deaf recycles per channel inside DEAF_RECYCLE_WINDOW_MS
 * before the heal gives up (release without reassign + failure alert). Two
 * chances: the first recycle cures a one-off dead listener; a second covers a
 * transient (e.g. Discord-side) failure of the first; a third deaf verdict in
 * the same hour means recycling is not the fix and a human needs to look. */
export const MAX_DEAF_RECYCLES_PER_WINDOW = 2;

/** Delay before the one-shot post-restart heal pass (#106). Long enough for a
 * fleet of resumed sessions to boot and run their resume-nudge turn even on a
 * loaded machine (Claude startup + MCP init + a multi-step nudge turn), short
 * enough that a deaf room is healed within minutes of the restart instead of
 * days. The steady-state probe (90s threshold) usually fires first; this pass
 * is the deterministic backstop that doesn't depend on pane heuristics. */
export const POST_RESTART_HEAL_DELAY_MS = 3 * 60 * 1000;

// ── Pool Manager ──

export class BotPool extends EventEmitter {
  private bots: PoolBot[] = [];
  private config: LobsterFarmConfig;
  private _draining = false;
  private _health_check_running = false;
  private health_timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight lock: channels currently being assigned. Prevents check-then-act races. */
  private assigning_channels = new Set<string>();
  /**
   * Broker cold-start inbound buffer (#83/#89). When a broker channel is dark
   * and two inbound arrive in rapid succession, the first wins the
   * `assigning_channels` lock and cold-recreates the session; the second loses
   * the lock (assign returns null) while broker ownership isn't registered yet,
   * so feeding it directly would drop it (`feed` no-ops with no owner). Instead
   * the loser buffers its message here; the winning `assign()` drains the buffer
   * into the broker queue right after it registers ownership + feeds message #1.
   * Result: one session, one ordered reply per message — never a duplicate
   * dispatch. Keyed by channel_id. Only ever populated for `uses_broker` channels.
   */
  private broker_coldstart_buffer = new Map<string, PendingMessage[]>();
  /** In-flight lock: channels currently being released. Prevents double-release races. */
  private releasing_channels = new Set<string>();
  /** In-flight lock: tmux sessions with a pending file delivery in progress.
   * Prevents drain_pending_files from re-delivering during the 5s cleanup window. */
  private draining_sessions = new Set<string>();
  private bot_user_ids = new Map<number, string>();
  private nickname_handler: NicknameHandler | null = null;
  private avatar_handler: AvatarHandler | null = null;
  /** Daemon Discord broker (epic #84 / #85). Set only when
   * `config.discord.broker.enabled` is true. When a channel is a broker pilot
   * channel, bring-up registers ownership here and swaps the official plugin
   * for the LF shim. Null (and every code path unchanged) when the flag is off. */
  private broker: DiscordBroker | null = null;
  /** Bots that were actively assigned before shutdown and should be proactively resumed.
   * Populated during initialize(), consumed by resume_parked_bots(). */
  private resume_candidates: PersistedPoolBot[] = [];
  /** Maps "{entity_id}:{channel_id}" → session_id. Preserves session context
   * across evictions so a channel can resume its old session when reassigned. */
  private session_history = new Map<string, string>();
  private session_history_ts = new Map<string, number>();
  /** Entity registry reference — set during initialize(), used by start_tmux()
   * to look up per-entity config (e.g., github_token_ref). */
  private registry: EntityRegistry | null = null;
  /** Tracks crash timestamps per bot for crash loop detection.
   * bot_id → array of crash timestamps (epoch ms). Old entries (>1 hour) are
   * pruned on each health check to prevent unbounded growth. */
  private crash_history = new Map<number, number[]>();
  /** Queued messages for bots that weren't at the prompt when inject was attempted.
   * tmux_session → messages[]. Drained by the health check cycle (every 30s). */
  private pending_injections = new Map<string, string[]>();
  /** Active session-confirmation watchers (issue #256). bot_id → timer handle.
   * Each watcher polls for the JSONL transcript and promotes bot.session_confirmed
   * from false → true once Claude commits its first turn to disk. Cleared on
   * reassignment, release, or shutdown to prevent leaks. */
  private session_watchers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Timer for the rate-limit modal recovery scan (60s interval, issue #270). */
  private rate_limit_timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight lock: bot IDs currently being recovered by the plugin-liveness
   * probe (#73). The probe's recovery kills + respawns the tmux session, which
   * takes longer than the 30s health-check interval — this prevents a second
   * pass from firing a duplicate recovery on a bot that's already mid-restart. */
  private recovering_plugin = new Set<number>();
  /** Auto-recycle timestamps per channel (#106). The deaf heal is a full
   * release + fresh assign; if the same channel keeps going deaf, recycling is
   * not curing the root cause and repeating it just churns sessions (the 08-01
   * incident showed restart churn itself producing deaf plugins). After
   * MAX_DEAF_RECYCLES_PER_WINDOW recycles inside DEAF_RECYCLE_WINDOW_MS the
   * next deaf verdict releases WITHOUT reassign and alerts at failure severity.
   * In-memory only — a daemon restart resets the budget, which is fine: the
   * restart also replaces every plugin connection. */
  private deaf_recycle_history = new Map<string, number[]>();
  /** Post-restart probation (#106): bots proactively resumed by
   * resume_parked_bots() whose resume nudge was successfully injected. Each
   * entry records the assignment snapshot + a baseline timestamp; the one-shot
   * heal pass (heal_post_restart) recycles any entry whose session shows zero
   * evidence of having run a turn since the baseline — the "alive but not
   * receiving injected channel messages" signature of the 08-01→08-04 incident.
   * bot_id → snapshot. In-memory only. */
  private post_restart_probation = new Map<
    number,
    { channel_id: string; entity_id: string; session_id: string; baseline: number }
  >();
  /** One-shot timer for the post-restart heal pass. */
  private post_restart_heal_timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: LobsterFarmConfig) {
    super();
    this.config = config;
  }

  /** Register a callback for setting bot nicknames via Discord.
   * Called by the Discord module after connecting — allows the pool to
   * set nicknames through the daemon bot without touching pool bot tokens. */
  set_nickname_handler(handler: NicknameHandler): void {
    this.nickname_handler = handler;
  }

  /** Register a callback for setting bot profile avatars.
   * Called by the Discord module — the handler reads the bot's token from its
   * .env file and makes a raw REST call. The pool never sees the token. */
  set_avatar_handler(handler: AvatarHandler): void {
    this.avatar_handler = handler;
  }

  /** Wire the daemon Discord broker (epic #84 / #85). Called from index.ts only
   * when `config.discord.broker.enabled` is true. When unset, every transport
   * decision resolves to "plugin" and behavior is byte-identical to today. */
  set_broker(broker: DiscordBroker): void {
    this.broker = broker;
  }

  /**
   * Whether the channel's inbound should be routed through the broker instead
   * of the official plugin. True only for channels the broker actually owns
   * (registered at broker-session bring-up). discord.ts consults this on the
   * steady-state inbound path to decide whether to feed the broker.
   */
  broker_owns(channel_id: string): boolean {
    return this.broker?.owns(channel_id) ?? false;
  }

  /**
   * Feed an inbound Discord message to the broker for a broker-owned channel.
   * Fail-open: the broker's own feed() swallows errors, and this method never
   * throws — the daemon's message hot path must not be derailed. No-op when
   * the channel isn't broker-owned or the broker is unset.
   */
  feed_broker_inbound(input: {
    channel_id: string;
    content: string;
    meta: InboundMeta;
  }): void {
    this.broker?.feed(input);
  }

  /**
   * Drop broker ownership for a channel WITHOUT clearing its queued backlog
   * (#89). Used by the lazy release-to-dark path so the channel goes dark
   * (`broker_owns` → false → cold-recreate on next inbound) while any unacked
   * inbound stays in the durable queue for at-least-once redelivery. No-op when
   * the broker is unset. See DiscordBroker.deregister_channel.
   */
  private deregister_broker_channel(channel_id: string): void {
    this.broker?.deregister_channel(channel_id);
  }

  /**
   * Deliver a broker inbound that arrived while a cold-start `assign()` for the
   * same channel is already in flight (#83/#89). This is the concurrent-cold-
   * start path: the caller (discord.ts) reached here because `assign()` returned
   * null for a broker channel. We disambiguate:
   *
   *   - Assign still in flight (`assigning_channels`) → buffer the message; the
   *     winning assign drains the buffer into the queue right after it feeds
   *     message #1, preserving strict arrival order (msg#1 before this one).
   *   - Not assigning, but ownership already registered → the winning assign
   *     finished and released its lock, so message #1 is already in the queue;
   *     feed this straight to the queue (steady-state delivery).
   *   - Neither → there is no cold-start underway (e.g. the pool was genuinely
   *     exhausted); return false so the caller can surface "busy". No message is
   *     enqueued, so redelivery isn't relied on for a message that has no owner.
   *
   * Order matters: `assigning_channels` is checked BEFORE `broker_owns` because
   * ownership flips true partway through assign() (inside start_tmux →
   * register_channel) while the assign still holds its in-flight lock — and there
   * is an `await` between that registration and the message-#1 feed. A concurrent
   * inbound landing in that sub-window sees `broker_owns` true but msg#1 NOT yet
   * queued; a straight-through feed there would land it AHEAD of msg#1 → #83
   * ordering inversion. Gating on the assign lock (held for the whole
   * register→feed→drain span) forces such inbound into the buffer, which assign()
   * drains strictly after msg#1. `broker_owns` is only trusted as a
   * straight-through signal once the assign lock is gone, i.e. msg#1 is fed.
   *
   * Returns true if the message was delivered or buffered (caller must NOT also
   * reply "busy"), false if it couldn't be placed. Self-gates on `uses_broker`
   * so it is safe to call for ANY channel — a plugin channel always returns
   * false and takes the unchanged "busy" path, keeping flag-OFF byte-identical.
   */
  deliver_or_buffer_broker_inbound(channel_id: string, pending: PendingMessage): boolean {
    // Plugin channels (and flag-OFF) never touch the broker buffer — return
    // false immediately so the caller's existing "busy" path is byte-identical.
    if (!this.uses_broker(channel_id)) return false;
    // Assign in flight → buffer regardless of ownership state. See docstring:
    // ownership can be true mid-assign before msg#1 is fed, so we must NOT feed
    // straight through here or we'd reorder ahead of msg#1.
    if (this.assigning_channels.has(channel_id)) {
      const buf = this.broker_coldstart_buffer.get(channel_id) ?? [];
      buf.push(pending);
      this.broker_coldstart_buffer.set(channel_id, buf);
      console.log(
        `[pool] Buffered concurrent broker inbound for ${channel_id} during cold-start ` +
          `(${String(buf.length)} queued)`,
      );
      return true;
    }
    // No assign in flight but ownership registered → assign finished and msg#1 is
    // already queued; safe to feed straight through as an ordered follow-up.
    if (this.broker_owns(channel_id)) {
      this.feed_broker_pending(channel_id, pending);
      return true;
    }
    return false;
  }

  /**
   * Drain any messages buffered by `deliver_or_buffer_broker_inbound` for a
   * channel into the broker queue, in arrival order (#83). Called by `assign()`
   * immediately after it registers broker ownership and feeds message #1, so the
   * concurrent inbound that lost the assign lock still lands as ordered
   * follow-up turns on the single cold-recreated session. No-op when the buffer
   * is empty. Safe to call for any channel.
   */
  private drain_broker_coldstart_buffer(channel_id: string): void {
    const buffered = this.broker_coldstart_buffer.get(channel_id);
    if (!buffered || buffered.length === 0) return;
    this.broker_coldstart_buffer.delete(channel_id);
    for (const pending of buffered) {
      this.feed_broker_pending(channel_id, pending);
    }
    console.log(
      `[pool] Drained ${String(buffered.length)} buffered broker inbound(s) for ${channel_id} into the queue after cold-start`,
    );
  }

  /**
   * Enqueue a PendingMessage into the broker queue so the shim delivers it as a
   * `notifications/claude/channel` inbound once connected, driving a session turn.
   *
   * This is the single broker-side delivery for a PendingMessage, used on every
   * path where the driver is a PendingMessage rather than a live discord.js
   * Message:
   *   - the triggering (first) message of a freshly-assigned session (#87), and
   *   - concurrent inbound that raced a cold-start and were buffered/drained as
   *     ordered follow-up turns (#83).
   * There is nothing first-turn-specific here — it is the queue analogue of the
   * steady-state feed_broker_inbound(), which takes a live Message instead.
   *
   * On the broker transport the SessionStart hook's additionalContext alone does
   * not drive a turn, so message #1 must ride the same queue → shim →
   * channel-inbound path as steady-state messages. Called only for channels the
   * broker actually owns; the pending-file hook is skipped for those to avoid
   * double-delivery.
   *
   * The InboundMeta is built from the PendingMessage the same way the
   * steady-state build_broker_inbound() maps a discord.js Message — chat_id is
   * the channel, and we carry the user/message_id/ts through. user_id isn't
   * available on a PendingMessage (it isn't needed for delivery or reply
   * threading), so it's left empty, matching the resume-nudge daemon-authored
   * shape. Fail-open: broker.feed() swallows its own errors.
   */
  feed_broker_pending(channel_id: string, pending: PendingMessage): void {
    this.broker?.feed({
      channel_id,
      content: pending.content,
      meta: {
        chat_id: channel_id,
        message_id: pending.message_id,
        user: pending.user,
        user_id: "",
        ts: pending.ts,
      },
    });
  }

  /**
   * Whether a channel uses the broker transport. True only when the broker flag
   * is enabled AND the channel is in the pilot allowlist. This is the single
   * source of truth for the plugin-vs-broker fork at bring-up.
   *
   * This is the CANONICAL gate for the lazy/message-driven broker lifecycle
   * (#89): every new branch that decides "skip proactive-resume", "release to
   * dark instead of respawn", or "cold-recreate on next inbound" gates on this.
   * It is config-driven (flag + allowlist), so it is stable across a daemon
   * restart — unlike `broker_owns()`, which reflects the in-memory ownership Map
   * that is empty until a session re-registers inside `assign()`. The
   * restart-time paths (`resume_parked_bots`, `reconcile_assigned_health`) run
   * BEFORE any re-registration, so gating them on `broker_owns` would be a silent
   * no-op. Because it returns false when the flag is OFF, every #89 branch is a
   * no-op with `broker.enabled: false` → flag-OFF behavior is byte-identical to
   * the plugin path.
   *
   * `broker_owns()` remains the correct gate ONLY on paths where a session is
   * actually live and registered (steady-state inbound feed, #87 first-message).
   *
   * Protected (not private) so the health/restart branches can gate on it and
   * lifecycle tests can drive it directly.
   */
  protected uses_broker(channel_id: string): boolean {
    if (!this.broker) return false;
    const broker_cfg = this.config.discord?.broker;
    if (!broker_cfg?.enabled) return false;
    return broker_cfg.pilot_channels.includes(channel_id);
  }

  /**
   * Public caller-facing view of `uses_broker()` (#107). Session-creating
   * callers (the /swap, /room, /resume command handlers and POST /pool/assign)
   * consult this to decide whether they must synthesize a `pending_message`
   * driver before calling `assign()` — the choke-point guard refuses driverless
   * assigns for broker channels. Plugin channels (and flag-OFF) return false,
   * so callers that gate on this stay byte-identical to today when the broker
   * is disabled.
   */
  channel_uses_broker(channel_id: string): boolean {
    return this.uses_broker(channel_id);
  }

  /**
   * Read the bot's access.json chunk config (the same file the official plugin
   * reads for reply chunking). Missing/corrupt → plugin runtime defaults, so
   * broker outbound segments messages identically to the plugin. Never throws.
   */
  private async read_chunk_config(state_dir: string): Promise<ChannelOwnership["chunk_config"]> {
    try {
      const raw = await readFile(join(state_dir, "access.json"), "utf-8");
      const parsed = JSON.parse(raw) as {
        textChunkLimit?: number;
        chunkMode?: "length" | "newline";
        replyToMode?: "off" | "first" | "all";
      };
      return {
        text_chunk_limit: parsed.textChunkLimit,
        chunk_mode: parsed.chunkMode,
        reply_to_mode: parsed.replyToMode,
      };
    } catch {
      // No access.json (or malformed) — the executor falls back to plugin
      // defaults (limit 2000, "length", "first"). Fail-open.
      return {};
    }
  }

  /**
   * Prepare broker transport for a session: register channel ownership with the
   * broker, write the shim's MCP config JSON to the bot's state dir, and return
   * the env vars the shim needs to connect. Returns null (→ plugin transport)
   * if anything fails, so a broker fault never blocks a session bring-up.
   *
   * The config is keyed `plugin_discord_discord` so the resulting tool names are
   * `mcp__plugin_discord_discord__*` — byte-identical to the official plugin,
   * which the reply-enforcement harvest (#80) matches on by name.
   *
   * `--strict-mcp-config` (see start_tmux) loads ONLY this file, so any global
   * `mcpServers` a plugin-path session would inherit from the resolved
   * `.claude.json` (e.g. `playwright`) are dropped unless we carry them forward.
   * We merge them in here so a broker session keeps the SAME MCP server set as a
   * plugin session — the pilot swaps the Discord transport, nothing else. The
   * shim's own `plugin_discord_discord` key is applied LAST so it always wins
   * over any (stale) discord entry in the global config.
   */
  private async prepare_broker_session(
    bot: PoolBot,
    channel_id: string,
    claude_config_dir: string | null,
  ): Promise<{ mcp_config_path: string; env: Record<string, string> } | null> {
    const broker = this.broker;
    if (!broker) return null;
    try {
      const chunk_config = await this.read_chunk_config(bot.state_dir);
      broker.register_channel(channel_id, {
        bot_id: bot.id,
        state_dir: bot.state_dir,
        chunk_config,
      });

      // The shim bundle ships alongside the daemon build. dist/shim/discord-shim.js
      // is produced by tsup (see tsup.config.ts entry list). Resolve relative to
      // the running daemon module (dist/index.js) so it works from any cwd.
      const shim_entry = fileURLToPath(new URL("./shim/discord-shim.js", import.meta.url));
      // Preserve global MCP parity under --strict-mcp-config: start from the
      // global servers, then overlay the shim (last write wins for discord).
      const global_servers = await this.read_global_mcp_servers(claude_config_dir);
      const mcp_config = {
        mcpServers: {
          ...global_servers,
          [SHIM_MCP_SERVER_KEY]: {
            command: process.execPath,
            args: [shim_entry],
            env: {
              LF_BROKER_SOCKET: broker.socket_path,
              LF_BROKER_CHANNEL: channel_id,
              LF_BROKER_BOT_ID: String(bot.id),
            },
          },
        },
      };
      const config_path = join(bot.state_dir, "broker-mcp.json");
      await writeFile(config_path, JSON.stringify(mcp_config, null, 2), "utf-8");

      return {
        mcp_config_path: config_path,
        env: {
          LF_BROKER_SOCKET: broker.socket_path,
          LF_BROKER_CHANNEL: channel_id,
          LF_BROKER_BOT_ID: String(bot.id),
        },
      };
    } catch (err) {
      console.error(
        `[pool] broker session prep failed for pool-${String(bot.id)} on ${channel_id}; falling back to plugin: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Read the global `mcpServers` block a plugin-path session would inherit, so a
   * broker session under `--strict-mcp-config` keeps the same MCP server set.
   *
   * The CLI resolves its global config from `<config_dir>/.claude.json`, where
   * `config_dir` is `CLAUDE_CONFIG_DIR` (a per-entity subscription override, if
   * set) else the user's home dir. We mirror that resolution here. The official
   * discord plugin is NOT delivered via `mcpServers` (it's a `--channels`
   * plugin), so nothing here collides with the shim's `plugin_discord_discord`
   * key — but we still overlay the shim last as a belt-and-suspenders guard.
   *
   * Fail-open: a missing/corrupt config, or any read error, yields `{}` — a
   * broker session with no extra MCP servers is strictly safer than a failed
   * bring-up, and matches the pre-broker behavior for configs that have none.
   */
  protected async read_global_mcp_servers(
    claude_config_dir: string | null,
  ): Promise<Record<string, unknown>> {
    const config_path = join(claude_config_dir ?? homedir(), ".claude.json");
    try {
      const raw = await readFile(config_path, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers?: unknown };
      const servers = parsed.mcpServers;
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        return servers as Record<string, unknown>;
      }
      return {};
    } catch {
      // ENOENT / corrupt / unreadable — no global servers to carry forward.
      return {};
    }
  }

  /** Protected wrappers around JSONL existence checks so tests can override
   * without touching the real filesystem. Defaults to the module-level helpers
   * which read from `~/.claude/projects/`. */
  protected check_session_jsonl_exists(working_dir: string, session_id: string): Promise<boolean> {
    return session_jsonl_exists(working_dir, session_id);
  }
  protected check_session_jsonl_exists_anywhere(session_id: string): Promise<boolean> {
    return session_jsonl_exists_anywhere(session_id);
  }

  /** Enter drain mode — no new assignments accepted. */
  drain(): void {
    this._draining = true;
    console.log("[pool] Entering drain mode — no new assignments");
  }

  /** Check if pool is draining. */
  get draining(): boolean {
    return this._draining;
  }

  /** Discover pool bot directories, restore persisted state, and initialize. */
  async initialize(registry?: EntityRegistry): Promise<void> {
    if (registry) {
      this.registry = registry;
    }
    const channels_dir = join(lobsterfarm_dir(this.config.paths), "channels");
    const pool_dirs: string[] = [];

    // Scan for pool-N directories
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(channels_dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("pool-")) {
          pool_dirs.push(entry.name);
        }
      }
    } catch {
      console.log("[pool] No channels directory found");
      return;
    }

    // Sort by number
    pool_dirs.sort((a, b) => {
      const num_a = Number.parseInt(a.replace("pool-", ""), 10);
      const num_b = Number.parseInt(b.replace("pool-", ""), 10);
      return num_a - num_b;
    });

    for (const dir_name of pool_dirs) {
      const id = Number.parseInt(dir_name.replace("pool-", ""), 10);
      const state_dir = join(channels_dir, dir_name);

      // Verify the bot has a token and extract its user ID for nickname management.
      // Only the non-secret user ID (base64 first segment) is retained — the full
      // token is never stored in daemon memory or used for API calls.
      try {
        const env_content = await readFile(join(state_dir, ".env"), "utf-8");
        const token_match = env_content.match(/DISCORD_BOT_TOKEN=(.+)/);
        if (!token_match?.[1]?.trim()) {
          console.log(`[pool] Skipping ${dir_name}: no bot token`);
          continue;
        }
        const user_id = bot_user_id_from_token(token_match[1].trim());
        if (user_id) {
          this.bot_user_ids.set(id, user_id);
        }
      } catch {
        console.log(`[pool] Skipping ${dir_name}: no .env file`);
        continue;
      }

      // Check if there's already a tmux session running for this bot
      const tmux_session = `pool-${String(id)}`;
      const is_running = this.is_tmux_alive(tmux_session);

      this.bots.push({
        id,
        state: is_running ? "assigned" : "free",
        channel_id: null,
        entity_id: null,
        archetype: null,
        channel_type: null,
        session_id: null,
        session_confirmed: false,
        tmux_session,
        last_active: is_running ? new Date() : null,
        assigned_at: is_running ? new Date() : null,
        last_inbound_at: null,
        last_processing_at: null,
        state_dir,
        model: null,
        effort: null,
        last_avatar_archetype: null,
        last_avatar_set_at: null,
      });
    }

    // Restore persisted assignments from last run
    const saved_state = await load_pool_state(this.config);
    if (saved_state.bots.length > 0) {
      console.log(
        `[pool] Loaded ${String(saved_state.bots.length)} saved bot entries from pool-state.json`,
      );
      for (const entry of saved_state.bots) {
        console.log(
          `[pool]   pool-${String(entry.id)}: state=${entry.state}, ` +
            `channel=${entry.channel_id}, session=${entry.session_id?.slice(0, 8) ?? "none"}`,
        );
      }
    } else {
      console.log("[pool] No saved bot entries found in pool-state.json");
    }

    let restored = 0;
    this.resume_candidates = [];

    // Restore session history from persisted state. Pre-flight the JSONL for
    // each entry — a history entry whose transcript has gone missing is a
    // phantom session that would crash-loop the next bot assigned to this
    // channel (issue #256). Drop phantoms on the floor.
    // We search *all* project slugs because the original session may have
    // been spawned in a worktree cwd that no longer matches entity_dir.
    const now = Date.now();
    let history_dropped = 0;
    for (const [key, session_id] of Object.entries(saved_state.session_history)) {
      const exists = await this.check_session_jsonl_exists_anywhere(session_id);
      if (!exists) {
        console.warn(
          `[pool] Dropping phantom session_history entry ${key} → ${session_id.slice(0, 8)} (no JSONL on disk)`,
        );
        history_dropped++;
        continue;
      }
      this.session_history.set(key, session_id);
      this.session_history_ts.set(key, now);
    }
    if (this.session_history.size > 0) {
      console.log(`[pool] Restored ${String(this.session_history.size)} session history entries`);
    }
    if (history_dropped > 0) {
      console.warn(`[pool] Dropped ${String(history_dropped)} phantom session_history entries`);
    }

    // Restore avatar state for all bots (including those that will stay free).
    // Avatar state is per-bot, not per-assignment — a bot's Discord profile
    // avatar persists even when the bot is released from the pool.
    const avatar_entries = saved_state.avatar_state ?? {};
    for (const [id_str, avatar_info] of Object.entries(avatar_entries)) {
      const bot = this.bots.find((b) => b.id === Number.parseInt(id_str, 10));
      if (!bot) continue;
      bot.last_avatar_archetype = avatar_info.archetype;
      bot.last_avatar_set_at = new Date(avatar_info.set_at);
    }
    const avatar_count = Object.keys(avatar_entries).length;
    if (avatar_count > 0) {
      console.log(`[pool] Restored avatar state for ${String(avatar_count)} bot(s)`);
    }

    for (const entry of saved_state.bots) {
      const bot = this.bots.find((b) => b.id === entry.id);
      if (!bot) continue; // Bot directory removed since last run

      // Validate entity/channel still exist (if registry available)
      if (registry && !this.validate_saved_entry(entry, registry)) {
        console.log(
          `[pool] Skipping stale entry for pool-${String(entry.id)}: entity/channel no longer configured`,
        );
        continue;
      }

      // Restore model/effort — fall back to archetype defaults for older pool-state.json
      // files that don't have these fields yet.
      const restored_model =
        entry.model ??
        (entry.archetype ? resolve_model_id(DEFAULT_ARCHETYPES[entry.archetype]) : null);
      const restored_effort =
        entry.effort ??
        (entry.archetype ? resolve_effort(DEFAULT_ARCHETYPES[entry.archetype].think) : null);

      // Defensive pre-flight (issue #256): a persisted session_id must have a
      // JSONL transcript on disk, otherwise --resume will fail and trigger a
      // crash loop. If the file is missing — either because the state file
      // predates the confirmation-gate fix, or because Claude Code deleted
      // the JSONL externally — drop the session_id and fall through to a
      // fresh spawn on next assignment. Logged loudly so we can see it.
      // Search all project slugs in case the session was originally spawned
      // in a feature worktree that differs from entity_dir.
      let restored_session_id = entry.session_id;
      if (restored_session_id) {
        const exists = await this.check_session_jsonl_exists_anywhere(restored_session_id);
        if (!exists) {
          console.warn(
            `[pool] pool-${String(entry.id)}: persisted session ${restored_session_id.slice(0, 8)} has no JSONL on disk — dropping to prevent --resume crash loop`,
          );
          restored_session_id = null;
        }
      }

      if (bot.state === "assigned") {
        // tmux is still running (survived restart, e.g. launchd) — restore metadata.
        // BUT the Claude process inside has a stale MCP connection to the old daemon.
        // We mark it as a resume candidate so resume_parked_bots() will kill the old
        // tmux and spawn a fresh Claude process with --resume (fresh MCP connection).
        bot.channel_id = entry.channel_id;
        bot.entity_id = entry.entity_id;
        bot.archetype = entry.archetype;
        bot.channel_type = entry.channel_type;
        bot.session_id = restored_session_id;
        bot.session_confirmed = !!restored_session_id;
        bot.model = restored_model;
        bot.effort = restored_effort;
        bot.last_active = entry.last_active ? new Date(entry.last_active) : null;
        bot.assigned_at = entry.assigned_at ? new Date(entry.assigned_at) : bot.last_active;
        bot.last_avatar_archetype = entry.last_avatar_archetype ?? null;

        // Add to resume candidates — the live tmux session has a dead MCP socket.
        // resume_parked_bots() will kill it and spawn fresh with --resume.
        // Only resume if the JSONL actually exists on disk.
        if (entry.state === "assigned" && restored_session_id) {
          this.resume_candidates.push({ ...entry, session_id: restored_session_id });
          console.log(
            `[pool] pool-${String(bot.id)} has live tmux but stale MCP — ` +
              `queued for fresh resume (session: ${restored_session_id.slice(0, 8)})`,
          );
        }
      } else {
        // tmux is dead. Restore session metadata onto the bot first; we'll
        // either run post-mortem extraction (if it was assigned at shutdown)
        // and then flip to parked, or just flip to parked directly.
        bot.channel_id = entry.channel_id;
        bot.entity_id = entry.entity_id;
        bot.archetype = entry.archetype;
        bot.channel_type = entry.channel_type;
        bot.session_id = restored_session_id;
        bot.session_confirmed = !!restored_session_id;
        bot.model = restored_model;
        bot.effort = restored_effort;
        bot.last_active = entry.last_active ? new Date(entry.last_active) : null;
        bot.assigned_at = entry.assigned_at ? new Date(entry.assigned_at) : bot.last_active;
        bot.last_avatar_archetype = entry.last_avatar_archetype ?? null;

        // Post-mortem session-end extraction: a bot persisted as `assigned`
        // with now-dead tmux ended dirty without hitting park_bot/release.
        // Mark it `assigned` so the gate accepts, fire, then flip to `parked`.
        // Bots persisted as `parked` already extracted at their park() site.
        //
        // Known edge case: this fires per-bot during restore, BEFORE the
        // channel-dedup loop below. If a prior race persisted two bots as
        // `assigned` to the SAME channel (abnormal state), both fire extraction
        // here — the dedup loop only frees the duplicate afterward. The result
        // is two daily-log entries for one logical session: non-crashing, very
        // low-probability, and self-limited to redundant log noise. Not worth
        // pre-deduplicating the restore loop to prevent.
        if (entry.state === "assigned") {
          bot.state = "assigned";
          void this.extract_on_session_end(bot);
        }
        bot.state = "parked";

        // If this bot was actively assigned (not already parked) before shutdown
        // and has a session_id, it's a candidate for proactive resume.
        // Bots saved as "parked" were already idle — don't resume those.
        if (entry.state === "assigned" && restored_session_id) {
          this.resume_candidates.push({ ...entry, session_id: restored_session_id });
        }
      }

      restored++;
    }

    if (restored > 0) {
      console.log(`[pool] Restored ${String(restored)} bot assignment(s) from persisted state`);
    }

    // Deduplicate: if multiple bots claim the same channel (from a prior race condition),
    // keep only the first (lowest pool-id) and free the rest. This prevents stale
    // persisted state from causing duplicate assignments on restart.
    const seen_channels = new Set<string>();
    for (const bot of this.bots) {
      if (bot.state === "free" || !bot.channel_id) continue;
      if (seen_channels.has(bot.channel_id)) {
        console.log(
          `[pool] Dedup: pool-${String(bot.id)} has duplicate claim on channel ${bot.channel_id} — freeing`,
        );
        bot.state = "free";
        bot.channel_id = null;
        bot.entity_id = null;
        bot.archetype = null;
        bot.channel_type = null;
        bot.session_id = null;
        bot.model = null;
        bot.effort = null;
        bot.last_active = null;
        // Clear the stale access.json so the bot doesn't listen on the old channel
        await this.write_access_json(bot.state_dir, null);
      } else {
        seen_channels.add(bot.channel_id);
      }
    }

    // Reconcile access.json for every bot to match the daemon's resolved state.
    // This is the critical step: the daemon is the single source of truth for channel
    // assignments. access.json files may be stale from a previous run (e.g., a bot that
    // was reassigned or freed but whose tmux survived the restart). Rewriting them all
    // ensures the Discord plugin only listens to channels the daemon actually assigned.
    //
    // We also pass `bot.entity_id` so write_access_json can enrich the outbound
    // allowlist with the entity's #alerts channel (#40). For free/parked bots
    // this is null and no alerts entry is written.
    for (const bot of this.bots) {
      // Only assigned bots (with live tmux) should listen on their channel.
      // Parked and free bots get empty access.json — their channel claim is
      // preserved in memory/pool-state.json for resume, not in access.json.
      const expected_channel = bot.state === "assigned" ? bot.channel_id : null;
      const expected_entity = bot.state === "assigned" ? bot.entity_id : null;
      await this.write_access_json(bot.state_dir, expected_channel, expected_entity);
    }
    console.log(`[pool] Reconciled access.json for ${String(this.bots.length)} bots`);

    // Phase 3: Clean up orphan tmux sessions.
    // If a bot has live tmux but no persisted metadata, it's an orphan from a
    // previous crash. Kill the tmux and mark it free — there's nothing to resume.
    for (const bot of this.bots) {
      if (bot.state === "assigned" && !bot.channel_id) {
        console.log(
          `[pool] Killing orphan tmux for pool-${String(bot.id)} (no persisted state — leftover from crash)`,
        );
        this.kill_tmux(bot.tmux_session);
        bot.state = "free";
        bot.last_active = null;
        bot.assigned_at = null;
      }
    }

    // Warn once if user_id is missing — rather than on every write_access_json call
    if (!this.config.discord?.user_id) {
      console.warn(
        "[pool] discord.user_id not set in config — pool bot DM allowlist will be empty. Run `lf init` to configure.",
      );
    }

    // Persist cleaned state (stale entries removed, duplicates resolved, current snapshot)
    await this.persist();

    console.log(
      `[pool] Initialized ${String(this.bots.length)} pool bots ` +
        `(${String(this.bots.filter((b) => b.state === "free").length)} free, ` +
        `${String(this.bots.filter((b) => b.state === "parked").length)} parked, ` +
        `${String(this.bots.filter((b) => b.state === "assigned").length)} assigned)`,
    );
  }

  /**
   * Proactively resume bots that were actively assigned before daemon shutdown.
   * Call AFTER Discord is connected so notifications can be sent.
   *
   * For each resume candidate: write access.json, set nickname, start tmux
   * with --resume, update state to assigned, emit bot:resumed.
   * Clears resume_candidates when done (or on skip) to prevent stale state.
   */
  async resume_parked_bots(): Promise<void> {
    if (this.resume_candidates.length === 0) return;

    console.log(
      `[pool] Proactively resuming ${String(this.resume_candidates.length)} bot(s) that were assigned before shutdown`,
    );

    let resumed = 0;
    for (const candidate of this.resume_candidates) {
      // Match both parked bots (tmux died) and assigned bots (tmux survived but
      // has stale MCP connection). Both need a fresh Claude process with --resume.
      const bot = this.bots.find(
        (b) =>
          b.id === candidate.id &&
          (b.state === "parked" || b.state === "assigned") &&
          b.channel_id === candidate.channel_id,
      );
      if (!bot) continue;

      // Broker channels are lazy and message-driven (#89): a broker session
      // exists iff an inbound message is driving it. Proactive-resume would
      // spawn an idle session with no turn-driver — the exact illegal state
      // that produced the 07-05 crash loop. Skip resume entirely; the channel
      // stays dark until the next human inbound cold-recreates it (carrying the
      // message as the driver, with --resume for continuity via the stash below).
      // We still kill any surviving tmux (its MCP connection died with the old
      // daemon) and stash the session_id so the cold-recreate resumes context.
      // Plugin channels fall through to the unchanged proactive-resume below.
      if (this.uses_broker(candidate.channel_id)) {
        console.log(
          `[pool] Skipping proactive-resume for broker channel ${candidate.channel_id} ` +
            `(pool-${String(bot.id)}) — lazy/message-driven; will cold-recreate on next inbound`,
        );
        await this.release_broker_to_dark(
          bot,
          candidate.session_id ?? null,
          "daemon restart — proactive-resume skipped (lazy/message-driven)",
        );
        continue;
      }

      const had_live_tmux = bot.state === "assigned";

      try {
        // Kill any surviving tmux session — the Claude process inside has a stale
        // MCP connection to the old daemon and can't reply through Discord.
        // This is safe even if the tmux session is already dead.
        if (had_live_tmux) {
          console.log(
            `[pool] Killing stale tmux for pool-${String(bot.id)} (MCP connection is dead after daemon restart)`,
          );
        }
        this.kill_tmux(bot.tmux_session);

        // Write access.json so the Discord plugin listens on this channel.
        // Pass entity_id so the entity's #alerts channel is also added to the
        // outbound allowlist (#40).
        await this.write_access_json(bot.state_dir, candidate.channel_id, candidate.entity_id);

        // Set Discord nickname and profile avatar to match the archetype
        await this.set_bot_nickname(bot, candidate.archetype);
        await this.set_bot_avatar(bot, candidate.archetype);

        // Resolve per-entity GitHub token (if configured) before spawning tmux.
        // The token is injected as a plain env var — no op run wrapping needed.
        const extra_env: Record<string, string> = {};
        const github_token_ref = this.resolve_github_token_ref(candidate.entity_id);
        if (github_token_ref) {
          try {
            extra_env.GH_TOKEN = await this.resolve_op_secret(github_token_ref);
          } catch (err) {
            console.warn(
              `[pool] Failed to resolve GH_TOKEN for ${candidate.entity_id}: ${String(err)}`,
            );
          }
        }

        // Resolve per-entity 1Password token (if present in the daemon env) so
        // the resumed session's `op` points at the entity's own vault.
        // Additive: when absent, the tmux-global platform token is inherited.
        const resume_op_token = this.resolve_entity_op_token(candidate.entity_id);
        if (resume_op_token) {
          extra_env.OP_SERVICE_ACCOUNT_TOKEN = resume_op_token;
        }
        console.log(
          `[pool] Resuming pool-${String(bot.id)} entity op token: ${resume_op_token ? "present" : "absent"} (entity: ${candidate.entity_id})`,
        );

        // Resolve per-entity CLAUDE_CONFIG_DIR (if configured) so this session
        // uses the entity's own Claude Max subscription.
        const resume_claude_config = this.resolve_claude_config_dir(candidate.entity_id);
        if (resume_claude_config) {
          extra_env.CLAUDE_CONFIG_DIR = resume_claude_config;
          console.log(
            `[pool] Resuming pool-${String(bot.id)} with CLAUDE_CONFIG_DIR=${resume_claude_config} (entity: ${candidate.entity_id})`,
          );
        }

        // Write a resume-nudge pending message and point LF_PENDING_FILE at
        // it. The SessionStart hook (session-start-inject.sh) delivers it
        // during Claude init as additionalContext — replacing the legacy
        // bridge_resume_nudge() tmux send-keys path that raced against
        // MCP plugin readiness. See issue #290.
        let nudge_written = false;
        try {
          const nudge_path = await write_pending_message(bot.tmux_session, {
            user: "lobsterfarm-daemon",
            channel_id: candidate.channel_id,
            message_id: "",
            content:
              "The daemon restarted and your session was resumed. Check where you left off and continue any in-progress work.",
            ts: new Date().toISOString(),
          });
          extra_env.LF_PENDING_FILE = nudge_path;
          nudge_written = true;
        } catch (err) {
          console.warn(
            `[pool] Failed to write resume nudge for pool-${String(bot.id)}: ${String(err)}`,
          );
          // Non-fatal: the session still resumes, just without the nudge.
        }

        // Spawn a fresh Claude process with --resume — establishes a new MCP
        // connection to this daemon while preserving conversation context
        const working_dir = entity_dir(this.config.paths, candidate.entity_id);
        await this.start_tmux(
          bot,
          candidate.archetype,
          candidate.entity_id,
          working_dir,
          candidate.session_id!,
          true,
          extra_env,
          candidate.channel_id,
        );

        // Update bot state to assigned. The resumed session is known to have
        // a JSONL on disk (pre-flight checked in initialize()), so mark it
        // confirmed — persist() will now write the session_id.
        bot.state = "assigned";
        bot.session_id = candidate.session_id;
        bot.session_confirmed = true;
        bot.last_active = new Date();
        bot.assigned_at = new Date(); // Reset uptime — new process

        // Post-restart deaf detection (#106). The resume nudge is a genuinely
        // injected message: a healthy resumed session runs a turn on it within
        // seconds of boot, while a session whose plugin/injection path did not
        // re-establish sits at the prompt forever — the exact 08-01→08-04
        // "alive but receiving nothing" signature. Two independent detectors:
        //   - `last_inbound_at` feeds the steady-state probe (90s threshold,
        //     30s ticks) for fast detection;
        //   - the probation entry feeds the one-shot `heal_post_restart` pass,
        //     whose JSONL-mtime check doesn't depend on pane heuristics.
        // Only armed when the nudge actually got written — with no injected
        // message, an idle session is legitimate, not deaf.
        if (nudge_written) {
          bot.last_inbound_at = new Date();
          bot.last_processing_at = null;
          this.post_restart_probation.set(bot.id, {
            channel_id: candidate.channel_id,
            entity_id: candidate.entity_id,
            session_id: candidate.session_id!,
            baseline: Date.now(),
          });
        }

        resumed++;
        console.log(
          `[pool] Resumed pool-${String(bot.id)} with fresh MCP connection ` +
            `(session: ${candidate.session_id!.slice(0, 8)}, ` +
            `was: ${had_live_tmux ? "stale tmux" : "parked"})`,
        );

        this.emit("bot:resumed", {
          bot_id: bot.id,
          channel_id: bot.channel_id,
          entity_id: bot.entity_id,
        });
      } catch (err) {
        console.error(`[pool] Failed to resume pool-${String(bot.id)}: ${String(err)}`);
        sentry.captureException(err, {
          tags: { module: "pool", bot_id: String(bot.id) },
          contexts: {
            resume: { entity_id: candidate.entity_id, session_id: candidate.session_id },
          },
        });
        // Leave the bot in its current state — parked bots can still be resumed
        // on next message; assigned bots with dead tmux will be caught by health monitor
      }
    }

    // Clear candidates regardless of success — prevents stale resumes
    // if the daemon stays running through another restart cycle
    this.resume_candidates = [];

    if (resumed > 0) {
      await this.persist();
      console.log(`[pool] Proactively resumed ${String(resumed)} bot(s)`);
    }
  }

  /**
   * Post-restart health check: repair bots that came back assigned-but-dead.
   *
   * The drain+restart cycle can leave a bot marked `assigned` to a channel with
   * NO live tmux session behind it — typically when the bot's session was
   * unconfirmed at drain time, so it persisted with `session=none` and never
   * qualified as a resume candidate. The bot listens (access.json points at the
   * channel) but no Claude process is running, so every message is silently
   * dropped (issue #66).
   *
   * For each assigned bot whose `tmux has-session` check fails, we respawn a
   * fresh session through the existing `restart_crashed_session()` path (which
   * resumes a confirmed session when one exists, otherwise spawns fresh). If a
   * bot can't be revived, we alert #alerts so the channel doesn't go silently
   * dark.
   *
   * Call AFTER `resume_parked_bots()` so legitimate resume candidates have
   * already had their chance — anything still assigned-but-dead here is a
   * genuine half-spawn that needs repair.
   */
  async reconcile_assigned_health(): Promise<void> {
    // Snapshot the bot list — restart_crashed_session() mutates state but never
    // adds/removes bots, so this stays valid for the whole pass. A dead bot is
    // only ever repaired once (it becomes assigned-with-live-tmux or freed).
    const half_spawned = this.bots.filter(
      (b) => b.state === "assigned" && b.channel_id && !this.is_tmux_alive(b.tmux_session),
    );
    if (half_spawned.length === 0) return;

    console.warn(
      `[pool] Post-restart health check: ${String(half_spawned.length)} assigned bot(s) have no live tmux — repairing`,
    );

    for (const bot of half_spawned) {
      const entity_id = bot.entity_id;
      const channel_id = bot.channel_id;
      const archetype = bot.archetype;

      // Broker channels are lazy/message-driven (#89): a half-spawned broker bot
      // (assigned but dead tmux — the #66 case where an unconfirmed session
      // wasn't a resume candidate) must be released to dark, not respawned into
      // an idle session. This is the restart-time twin of the health-monitor
      // branch in check_assigned_health. resume_parked_bots already released
      // broker RESUME candidates to dark; this catches the ones that weren't
      // candidates. Cold-recreate happens on the next inbound (with --resume via
      // the stash). Plugin channels fall through to the unchanged respawn path.
      if (channel_id && this.uses_broker(channel_id)) {
        console.warn(
          `[pool] pool-${String(bot.id)} came back assigned with a dead broker tmux ` +
            `(channel: ${channel_id}) — releasing to dark, no respawn (lazy/message-driven)`,
        );
        await this.release_broker_to_dark(
          bot,
          bot.session_id,
          "daemon restart — came back assigned with dead tmux",
        );
        continue;
      }

      console.warn(
        `[pool] pool-${String(bot.id)} came back assigned with a dead tmux session ` +
          `(channel: ${channel_id ?? "none"}, session: ${bot.session_id?.slice(0, 8) ?? "none"}) — respawning`,
      );

      // restart_crashed_session() owns the spawn path: it pre-flights the JSONL,
      // resumes when possible, writes access.json, and alerts #alerts on success.
      // On failure it frees the bot, so we detect that below to alert.
      await this.restart_crashed_session(bot);

      // If the bot is still assigned, the respawn succeeded. Otherwise it was
      // freed by the restart-failure path and the channel is now dark — alert.
      if (bot.state !== "assigned") {
        const label = this.channel_label(entity_id, channel_id);
        console.error(
          `[pool] pool-${String(bot.id)} could not be revived after restart — channel ${label} is dark`,
        );
        try {
          await notify(
            "alerts",
            `\ud83d\udd34 Pool bot ${String(bot.id)} (${archetype ?? "unknown"}) came back dead after restart and could not be revived for ${entity_id ?? "unknown"}/${label}. Channel is unattended — check daemon logs.`,
            entity_id ? this.registry?.get(entity_id) : undefined,
          );
        } catch (notify_err) {
          console.warn(
            `[pool] Failed to alert #alerts for un-revivable pool-${String(bot.id)}: ${String(notify_err)}`,
          );
        }
      }
    }
  }

  /**
   * Schedule the one-shot post-restart heal pass (#106).
   *
   * Call AFTER `resume_parked_bots()` + `reconcile_assigned_health()` — by then
   * every proactively-resumed bot with an injected resume nudge is on
   * probation. The pass runs once, POST_RESTART_HEAL_DELAY_MS later, and
   * recycles any probation session that shows zero evidence of having run a
   * turn since resume. No-op when nothing is on probation.
   */
  schedule_post_restart_heal(delay_ms: number = POST_RESTART_HEAL_DELAY_MS): void {
    if (this.post_restart_probation.size === 0) return;
    if (this.post_restart_heal_timer) return; // already scheduled

    console.log(
      `[pool] Post-restart heal pass scheduled in ${String(Math.round(delay_ms / 1000))}s ` +
        `for ${String(this.post_restart_probation.size)} resumed session(s)`,
    );
    this.post_restart_heal_timer = setTimeout(() => {
      this.post_restart_heal_timer = null;
      void this.heal_post_restart();
    }, delay_ms);
    // Don't hold the event loop open for the heal — daemon shutdown also
    // clears it explicitly.
    this.post_restart_heal_timer.unref?.();
  }

  /**
   * One-shot post-restart heal (#106): recycle resumed sessions that never
   * re-established message delivery.
   *
   * The 08-01→08-04 incident: a daemon restart proactively resumed sessions
   * that came back alive in tmux but receiving nothing — empty prompts,
   * `no transcript` — and the rooms stayed silently dark for days until an
   * operator manually recycled each bot. This pass makes that state
   * self-healing: every resumed-with-nudge session must show SOME evidence of
   * having run a turn since resume, or it gets the same release-to-fresh
   * recycle the operator performed by hand, with one aggregate alert listing
   * everything healed.
   *
   * Healthy evidence (any one suffices — all three are cheap and none can
   * false-negative a genuinely deaf session):
   *   1. `last_processing_at` ≥ baseline — the Stop hook stamped a completed
   *      turn (deterministic, closes the pane-sampling race).
   *   2. The session JSONL was modified since baseline — a turn ran or is
   *      mid-flight, independent of pane heuristics.
   *   3. The pane is non-idle right now — visibly working.
   *
   * A quiet-but-healthy room passes trivially: the resume nudge itself drives
   * a turn, so "no human spoke since the restart" still produces evidence 1+2.
   * Probation is only armed when the nudge was actually injected, so a session
   * with nothing to respond to is never judged deaf. Sessions whose tmux died
   * are left to the crash-restart machinery, and entries whose assignment
   * changed (released/reassigned/evicted meanwhile) are skipped — some other
   * path already handled them.
   *
   * Protected so tests can invoke it directly without the timer.
   */
  protected async heal_post_restart(): Promise<void> {
    if (this._draining) return;

    const entries = [...this.post_restart_probation.entries()];
    this.post_restart_probation.clear();
    if (entries.length === 0) return;

    const healed: string[] = [];
    const dark: string[] = [];

    for (const [bot_id, probation] of entries) {
      // Re-check drain state each iteration — recycle_deaf_bot awaits, so a
      // shutdown can start mid-pass and releasing/reassigning must stop with it.
      if (this._draining) break;

      const bot = this.bots.find((b) => b.id === bot_id);
      // Assignment moved on (released, reassigned, evicted, new session) —
      // whatever path did that owns the outcome; nothing to heal here.
      if (
        !bot ||
        bot.state !== "assigned" ||
        bot.channel_id !== probation.channel_id ||
        bot.session_id !== probation.session_id
      ) {
        continue;
      }

      // Still inside the liveness warm-up window (heal delay shorter than
      // warm-up, or assigned_at refreshed) — no reading is trustworthy yet.
      // The probation entry is CONSUMED here (this pass is one-shot: the map
      // was snapshotted-and-cleared above, and nothing re-schedules), so this
      // session gets no post-restart-heal verdict or aggregate alert. That is
      // deliberate low-risk behavior, not a gap: the bot-level
      // `last_inbound_at` marker stays armed, and the steady-state
      // check_plugin_liveness probe — with its own warm-up gate — still
      // detects a genuinely-deaf session and recycles it, just via the pane
      // path and its per-channel "went DEAF" alert instead of this pass.
      if (bot.assigned_at && Date.now() - bot.assigned_at.getTime() < LIVENESS_WARMUP_MS) {
        continue;
      }

      // Evidence the session ran (or is running) a turn since resume → healthy.
      if (bot.last_processing_at && bot.last_processing_at.getTime() >= probation.baseline) {
        bot.last_inbound_at = null;
        continue;
      }
      if (await this.session_jsonl_modified_since(probation.session_id, probation.baseline)) {
        bot.last_inbound_at = null;
        continue;
      }
      if (!this.is_bot_idle(bot)) {
        continue; // visibly working right now — the probe will finish the bookkeeping
      }
      // Dead tmux is a crash, not deafness — the health monitor owns restarts.
      if (!this.is_tmux_alive(bot.tmux_session)) {
        continue;
      }

      const label = `${probation.entity_id}/${this.channel_label(probation.entity_id, probation.channel_id)}`;
      console.error(
        `[pool] pool-${String(bot_id)} never processed its resume nudge after the daemon restart (session ${probation.session_id.slice(0, 8)}, channel ${probation.channel_id}) — plugin connection did not re-establish; auto-recycling`,
      );

      const outcome = await this.recycle_deaf_bot(bot, "post-restart heal");
      if (outcome === "recycled") {
        healed.push(label);
      } else if (outcome === "dark" || outcome === "loop_guard_released") {
        dark.push(label);
      }
    }

    if (healed.length === 0 && dark.length === 0) return;

    const lines: string[] = [];
    if (healed.length > 0) {
      lines.push(
        `🩹 Post-restart auto-heal: ${String(healed.length)} session(s) never re-established Discord message delivery after the daemon restart and were auto-recycled: ${healed.join(", ")}. Fresh sessions are up; conversation history resumed where available.`,
      );
    }
    if (dark.length > 0) {
      lines.push(
        `🔴 Post-restart auto-heal could NOT revive: ${dark.join(", ")}. These channels are unattended — recycle manually and check daemon logs.`,
      );
    }
    try {
      // Aggregate alert can span entities — route to the platform alerts
      // channel (no entity_config) where operators watch restarts.
      await notify("alerts", lines.join("\n"));
    } catch (notify_err) {
      console.warn(`[pool] Failed to post post-restart heal alert: ${String(notify_err)}`);
    }
  }

  /**
   * Whether a session's JSONL transcript was modified at/after `since_ms`.
   * Deterministic "the session ran a turn" evidence for the post-restart heal —
   * Claude Code appends to the JSONL as a turn executes, so a resumed session
   * that processed its nudge always moves the mtime forward. Fail-closed to
   * `false` (no evidence) when the file is missing/unreadable; the other
   * evidence checks still get their chance before a recycle. Protected so
   * tests can override without touching the real filesystem.
   */
  protected async session_jsonl_modified_since(
    session_id: string,
    since_ms: number,
  ): Promise<boolean> {
    try {
      const file = await find_session_file(session_id);
      if (!file) return false;
      const s = await stat(file);
      return s.mtimeMs >= since_ms;
    } catch {
      return false;
    }
  }

  /** Assign a pool bot to a channel with a specific archetype.
   *
   * If `pending_message` is provided, the daemon writes it to a JSON file and
   * sets `LF_PENDING_FILE` on the spawned Claude CLI's env. The
   * SessionStart hook (session-start-inject.sh) reads it during Claude init
   * and injects the message as additionalContext — replacing the legacy
   * tmux send-keys bridging that raced against MCP plugin readiness
   * (issue #290).
   *
   * CONTRACT (#107): for a broker-owned channel (`uses_broker`) a
   * `pending_message` driver is REQUIRED — a driverless call returns `null`
   * without spawning (see the choke-point guard below). Callers that can hit a
   * broker channel must synthesize a driver from the triggering user action
   * (see `channel_uses_broker`). Plugin channels are unaffected. */
  async assign(
    channel_id: string,
    entity_id: string,
    archetype: ArchetypeRole,
    resume_session_id?: string,
    channel_type?: ChannelType,
    working_dir?: string,
    pending_message?: PendingMessage,
  ): Promise<PoolAssignment | null> {
    if (this._draining) {
      console.log("[pool] Rejecting assignment — draining");
      return null;
    }

    // ── Broker choke-point guard (#107) ──
    //
    // The #89 invariant, enforced at the one place every session-creation path
    // funnels through: for a broker-owned channel, a session may only ever be
    // created carrying an inbound driver (`pending_message`) that the broker
    // queue delivers as its first turn. A driverless broker session idles at
    // the prompt, never confirms, and recreates exactly the zombie state that
    // sank the pilot twice (07-04 and 07-05, see #87/#89). Refusing HERE —
    // rather than caller-by-caller — kills the whole class of bug: no future
    // caller can reintroduce it. A dark channel that lazily recreates on the
    // next human message is strictly safer than an invariant-violating session.
    //
    // Gate is `uses_broker()` (config-driven, restart-stable), NOT
    // `broker_owns()` (empty until a session registers) — the #90 gate
    // rationale. With `broker.enabled: false` this branch is unreachable for
    // every channel, so flag-OFF behavior stays byte-identical to the plugin
    // path (merge gate since #86).
    if (!pending_message && this.uses_broker(channel_id)) {
      console.error(
        `[pool] [broker-guard] REFUSING driverless assign() for broker channel ${channel_id} (entity: ${entity_id}, archetype: ${archetype}, resume: ${resume_session_id?.slice(0, 8) ?? "none"}, channel_type: ${channel_type ?? "none"}) — a broker session exists iff an inbound message drives it (#89); channel stays dark, next inbound cold-recreates it`,
      );
      sentry.captureMessage("Broker choke-point guard refused a driverless assign()", "warning", {
        tags: { module: "pool", guard: "broker-choke-point" },
        contexts: {
          assign: {
            channel_id,
            entity_id,
            archetype,
            resume_session_id: resume_session_id ?? null,
            channel_type: channel_type ?? null,
          },
        },
      });
      return null;
    }

    // Check if this channel already has an assignment
    const existing = this.bots.find((b) => b.channel_id === channel_id && b.state === "assigned");
    if (existing) {
      console.log(`[pool] Channel ${channel_id} already assigned to pool-${String(existing.id)}`);
      return {
        bot_id: existing.id,
        channel_id,
        entity_id,
        archetype: existing.archetype!,
        session_id: existing.session_id,
        tmux_session: existing.tmux_session,
      };
    }

    // Synchronous in-flight lock: if another assign() call for this channel is
    // already past the "already assigned?" check but hasn't written state yet,
    // treat it as already assigned. This closes the check-then-act race where
    // two concurrent callers both pass the check above before either writes.
    if (this.assigning_channels.has(channel_id)) {
      console.log(`[pool] Channel ${channel_id} has an in-flight assignment — skipping`);
      return null;
    }
    this.assigning_channels.add(channel_id);

    try {
      // Resolve which session to resume — parameter, parked bot, or session history
      let resolved_session_id = resume_session_id;

      // Check for a parked bot that was previously on this channel — auto-resume
      const returning = this.bots.find(
        (b) => b.state === "parked" && b.channel_id === channel_id && b.entity_id === entity_id,
      );
      let bot: PoolBot | undefined;
      if (returning) {
        resolved_session_id = resolved_session_id ?? returning.session_id ?? undefined;
        bot = returning;
        console.log(
          `[pool] Reclaiming parked bot pool-${String(bot.id)} for channel ${channel_id} ` +
            `(session: ${resolved_session_id?.slice(0, 8) ?? "fresh"})`,
        );
      }

      // Check session_history for a previously evicted session on this channel.
      // Only used if no explicit resume_session_id was provided and no parked bot
      // was found (parked bots carry their own session_id).
      if (!resolved_session_id) {
        const history_key = `${entity_id}:${channel_id}`;
        const history_session = this.session_history.get(history_key);
        if (history_session) {
          resolved_session_id = history_session;
          console.log(
            `[pool] Found session history for channel ${channel_id}: ` +
              `${resolved_session_id.slice(0, 8)}`,
          );
        }
      }

      // Find a free bot if we don't have a returning one
      if (!bot) {
        bot = this.bots.find((b) => b.state === "free");
      }

      // Activity-aware eviction: free → parked → idle assigned → waiting_for_human → FLOOR
      // Within each tier: general channels before work rooms, then LRU.
      const eviction_sort = (a: PoolBot, b: PoolBot) => {
        const type_a = a.channel_type === "work_room" ? 1 : 0;
        const type_b = b.channel_type === "work_room" ? 1 : 0;
        if (type_a !== type_b) return type_a - type_b;
        return (a.last_active?.getTime() ?? 0) - (b.last_active?.getTime() ?? 0);
      };

      // Tier 2: Parked bots (cheapest eviction — already suspended)
      if (!bot) {
        const parked = this.bots.filter((b) => b.state === "parked").sort(eviction_sort);

        if (parked.length > 0) {
          bot = parked[0];
          console.log(
            `[pool] Evicting parked bot pool-${String(bot!.id)} (${bot!.channel_type ?? "unknown"} channel, LRU)`,
          );
        }
      }

      // Tier 3: Idle assigned bots (>= 30 min since last human interaction)
      if (!bot) {
        const idle_assigned = this.bots
          .filter((b) => b.state === "assigned" && this.compute_activity_state(b) === "idle")
          .sort(eviction_sort);

        if (idle_assigned.length > 0) {
          bot = idle_assigned[0];
          console.log(`[pool] Evicting idle bot pool-${String(bot!.id)} — parking`);
          await this.park_bot(bot!);
        }
      }

      // Tier 4: Waiting-for-human bots (3-30 min since last interaction — expensive but necessary)
      if (!bot) {
        const waiting = this.bots
          .filter(
            (b) => b.state === "assigned" && this.compute_activity_state(b) === "waiting_for_human",
          )
          .sort(eviction_sort);

        if (waiting.length > 0) {
          bot = waiting[0];
          console.log(`[pool] Evicting waiting-for-human bot pool-${String(bot!.id)} — parking`);
          await this.park_bot(bot!);
          // Notify that this session was parked with active context
          this.emit("bot:parked_with_context", {
            bot_id: bot!.id,
            channel_id: bot!.channel_id,
            entity_id: bot!.entity_id,
          });
        }
      }

      // FLOOR: active_conversation and working bots are NEVER evicted
      if (!bot) {
        console.log("[pool] All bots at floor (active/working) — no eviction possible");
        return null;
      }

      // Stash session history for the evicted bot's channel before overwriting.
      // Only stash if the bot is being reassigned away from a different channel
      // (i.e., not a returning parked bot reclaiming its own channel, and not a free bot).
      // Only stash *confirmed* sessions — stashing an unconfirmed UUID would
      // plant a phantom that the next assignment on this channel would try
      // (and fail) to --resume (issue #256).
      if (
        bot.channel_id &&
        bot.entity_id &&
        bot.session_id &&
        bot.session_confirmed &&
        bot.channel_id !== channel_id
      ) {
        const evict_key = `${bot.entity_id}:${bot.channel_id}`;
        this.session_history.set(evict_key, bot.session_id);
        this.session_history_ts.set(evict_key, Date.now());
        console.log(
          `[pool] Stashed session history for ${evict_key}: ${bot.session_id.slice(0, 8)}`,
        );
      }

      // Cancel any in-flight session-confirmation watcher for this bot —
      // the old session is about to be killed, so confirming it would be
      // a no-op at best and a race at worst.
      this.cancel_session_watcher(bot.id);

      // Kill any existing tmux session
      this.kill_tmux(bot.tmux_session);

      // Update access.json with the channel ID. Pass entity_id so the
      // entity's #alerts channel (#40) and #work-log channel (#56) are also
      // added to the outbound allowlist.
      await this.write_access_json(bot.state_dir, channel_id, entity_id);

      // Prune any foreign entity channels from the bot's access.json that
      // may have been over-granted by a prior buggy backfill. Only the
      // assigned channel, the entity's alerts channel, and the entity's
      // work_log channel belong in the groups map; everything else from the
      // same entity is removed. Non-fatal.
      try {
        await this.ensure_entity_channels_allowlisted(bot.state_dir, entity_id, channel_id);
      } catch (err) {
        console.warn(
          `[pool] ensure_entity_channels_allowlisted failed for pool-${String(bot.id)}: ${String(err)}`,
        );
        // Non-fatal: the bot can still function on its primary channel.
      }

      // Set Discord nickname and profile avatar to match the archetype
      await this.set_bot_nickname(bot, archetype);
      await this.set_bot_avatar(bot, archetype);

      // Resolve per-entity GitHub token (if configured) before spawning tmux.
      // The token is injected as a plain env var — no op run wrapping needed.
      const extra_env: Record<string, string> = {};
      const github_token_ref = this.resolve_github_token_ref(entity_id);
      if (github_token_ref) {
        try {
          extra_env.GH_TOKEN = await this.resolve_op_secret(github_token_ref);
        } catch (err) {
          console.warn(`[pool] Failed to resolve GH_TOKEN for ${entity_id}: ${String(err)}`);
          // Non-fatal: session starts without GH_TOKEN
        }
      }

      // Resolve per-entity 1Password token (if present in the daemon env) so
      // this session's `op` transparently points at the entity's own vault.
      // Additive: when absent, the tmux-global platform token is inherited.
      const entity_op_token = this.resolve_entity_op_token(entity_id);
      if (entity_op_token) {
        extra_env.OP_SERVICE_ACCOUNT_TOKEN = entity_op_token;
      }
      console.log(
        `[pool] Assigning pool-${String(bot.id)} entity op token: ${entity_op_token ? "present" : "absent"} (entity: ${entity_id})`,
      );

      // Resolve per-entity CLAUDE_CONFIG_DIR (if configured) so this session
      // uses the entity's own Claude Max subscription.
      const assign_claude_config = this.resolve_claude_config_dir(entity_id);
      if (assign_claude_config) {
        extra_env.CLAUDE_CONFIG_DIR = assign_claude_config;
        console.log(
          `[pool] Assigning pool-${String(bot.id)} with CLAUDE_CONFIG_DIR=${assign_claude_config} (entity: ${entity_id})`,
        );
      }

      // If a pending message was provided, write it to the JSON file and
      // point the spawn's LF_PENDING_FILE env var at it. The SessionStart
      // hook (session-start-inject.sh) will pick it up during Claude CLI
      // init and inject it as additionalContext — no tmux bridging needed.
      // See issue #290.
      //
      // This is written for BOTH transports so the plugin path (and the broker→
      // plugin fallback that prepare_broker_session takes on failure) always has
      // the hook available. For a session that actually comes up on the broker
      // transport, the pending file is unlinked and re-delivered through the
      // broker queue after start_tmux — see the broker first-message block below
      // (issue #87). Writing then conditionally unlinking keeps the plugin path
      // byte-identical while making the broker path fall back safely.
      if (pending_message) {
        try {
          const path = await write_pending_message(bot.tmux_session, pending_message);
          extra_env.LF_PENDING_FILE = path;
        } catch (err) {
          console.warn(
            `[pool] Failed to write pending message for pool-${String(bot.id)}: ${String(err)}`,
          );
          // Non-fatal: session still starts, just without the initial context.
        }
      }

      // Start the tmux session — use override working_dir if provided (e.g., feature worktree)
      // For fresh sessions, generate a UUID so pool-state.json always has a session_id
      // for proactive resume on daemon restart.
      const session_id = resolved_session_id ?? randomUUID();
      const resolved_dir = working_dir ?? entity_dir(this.config.paths, entity_id);
      await this.start_tmux(
        bot,
        archetype,
        entity_id,
        resolved_dir,
        session_id,
        !!resolved_session_id,
        extra_env,
        channel_id,
      );

      // BROKER first-message delivery (issue #87).
      //
      // start_tmux → prepare_broker_session has now registered channel ownership
      // IFF the broker transport was actually selected (broker prep can fall back
      // to plugin on failure, in which case ownership is not registered). When the
      // session truly came up on the broker transport, the SessionStart hook's
      // additionalContext does NOT drive a first turn — on broker the turn is
      // driven by the same `notifications/claude/channel` inbound the shim emits,
      // and message #1 was never enqueued, so the session idles and is dropped as
      // `unconfirmed … leaving unpersisted`. We fix that by:
      //   1. unlinking the pending file we wrote above (so the hook no-ops → no
      //      double-delivery alongside the queue), and
      //   2. enqueuing message #1 into the broker queue so the shim delivers it
      //      as a channel inbound and the session runs its first turn.
      // This converges first- and steady-state delivery on the queue for broker
      // sessions. On the plugin path (and the broker→plugin fallback) this block
      // is skipped, so the hook fires exactly as before — plugin behavior is
      // byte-identical.
      if (pending_message && this.broker_owns(channel_id)) {
        await unlink(pending_json_path(bot.tmux_session)).catch(() => {
          // Best-effort: a missing file (write above failed) just means the hook
          // was already going to no-op; the queue enqueue below is the delivery.
        });
        this.feed_broker_pending(channel_id, pending_message);
        // #83: now that ownership is registered, drain any inbound that raced in
        // during this cold-start (lost the assigning_channels lock) so they land
        // as ordered follow-up turns on this single session — no duplicate
        // dispatch, no dropped message.
        this.drain_broker_coldstart_buffer(channel_id);
      }

      // Update bot state
      const assigned_defaults = DEFAULT_ARCHETYPES[archetype];
      bot.state = "assigned";
      bot.channel_id = channel_id;
      bot.entity_id = entity_id;
      bot.archetype = archetype;
      bot.channel_type = channel_type ?? null;
      bot.session_id = session_id;
      // Resumed sessions already have a JSONL on disk (we pre-flight checked
      // at the initialize() / history-restore layer). Fresh sessions start
      // unconfirmed — persist() won't write the session_id until the
      // confirmation watcher sees the JSONL materialize. See issue #256.
      bot.session_confirmed = !!resolved_session_id;
      bot.model = resolve_model_id(assigned_defaults);
      bot.effort = resolve_effort(assigned_defaults.think);
      bot.last_active = new Date();
      bot.assigned_at = new Date();

      // Consume session history entry now that it's been used
      const assign_key = `${entity_id}:${channel_id}`;
      if (this.session_history.has(assign_key)) {
        this.session_history.delete(assign_key);
        this.session_history_ts.delete(assign_key);
        console.log(`[pool] Consumed session history for ${assign_key}`);
      }

      await this.persist();

      // Kick off a background watcher for fresh sessions: once Claude writes
      // its first JSONL turn we promote session_confirmed = true and persist
      // the session_id. If the daemon restarts before confirmation, the next
      // startup will not see session_id in pool-state.json and will cleanly
      // spawn a new session instead of crash-looping on --resume.
      if (!resolved_session_id) {
        this.watch_session_confirmation(bot, resolved_dir, session_id);
      }

      console.log(
        `[pool] Assigned pool-${String(bot.id)} to channel ${channel_id} ` +
          `as ${archetype} for entity ${entity_id}`,
      );

      sentry.addBreadcrumb({
        category: "daemon.pool",
        message: `Assigned pool-${String(bot.id)} as ${archetype}`,
        data: { bot_id: bot.id, channel_id, entity_id, archetype },
      });

      return {
        bot_id: bot.id,
        channel_id,
        entity_id,
        archetype,
        session_id: bot.session_id,
        tmux_session: bot.tmux_session,
      };
    } finally {
      this.assigning_channels.delete(channel_id);
      // If the buffer still holds entries here, this cold-start assign() never
      // reached broker registration (it failed or returned early before the
      // drain above) — so message #1 also failed and the human sees the same
      // "busy"/no-session outcome for the whole burst. Discard the stragglers
      // rather than leave them stranded with no owner; the human's retry drives
      // a fresh cold-start. The happy path already drained + deleted this key.
      const stranded = this.broker_coldstart_buffer.get(channel_id);
      if (stranded && stranded.length > 0) {
        this.broker_coldstart_buffer.delete(channel_id);
        console.warn(
          `[pool] Discarding ${String(stranded.length)} buffered broker inbound(s) for ` +
            `${channel_id} — cold-start assign did not register a session (burst will retry)`,
        );
      }
    }
  }

  /** Release a bot from its channel assignment. */
  async release(channel_id: string): Promise<void> {
    const bot = this.bots.find((b) => b.channel_id === channel_id && b.state === "assigned");
    if (!bot) return;

    // Synchronous in-flight lock: prevents double-release when two callers
    // (e.g., health monitor + explicit release) race on the same channel.
    if (this.releasing_channels.has(channel_id)) {
      console.log(`[pool] Channel ${channel_id} already being released — skipping`);
      return;
    }
    this.releasing_channels.add(channel_id);

    try {
      const bot_id = bot.id;
      // Fire memory-extraction BEFORE we null out entity/archetype/session_id.
      // Fire-and-forget — the gate snapshots metadata synchronously, so the
      // release proceeds without waiting on the Haiku round-trip.
      void this.extract_on_session_end(bot);
      this.kill_tmux(bot.tmux_session);
      this.cancel_session_watcher(bot_id);

      // Clear any orphaned pending file when releasing a bot — prevents stale
      // message content from a previous assignment leaking into a future one.
      void unlink(pending_file_path(bot.tmux_session)).catch(() => {});

      bot.state = "free";
      bot.channel_id = null;
      bot.entity_id = null;
      bot.archetype = null;
      bot.channel_type = null;
      bot.session_id = null;
      bot.session_confirmed = false;
      bot.model = null;
      bot.effort = null;
      bot.last_active = null;
      bot.assigned_at = null;

      // Clear access.json
      await this.write_access_json(bot.state_dir, null);

      // Drop broker ownership + any queued backlog for this channel (#85).
      // No-op when the channel was never broker-owned. Fail-open.
      this.broker?.release_channel(channel_id);

      await this.persist();

      console.log(`[pool] Released pool-${String(bot_id)}`);

      sentry.addBreadcrumb({
        category: "daemon.pool",
        message: `Released pool-${String(bot_id)}`,
        data: { bot_id },
      });

      this.emit("bot:released", { bot_id });
    } finally {
      this.releasing_channels.delete(channel_id);
    }
  }

  /** Park a bot — preserve session ID for later resume, free the bot. */
  private async park_bot(bot: PoolBot): Promise<void> {
    // Fire memory-extraction BEFORE killing tmux / mutating state — the gate
    // snapshots the session metadata (entity, archetype, session_id, channel)
    // synchronously, then runs async so parking is never blocked on Haiku.
    void this.extract_on_session_end(bot);
    this.kill_tmux(bot.tmux_session);
    bot.state = "parked";
    // session_id, channel_id, entity_id, archetype preserved for resume in memory.
    // Clear access.json on disk so no stale channel config survives if the bot's
    // tmux session is somehow restarted outside the normal assign() path.
    await this.write_access_json(bot.state_dir, null);
    await this.persist();
    console.log(
      `[pool] Parked pool-${String(bot.id)} ` +
        `(session: ${bot.session_id?.slice(0, 8) ?? "none"}, ` +
        `channel: ${bot.channel_id})`,
    );
  }

  /**
   * Fire Haiku-powered session-learnings extraction when a bot transitions out
   * of `assigned`, delegating to the existing `extract_session_learnings`
   * helper (which writes a daily-log summary and swallows its own errors).
   *
   * Wired to: `park_bot`, `release`, the restart-failed branch in
   * `restart_crashed_session`, the inline force-free branch in
   * `handle_crash_loop`, and the post-mortem path in `initialize` for bots
   * whose persisted state was `assigned` but whose tmux died across the
   * daemon restart. NOT wired to `server.ts`'s `handle_stop_hook` — that
   * fires once per assistant turn, the wrong cadence. NOT wired to the
   * successful-restart path — a resumed bot stays `assigned`, so its session
   * hasn't ended.
   *
   * Fires once per session lifecycle (one transition out of `assigned`),
   * never per turn. Subagents run inside the parent's pool session and are
   * covered by the parent's single session-end — no separate hook.
   *
   * The gate (state + required fields) is checked SYNCHRONOUSLY at call time
   * and the bot's metadata is snapshotted before the async Haiku call is
   * launched. This lets callers fire-and-forget — the lifecycle transition
   * (kill tmux, null fields, persist) proceeds immediately and is never
   * blocked on the up-to-30s `claude -p` round-trip. Best-effort: a failed
   * extraction is logged, never thrown. Returns a promise so tests can await
   * the launched work; production callers ignore it.
   */
  protected extract_on_session_end(bot: PoolBot): Promise<void> {
    // Exactly-once gate, checked synchronously while the bot is still in the
    // `assigned` state. Callers invoke this BEFORE flipping the bot to
    // `parked`/`free`; a redundant call on an already-transitioned bot is a
    // no-op. The post-mortem path in `initialize` sets `bot.state = "assigned"`
    // briefly so a dirty-crashed session still gets summarized.
    if (bot.state !== "assigned" || !bot.entity_id || !bot.archetype) {
      return Promise.resolve();
    }
    // Snapshot now: park_bot/release null these fields immediately after this
    // call returns, so the async body below must not read live bot state.
    const entity_id = bot.entity_id;
    const archetype = bot.archetype;
    // Sessions bind to a channel, not a feature; channel_id is the stable
    // daily-log identifier. session_id may be null pre-confirmation. Sentinels
    // keep the entry useful rather than dropping the call.
    const feature_id = bot.channel_id ?? "unknown-session";
    const session_id = bot.session_id ?? NO_SESSION;
    const bot_id = bot.id;

    return extract_session_learnings(
      entity_id,
      feature_id,
      archetype,
      session_id,
      this.config,
    ).catch((err: unknown) => {
      // Defense-in-depth: extract_session_learnings already swallows its own
      // errors, but a daily-log write failure could still bubble. Never let
      // memory extraction break the session-end transition.
      console.warn(
        `[pool] extract_on_session_end failed for pool-${String(bot_id)}: ${String(err)}`,
      );
    });
  }

  /** Get the assignment for a channel. */
  get_assignment(channel_id: string): PoolBot | undefined {
    return this.bots.find((b) => b.channel_id === channel_id && b.state === "assigned");
  }

  /** Clear session history for a specific channel. Used by !reset and feature completion. */
  clear_session_history(entity_id: string, channel_id: string): void {
    const key = `${entity_id}:${channel_id}`;
    if (this.session_history.delete(key)) {
      this.session_history_ts.delete(key);
      console.log(`[pool] Cleared session history for ${key}`);
    }
  }

  /** Mark a tmux session as having an in-flight pending file delivery.
   * Prevents drain_pending_files from re-delivering during the cleanup window.
   * Returns a cleanup function that unmarks the session and deletes the file. */
  mark_draining(tmux_session: string, pending_path: string): () => void {
    this.draining_sessions.add(tmux_session);
    return () => {
      void unlink(pending_path).catch(() => {});
      this.draining_sessions.delete(tmux_session);
    };
  }

  /** Check if an assigned bot's tmux session is still alive.
   * Returns false if the bot is not found, not assigned, or its tmux session is dead.
   * Used by discord.ts handle_message() to detect dead sessions on incoming messages. */
  is_session_alive(bot_id: number): boolean {
    const bot = this.bots.find((b) => b.id === bot_id);
    if (!bot || bot.state !== "assigned") return false;
    return this.is_tmux_alive(bot.tmux_session);
  }

  /** Check if an assigned bot's CLI has a stale OAuth token.
   * After 18+ hours the Claude CLI OAuth token expires. The CLI process stays alive
   * but responds with "Not logged in" to every message. The tmux session is still
   * running, so is_session_alive() returns true — this method catches that case.
   *
   * Only called on the message path (not polling) to keep it lightweight.
   * Returns false if the bot is not found, not assigned, or the pane can't be read. */
  has_stale_oauth(bot_id: number): boolean {
    const bot = this.bots.find((b) => b.id === bot_id);
    if (!bot || bot.state !== "assigned") return false;
    return this.is_pane_stale_oauth(bot.tmux_session);
  }

  /** Check if a tmux pane contains the "Not logged in" pattern from the Claude CLI.
   * Protected so tests can override via subclass. */
  protected is_pane_stale_oauth(session_name: string): boolean {
    try {
      const output = execFileSync("tmux", ["capture-pane", "-t", session_name, "-p"], {
        encoding: "utf-8",
        timeout: 2000,
      });
      return output.includes("Not logged in · Please run /login");
    } catch {
      return false; // Can't read pane — don't assume stale
    }
  }

  /** Kill the tmux session for a bot with a stale OAuth token.
   * Called by discord.ts before release_with_history() when the CLI is alive
   * but unresponsive due to expired authentication. */
  kill_stale_session(bot_id: number): void {
    const bot = this.bots.find((b) => b.id === bot_id);
    if (!bot) return;
    this.kill_tmux(bot.tmux_session);
  }

  /** Release a bot while preserving its session_id in history for future resume.
   * Stashes session_id before calling release(), which nulls all bot metadata.
   * Used by discord.ts when a message arrives for a bot with a dead tmux session. */
  async release_with_history(bot_id: number): Promise<void> {
    const bot = this.bots.find((b) => b.id === bot_id);
    if (!bot || !bot.channel_id) return;

    if (bot.session_id && bot.entity_id) {
      const key = `${bot.entity_id}:${bot.channel_id}`;
      this.session_history.set(key, bot.session_id);
      this.session_history_ts.set(key, Date.now());
      console.log(`[pool] Stashed session history for ${key}: ${bot.session_id.slice(0, 8)}`);
    }

    // release() uses channel_id to find the bot — grab it before it's nulled
    const channel_id = bot.channel_id;
    await this.release(channel_id);
  }

  /**
   * Stash a session_id into session_history for a future `--resume`, gated on
   * the single precondition shared by both terminal release paths
   * (`handle_crash_loop` and `release_broker_to_dark`): the session is
   * `session_confirmed` AND its JSONL still exists on disk *right now*.
   *
   * Why the disk pre-flight and not `session_confirmed` alone: `session_confirmed`
   * proves the JSONL existed at *confirmation* time, which can be minutes or
   * hours before a terminal path fires. Between confirmation and release the
   * JSONL can vanish (crash corruption, `~/.claude/projects` cleanup, manual
   * deletion). Stashing a session whose JSONL is gone plants a phantom UUID: the
   * next cold-recreate `--resume`s a non-existent transcript and burns crash-loop
   * retries (issue #256). Confirmation is the *floor*; the live disk check is the
   * gate. `handle_crash_loop` always did this; `release_broker_to_dark` did not,
   * which is the gap #92 closes — the two paths now share this one helper so
   * their stash precondition can't drift again.
   *
   * Logs the outcome (stashed / skipped-unconfirmed / skipped-JSONL-missing) and
   * returns true iff it stashed.
   *
   * @param label short context string threaded into the log lines (e.g.
   *   "crash-loop", "broker release-to-dark") so logs stay path-specific.
   */
  protected async stash_session_history(
    session_id: string | null,
    session_confirmed: boolean,
    channel_id: string | null,
    entity_id: string | null,
    label: string,
  ): Promise<boolean> {
    if (!session_id || !channel_id || !entity_id) return false;

    if (!session_confirmed) {
      console.warn(`[pool] Not stashing unconfirmed ${label} session ${session_id.slice(0, 8)}`);
      return false;
    }

    // Confirmed once, but re-verify the JSONL is still on disk — a session that
    // was confirmed earlier can have its transcript deleted before we release.
    if (!(await this.check_session_jsonl_exists_anywhere(session_id))) {
      console.warn(
        `[pool] Not stashing ${label} session ${session_id.slice(0, 8)} — JSONL missing`,
      );
      return false;
    }

    const key = `${entity_id}:${channel_id}`;
    this.session_history.set(key, session_id);
    this.session_history_ts.set(key, Date.now());
    console.log(
      `[pool] Stashed ${label} session history for ${key}: ${session_id.slice(0, 8)} (cold-recreate on next inbound)`,
    );
    return true;
  }

  /**
   * Release a broker bot to a dark (free, no live session) state without
   * respawning it (#89). This is the terminal behavior for broker channels on
   * the two non-message-driven session-creation paths — proactive-resume and
   * watchdog-respawn — that previously spawned idle sessions. It models
   * `handle_crash_loop`'s "stash history + release, no respawn" but is scoped to
   * broker channels and, critically, preserves the broker queue backlog.
   *
   * What it does:
   *   - Stashes `session_id` into session_history so the next inbound cold-
   *     recreates with `--resume` (continuity — lazy ≠ amnesiac). The stash goes
   *     through `stash_session_history`, the SAME confirmed-AND-JSONL-on-disk
   *     gate `handle_crash_loop` uses — no phantom UUID can be planted (#256/#92).
   *   - Kills tmux, clears access.json, frees the bot.
   *   - Drops broker OWNERSHIP only (`deregister_channel`) — it does NOT clear
   *     the durable queue, so any unacked inbound stays for at-least-once
   *     redelivery to the cold-recreated session (no message loss on crash).
   *   - Fires session-end extraction + emits `bot:released`.
   *
   * `session_id` is passed explicitly because the caller sometimes has a more
   * authoritative id than what's on the bot (the resume candidate's persisted
   * session_id vs. a parked bot's live field). Pass null to stash nothing.
   *
   * `reason` is a short human-readable cause ("daemon restart", "session died",
   * …) threaded into the #91 operator-visibility signal emitted below.
   *
   * Caller must have already confirmed `uses_broker(bot.channel_id)`.
   */
  private async release_broker_to_dark(
    bot: PoolBot,
    session_id: string | null,
    reason: string,
  ): Promise<void> {
    const channel_id = bot.channel_id;
    const entity_id = bot.entity_id;

    // Operator visibility (#91): exactly one info-level signal per dark
    // transition — this method runs once per assigned→free release, never per
    // health tick, so "once per channel" holds structurally. Deliberately NOT
    // an `alerts`-severity event: dark-and-waiting is designed behavior, not a
    // failure (the plugin revive-failure alerting is untouched).
    this.emit_broker_dark_signal(bot, channel_id, entity_id, reason);

    // Stash for --resume continuity via the shared confirmed-AND-JSONL-on-disk
    // gate (#92) — identical to handle_crash_loop, so a stash can never silently
    // no-op differently between the two terminal paths.
    await this.stash_session_history(
      session_id,
      bot.session_confirmed,
      channel_id,
      entity_id,
      "broker release-to-dark",
    );

    // Fire memory extraction before we null the bot's metadata (fire-and-forget;
    // the gate snapshots synchronously). No-op if there's nothing to summarize.
    void this.extract_on_session_end(bot);

    // Cancel any in-flight confirmation watcher — the process it observed is dead.
    this.cancel_session_watcher(bot.id);

    // Kill any surviving tmux (its MCP connection died with the old daemon) and
    // drop the orphaned pending file so stale content can't leak into a future
    // assignment.
    this.kill_tmux(bot.tmux_session);
    void unlink(pending_file_path(bot.tmux_session)).catch(() => {});

    bot.state = "free";
    bot.channel_id = null;
    bot.entity_id = null;
    bot.archetype = null;
    bot.channel_type = null;
    bot.session_id = null;
    bot.session_confirmed = false;
    bot.model = null;
    bot.effort = null;
    bot.last_active = null;
    bot.assigned_at = null;

    // Clear access.json so no plugin listener lingers, and drop broker OWNERSHIP
    // only (queue backlog preserved for redelivery). Swallow a write failure so a
    // release never throws on the restart/health hot path — the important state
    // transition (free) already landed in memory.
    await this.write_access_json(bot.state_dir, null).catch(() => {});
    if (channel_id) this.deregister_broker_channel(channel_id);

    await this.persist();

    this.emit("bot:released", { bot_id: bot.id });
  }

  /**
   * The #91 "channel left dark, awaiting inbound" operator signal: one
   * structured info log plus a low-severity #work-log note. Called exactly once
   * per dark transition (from `release_broker_to_dark`). Never throws and never
   * blocks the release path — the Discord note is fire-and-forget. Protected so
   * tests can spy on it directly.
   */
  protected emit_broker_dark_signal(
    bot: PoolBot,
    channel_id: string | null,
    entity_id: string | null,
    reason: string,
  ): void {
    console.log(
      `[pool] [broker-dark] Broker channel ${channel_id ?? "unknown"} left dark, awaiting inbound — reason: ${reason} (pool-${String(bot.id)}, session: ${bot.session_id?.slice(0, 8) ?? "none"}); next message cold-recreates the session`,
    );
    try {
      void notify(
        "work_log",
        `🌙 Broker channel <#${channel_id ?? "?"}> left dark (${reason}) — awaiting the next message, which recreates the session with continuity. Expected behavior, nothing to do.`,
        entity_id ? this.registry?.get(entity_id) : undefined,
      ).catch(() => {
        // Best-effort visibility — a failed work-log note must never break a
        // release/restart path.
      });
    } catch {
      /* same: never throw into the release path */
    }
  }

  // ── Dead-letter session heal (#107, the broker-era #106 items 2–3) ──

  /** Per-channel cool-down between automatic dead-letter heals. A repeat
   * dead-letter inside this window means the heal itself isn't fixing the
   * delivery path — re-healing would just loop. In-memory by design: a daemon
   * restart already releases broker channels to dark, so losing the timestamps
   * on restart is harmless (spec #107, Open Question 3 default: 10 minutes). */
  static readonly DEAD_LETTER_HEAL_COOLDOWN_MS = 10 * 60 * 1000;

  /** channel_id → epoch ms of the last automatic dead-letter heal. */
  private dead_letter_heal_at = new Map<string, number>();

  /**
   * Heal the session leg of a dead-lettered broker inbound (#107 / #106 class).
   *
   * A dead-letter means the shim never acked across the full redelivery horizon
   * (~2.5 min) — the owning session's delivery path is broken, and every
   * subsequent message would dead-letter too. The heal releases the owning bot
   * to dark via `release_broker_to_dark` (history stashed through the #92
   * shared gate, queue preserved via `deregister_channel`) so the NEXT inbound
   * cold-recreates the session with a fresh shim.
   *
   * The dead-lettered message itself is NOT re-enqueued: if the message is
   * poison, re-feeding it defeats the loop-breaker dead-lettering exists to be.
   * The human retries from the quoted alert.
   *
   * Heal-loop guard: if the same channel dead-letters again within
   * `DEAD_LETTER_HEAL_COOLDOWN_MS` of a heal, returns `cooldown` and takes no
   * automatic action — the caller escalates at failure severity.
   *
   * `now_ms` is injectable for tests.
   */
  async heal_dead_letter(
    channel_id: string,
    now_ms = Date.now(),
  ): Promise<
    | { outcome: "healed"; bot_id: number; session_id: string | null; entity_id: string | null }
    | { outcome: "cooldown"; last_heal_ms: number; entity_id: string | null }
    | { outcome: "no_session"; entity_id: string | null }
  > {
    // Belt-and-suspenders: dead-letters only fire for broker channels, but a
    // stale entry must never heal (i.e. release) a plugin-channel bot.
    if (!this.uses_broker(channel_id)) {
      return { outcome: "no_session", entity_id: this.entity_for_channel(channel_id) };
    }

    const last_heal = this.dead_letter_heal_at.get(channel_id);
    if (last_heal !== undefined && now_ms - last_heal < BotPool.DEAD_LETTER_HEAL_COOLDOWN_MS) {
      console.error(
        `[pool] [dead-letter-heal] channel ${channel_id} dead-lettered again within the ${String(Math.round(BotPool.DEAD_LETTER_HEAL_COOLDOWN_MS / 60_000))}min cool-down — heal suppressed (heal-loop guard), leaving dark`,
      );
      return {
        outcome: "cooldown",
        last_heal_ms: last_heal,
        entity_id: this.entity_for_channel(channel_id),
      };
    }

    const bot = this.bots.find((b) => b.state === "assigned" && b.channel_id === channel_id);
    if (!bot) {
      // Channel already dark (e.g. age-based sweep dead-lettered while no
      // session was assigned) — nothing to heal; next inbound cold-recreates.
      return { outcome: "no_session", entity_id: this.entity_for_channel(channel_id) };
    }

    // Snapshot BEFORE release_broker_to_dark nulls the bot's fields — the
    // caller routes the dead-letter alert to this entity's #alerts channel.
    const session_id = bot.session_id;
    const bot_id = bot.id;
    const entity_id = bot.entity_id;
    console.warn(
      `[pool] [dead-letter-heal] pool-${String(bot_id)} on ${channel_id} never acked a broker inbound through the full redelivery horizon — releasing to dark so the next message cold-recreates the session with a fresh shim`,
    );
    this.dead_letter_heal_at.set(channel_id, now_ms);
    await this.release_broker_to_dark(bot, session_id, "dead-letter heal — session stopped acking");
    return { outcome: "healed", bot_id, session_id, entity_id };
  }

  /**
   * Resolve which entity a channel belongs to, for alert routing (#107 review
   * fix): a bot bound to the channel first (any non-free state — a parked
   * bot's metadata is still authoritative), then the entity registry's channel
   * lists. Returns null when nothing claims the channel — the caller picks its
   * own fallback.
   */
  entity_for_channel(channel_id: string): string | null {
    const bot = this.bots.find((b) => b.channel_id === channel_id && b.entity_id);
    if (bot?.entity_id) return bot.entity_id;
    if (this.registry) {
      for (const entity of this.registry.get_all()) {
        if (entity.entity.channels?.list?.some((c) => c.id === channel_id)) {
          return entity.entity.id;
        }
      }
    }
    return null;
  }

  /** Get all bots currently assigned to a channel (state === "assigned").
   * Returns read-only snapshots — callers must not mutate the returned objects. */
  get_assigned_bots(): readonly PoolBot[] {
    return this.bots.filter((b) => b.state === "assigned");
  }

  /** Get pool status. */
  get_status(): PoolStatus {
    return {
      total: this.bots.length,
      free: this.bots.filter((b) => b.state === "free").length,
      assigned: this.bots.filter((b) => b.state === "assigned").length,
      parked: this.bots.filter((b) => b.state === "parked").length,
      assignments: this.bots
        .filter((b) => b.state !== "free")
        .map((b) => ({
          bot_id: b.id,
          channel_id: b.channel_id ?? "",
          entity_id: b.entity_id ?? "",
          archetype: b.archetype ?? "",
          state: b.state,
          last_active: b.last_active?.toISOString() ?? null,
        })),
    };
  }

  /**
   * Compute the activity state of a bot from observable signals.
   * Derived on demand from tmux pane state and last_active timestamp — never stored.
   */
  compute_activity_state(bot: PoolBot): ActivityState {
    if (bot.state !== "assigned") return "idle";

    // Check if bot is actively processing (tmux pane has no prompt)
    if (!this.is_bot_idle(bot)) return "working";

    // Check recency of last human interaction
    const idle_minutes = bot.last_active
      ? (Date.now() - bot.last_active.getTime()) / 60_000
      : Number.POSITIVE_INFINITY;

    // < 3 min: active conversation — don't touch
    if (idle_minutes < 3) return "active_conversation";
    // 3-30 min: bot asked a question or showed output recently — evictable as last resort
    if (idle_minutes < 30) return "waiting_for_human";
    // >= 30 min: fair game
    return "idle";
  }

  /**
   * Check if a single bot is idle at the prompt (not actively processing).
   *
   * Semantics: returns true when the last line of the tmux pane contains a prompt
   * character (❯) or a permissions dialog. This is a heuristic for "has prompt
   * visible" — the bot is not actively generating output or running a command.
   *
   * Fails open (returns true) when the tmux pane can't be read, which is the safe
   * default for eviction checks: we'd rather evict a bot we can't observe than
   * refuse to evict when the pool is exhausted.
   */
  is_bot_idle(bot: PoolBot): boolean {
    return is_tmux_session_idle(bot.tmux_session);
  }

  /** Check if any pool bots are actively working (not idle at prompt). */
  has_active_work(): {
    active: boolean;
    working_bots: Array<{ id: number; archetype: string; channel_id: string }>;
  } {
    const working: Array<{ id: number; archetype: string; channel_id: string }> = [];

    for (const bot of this.bots) {
      if (bot.state !== "assigned") continue;

      if (!this.is_bot_idle(bot)) {
        working.push({
          id: bot.id,
          archetype: bot.archetype ?? "unknown",
          channel_id: bot.channel_id ?? "",
        });
      }
    }

    return { active: working.length > 0, working_bots: working };
  }

  /** Update last_active timestamp for a channel's bot. */
  touch(channel_id: string): void {
    const bot = this.bots.find((b) => b.channel_id === channel_id && b.state === "assigned");
    if (bot) {
      bot.last_active = new Date();
    }
  }

  /**
   * Record that the daemon just routed an inbound human message to this
   * channel's assigned bot (issue #73 — plugin-liveness probe).
   *
   * The inbound Discord→live-bot delivery path is pure MCP plugin with no
   * daemon send-keys, so the daemon otherwise has no record that a message was
   * handed to a (live but possibly deaf) bot. This timestamp is what the probe
   * uses to detect prolonged inbound silence: if the bot never starts
   * processing after an inbound, the plugin is deaf. Called from the discord.ts
   * steady-state `touch()` call-site for already-assigned, live bots.
   */
  mark_inbound(channel_id: string): void {
    const bot = this.bots.find((b) => b.channel_id === channel_id && b.state === "assigned");
    if (bot) {
      bot.last_inbound_at = new Date();
    }
  }

  /**
   * Record that a session just completed an assistant turn (#106).
   *
   * Called from the daemon's `/hooks/stop` endpoint — every Claude session's
   * Stop hook POSTs its session_id there once per turn. This is a
   * *deterministic* "the session ran a turn" signal, unlike the tmux pane
   * sampling the probe otherwise relies on: a bot that receives an inbound and
   * answers it entirely between two 30s health ticks would look
   * idle-with-no-processing to the sampler and be judged deaf. Stamping
   * `last_processing_at` on turn completion closes that false-positive window
   * for both the steady-state probe and the post-restart heal.
   */
  mark_processed(session_id: string): void {
    if (!session_id) return;
    const bot = this.bots.find((b) => b.session_id === session_id && b.state === "assigned");
    if (bot) {
      bot.last_processing_at = new Date();
    }
  }

  /**
   * Start the tmux session health monitor.
   * Checks every 30 seconds for assigned bots whose tmux sessions have died.
   * When a dead session is found, attempts to restart it automatically.
   * If restart fails, emits "bot:session_ended" and frees the bot.
   * If the bot is in a crash loop (>3 crashes/hour), releases without restart.
   */
  start_health_monitor(): void {
    if (this.health_timer) return; // already running

    this.health_timer = setInterval(() => {
      this.check_assigned_health();
    }, 30_000);

    console.log("[pool] Health monitor started (30s interval)");
  }

  /** Stop the health monitor. */
  stop_health_monitor(): void {
    if (this.health_timer) {
      clearInterval(this.health_timer);
      this.health_timer = null;
      console.log("[pool] Health monitor stopped");
    }
  }

  /**
   * Start the rate-limit modal recovery monitor (issue #270).
   *
   * Every 60 seconds, captures the last lines of each assigned pool bot's tmux
   * pane and checks for the Claude Code usage-limit modal. If detected, sends
   * Escape to dismiss the modal and posts to the entity's alerts channel.
   *
   * Separate from the 30s health monitor because the concerns are different:
   * health = dead sessions, rate-limit = stuck modals on live sessions.
   */
  start_rate_limit_monitor(): void {
    if (this.rate_limit_timer) return; // already running

    this.rate_limit_timer = setInterval(() => {
      this.check_rate_limit_modals();
    }, 60_000);

    console.log("[pool] Rate-limit recovery monitor started (60s interval)");
  }

  /** Stop the rate-limit recovery monitor. */
  stop_rate_limit_monitor(): void {
    if (this.rate_limit_timer) {
      clearInterval(this.rate_limit_timer);
      this.rate_limit_timer = null;
      console.log("[pool] Rate-limit recovery monitor stopped");
    }
  }

  /**
   * Scan assigned bots for rate-limit modals and dismiss them.
   * Protected so tests can invoke directly without waiting for the interval.
   */
  protected async check_rate_limit_modals(): Promise<void> {
    if (this._draining) return;

    const assigned = this.bots.filter((b) => b.state === "assigned");
    if (assigned.length === 0) return;

    const recovered = scan_and_recover(assigned);

    // Post alerts for each recovered bot
    for (const result of recovered) {
      const entity_config = result.entity_id ? this.registry?.get(result.entity_id) : undefined;
      try {
        await notify(
          "alerts",
          `\u26a0\ufe0f Pool bot ${String(result.bot_id)} hit rate-limit modal — auto-dismissed for ${result.entity_id ?? "unknown"}`,
          entity_config,
        );
      } catch (err) {
        console.warn(
          `[rate-limit-recovery] Failed to alert for ${result.tmux_session}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Check all assigned bots for dead tmux sessions.
   * When a dead session is found, attempts to restart it automatically.
   * If a bot crashes too often (>3 times in 1 hour), it's released instead
   * of restarted to prevent crash loops.
   * Protected so tests can call it directly without waiting for the interval.
   */
  protected async check_assigned_health(): Promise<void> {
    if (this._draining) return;
    if (this._health_check_running) return;
    this._health_check_running = true;

    try {
      // Clean up old crash history entries (>1 hour) to prevent memory growth
      this.cleanup_crash_history();
      this.cleanup_session_history();

      // Deliver any queued messages to bots that are now at the prompt
      await this.drain_pending_injections();

      // Safety net: recover undelivered legacy .txt pending files left by
      // any older spawn path. The canonical SessionStart-hook injection
      // (issue #290) uses .json files consumed by the hook script and
      // doesn't need drain recovery — but we keep this logic for the
      // legacy .txt format as belt-and-suspenders per the issue spec.
      await this.drain_pending_files();

      for (const bot of this.bots) {
        if (bot.state !== "assigned") continue;

        if (this.is_tmux_alive(bot.tmux_session)) {
          // Session alive — check for orphaned cwd (directory deleted out from under it)
          await this.check_cwd_health(bot);
          // Session alive in tmux is NOT the same as the MCP plugin actually
          // delivering inbound Discord messages. Probe for a live-but-deaf bot
          // that received a message it never processed (issue #73).
          await this.check_plugin_liveness(bot);
          continue;
        }

        // Broker channels are lazy/message-driven (#89): a dead broker session
        // must be released to dark, NOT respawned into an idle session. Respawn
        // has no message to drive the first turn, so it dies and respawns again
        // — the 07-05 crash loop. Release-to-dark short-circuits BEFORE
        // record_crash so the crash-loop counter never even ticks: the loop
        // cannot start. The next inbound cold-recreates the session (with
        // --resume via the stash inside release_broker_to_dark). Plugin channels
        // fall through to the unchanged record_crash → restart path below.
        if (bot.channel_id && this.uses_broker(bot.channel_id)) {
          console.warn(
            `[pool] pool-${String(bot.id)} broker tmux died — releasing to dark ` +
              `(channel: ${bot.channel_id}); cold-recreate on next inbound, no respawn`,
          );
          await this.release_broker_to_dark(bot, bot.session_id, "session died (health tick)");
          continue;
        }

        // Tmux session died — attempt recovery
        console.warn(
          `[pool] pool-${String(bot.id)} tmux crashed — attempting restart ` +
            `(channel: ${bot.channel_id ?? "none"})`,
        );

        // Record this crash for loop detection
        this.record_crash(bot.id);

        // Check for crash loop before attempting restart
        if (this.is_crash_loop(bot.id)) {
          await this.handle_crash_loop(bot);
          continue;
        }

        // Orphan bot — no assignment metadata to restart with.
        // Free immediately and log so crash recovery is visible.
        if (!bot.entity_id || !bot.channel_id) {
          console.log(
            `[pool] Freeing orphan pool-${String(bot.id)} (no metadata — cannot restart)`,
          );
          this.cancel_session_watcher(bot.id);
          bot.state = "free";
          bot.channel_id = null;
          bot.entity_id = null;
          bot.archetype = null;
          bot.channel_type = null;
          bot.session_id = null;
          bot.session_confirmed = false;
          bot.model = null;
          bot.effort = null;
          bot.last_active = null;
          bot.assigned_at = null;
          await this.persist();
          this.emit("bot:released", { bot_id: bot.id });
          continue;
        }

        // Attempt restart
        await this.restart_crashed_session(bot);
      }
    } finally {
      this._health_check_running = false;
    }
  }

  // ── Plugin-liveness probe (#73) ──

  /**
   * Probe an assigned, tmux-alive bot for MCP plugin deafness.
   *
   * The inbound Discord→bot path is pure MCP plugin — no daemon send-keys — so a
   * bot can be perfectly alive in tmux yet silently stop receiving messages if
   * the plugin's channel listener dies (observed after a crash-loop on #new-ui).
   * `reconcile_assigned_health` / `check_assigned_health` only verify tmux
   * liveness, which this gap slips right past.
   *
   * Detection is purely observational — no synthetic echo messages that would
   * pollute the channel. We compare two timestamps the daemon already owns:
   *   - `last_inbound_at`: set when discord.ts routed a human message here.
   *   - whether the bot is currently/recently *working* (pane non-idle).
   *
   * A healthy bot starts working within seconds of the plugin delivering the
   * message. A deaf bot stays at the idle prompt forever. So a bot is deaf when:
   *   1. it received an inbound (`last_inbound_at` set),
   *   2. that inbound is older than PLUGIN_DEAF_THRESHOLD_MS but not so old it's
   *      already stale/handled (we cap the window so we never re-probe an
   *      ancient inbound after the bot legitimately went idle),
   *   3. it has shown ZERO processing since that inbound — never went non-idle.
   *
   * Healthy observation (bot non-idle, or processed after the inbound) clears
   * the inbound marker so we don't keep probing a bot that's done its work.
   *
   * Protected so tests can drive it directly without the 30s interval.
   */
  protected async check_plugin_liveness(bot: PoolBot): Promise<void> {
    if (this._draining) return;
    if (bot.state !== "assigned" || !bot.channel_id) return;
    if (this.recovering_plugin.has(bot.id)) return; // recovery already in flight

    // Broker-transport sessions are exempt from the DEAF probe. The observational
    // probe exists to catch a plugin whose channel listener silently died — but a
    // broker session has no plugin listener: the daemon's durable queue holds each
    // inbound and redelivers with its own ack until the shim consumes it, so the
    // broker's redelivery IS the liveness mechanism. Worse, the probe would fight
    // the broker: during a shim reconnect backoff (up to ~10s) the agent legitimately
    // hasn't processed yet, and a spurious DEAF restart would kill the shim the broker
    // is mid-redelivery to — a self-defeating loop. `broker_owns` is the same
    // broker-transport signal threaded through bring-up (registered in
    // prepare_broker_session, dropped on release); it returns false when the flag is
    // off or the broker is unset, so plugin-transport sessions are entirely unaffected
    // and flag-OFF behavior is byte-identical.
    if (this.broker_owns(bot.channel_id)) return;

    const inbound = bot.last_inbound_at;
    if (!inbound) return; // nothing delivered — skip the tmux pane read entirely

    // Warm-up gate (#106 review blocker): take NO reading — healthy or deaf —
    // until the session has been up long enough for its pane to settle. The
    // spawn-time arming sites (resume nudge, recycle recovery message) set
    // `last_inbound_at` at T≈0, and a health tick landing mid-boot could
    // otherwise mis-read startup output as "working", stamp
    // `last_processing_at`, and clear the armed marker — silencing both this
    // probe AND the post-restart heal for a genuinely-deaf session. The grace
    // window already spans the same interval, so gating costs no detection
    // latency. Bots with no assigned_at (pathological) fall through to the
    // original behavior.
    if (bot.assigned_at && Date.now() - bot.assigned_at.getTime() < LIVENESS_WARMUP_MS) return;

    const verdict = evaluate_plugin_liveness(
      {
        last_inbound_at: inbound,
        last_processing_at: bot.last_processing_at,
        is_idle: this.is_bot_idle(bot),
      },
      Date.now(),
    );

    switch (verdict) {
      case "no_inbound":
      case "grace":
        // Still within the delivery/startup grace window. Preserve the inbound
        // marker so a later pass can still catch deafness.
        return;
      case "healthy_working":
        // Actively working → plugin delivered. Record processing and clear the
        // inbound marker so a later idle period (the bot awaiting the next human
        // reply) is never mistaken for deafness.
        bot.last_processing_at = new Date();
        bot.last_inbound_at = null;
        return;
      case "healthy_processed":
        // Processed after the inbound, then returned to idle — received and
        // handled. Clear the marker.
        bot.last_inbound_at = null;
        return;
      case "deaf": {
        const since_inbound = Date.now() - inbound.getTime();
        console.error(
          `[pool] pool-${String(bot.id)} appears DEAF to inbound Discord — idle ${String(
            Math.round(since_inbound / 1000),
          )}s after a message with no processing (channel: ${bot.channel_id}). MCP plugin likely stopped delivering — recovering.`,
        );
        await this.recover_deaf_bot(bot);
        return;
      }
    }
  }

  /**
   * Recover a bot whose MCP plugin has gone deaf to inbound Discord messages.
   *
   * Probe-path entry point: posts the operator alerts (naming the channel) and
   * delegates the mechanics to `recycle_deaf_bot`. Recovery is a full
   * release-to-fresh recycle (#106) — the same `release` + `assign` an operator
   * performs by hand — NOT the old in-place `restart_crashed_session` respawn:
   * the 08-01→08-04 incident showed restart churn itself producing sessions
   * that came back alive-but-deaf, while a clean release + fresh assignment
   * reliably restored delivery.
   */
  private async recover_deaf_bot(bot: PoolBot): Promise<void> {
    if (this.recovering_plugin.has(bot.id)) return;

    const bot_id = bot.id;
    const entity_id = bot.entity_id;
    const channel_id = bot.channel_id;
    const archetype = bot.archetype;
    const entity_config = entity_id ? this.registry?.get(entity_id) : undefined;
    const label = this.channel_label(entity_id, channel_id);

    try {
      await notify(
        "alerts",
        `🔴 Pool bot ${String(bot_id)} (${archetype ?? "unknown"}) went DEAF to inbound Discord for ${entity_id ?? "unknown"}/${label} — alive in tmux but no longer receiving channel messages. Auto-recycling: releasing the bot and assigning a fresh session (conversation resumes from history where possible).`,
        entity_config,
      );
    } catch (notify_err) {
      console.warn(
        `[pool] Failed to alert #alerts for deaf pool-${String(bot_id)}: ${String(notify_err)}`,
      );
    }

    const outcome = await this.recycle_deaf_bot(bot, "deaf-recycle");

    if (outcome === "loop_guard_released") {
      try {
        await notify(
          "alerts",
          `🔴 ${entity_id ?? "unknown"}/${label} keeps going DEAF — auto-recycled ${String(MAX_DEAF_RECYCLES_PER_WINDOW)}x in the last hour without curing delivery. Bot released WITHOUT reassign; the channel is dark until manually recycled (POST /pool/assign). Investigate the Discord plugin/bot token.`,
          entity_config,
        );
      } catch (notify_err) {
        console.warn(
          `[pool] Failed to alert #alerts for deaf loop-guard on ${label}: ${String(notify_err)}`,
        );
      }
    } else if (outcome === "dark") {
      console.error(
        `[pool] pool-${String(bot_id)} could not be reassigned after plugin deafness — channel ${label} is dark`,
      );
      try {
        await notify(
          "alerts",
          `🔴 Pool bot ${String(bot_id)} (${archetype ?? "unknown"}) could not be reassigned after going deaf for ${entity_id ?? "unknown"}/${label}. Channel is unattended — check daemon logs.`,
          entity_config,
        );
      } catch (notify_err) {
        console.warn(
          `[pool] Failed to alert #alerts for un-recoverable deaf pool-${String(bot_id)}: ${String(notify_err)}`,
        );
      }
    }
  }

  /**
   * Release-to-fresh recycle for a deaf plugin session (#106) — shared by the
   * steady-state probe (`recover_deaf_bot`) and the post-restart heal pass
   * (`heal_post_restart`). Alert side-effects stay with the callers (mirroring
   * the plugin-liveness module's caller-owns-side-effects split); this owns the
   * mechanics:
   *
   *   1. Loop guard: give up (release, no reassign) after
   *      MAX_DEAF_RECYCLES_PER_WINDOW recycles per channel per window.
   *   2. Stash the session via the #92-gated helper so the fresh assignment
   *      `--resume`s the conversation when the JSONL is intact.
   *   3. `release()` + `assign()` — exactly the operator's manual recycle —
   *      with an injected recovery message that (a) drives the fresh session's
   *      first turn on the plugin path and (b) tells the agent to catch up on
   *      the channel messages the deaf plugin dropped.
   *   4. Stamp `last_inbound_at` on the fresh bot: the recovery message was
   *      genuinely injected, so if the new session never processes it either,
   *      the probe re-fires and the loop guard ends the churn.
   */
  private async recycle_deaf_bot(
    bot: PoolBot,
    label: string,
  ): Promise<"recycled" | "loop_guard_released" | "dark" | "skipped"> {
    if (this.recovering_plugin.has(bot.id)) return "skipped";
    this.recovering_plugin.add(bot.id);

    const entity_id = bot.entity_id;
    const channel_id = bot.channel_id;
    const archetype = bot.archetype;
    const channel_type = bot.channel_type;
    const session_id = bot.session_id;
    const session_confirmed = bot.session_confirmed;

    // Consume the markers up-front so a concurrent/next probe pass can't
    // re-trigger on the same silence while we're mid-recycle. Probation entry
    // (if any) is consumed too — this recycle IS its heal.
    bot.last_inbound_at = null;
    bot.last_processing_at = null;
    this.post_restart_probation.delete(bot.id);

    try {
      if (!channel_id || !entity_id || !archetype) {
        // Pathological: assigned bot with incomplete metadata. There is nothing
        // sane to reassign; release the channel if we can name it, else leave
        // it to the health monitor's orphan handling.
        console.error(
          `[pool] Cannot recycle deaf pool-${String(bot.id)} — incomplete assignment metadata ` +
            `(channel: ${channel_id ?? "none"}, entity: ${entity_id ?? "none"})`,
        );
        if (channel_id) await this.release(channel_id);
        return "dark";
      }

      // Loop guard: recycling the same channel over and over means the recycle
      // isn't curing the root cause — stop the churn and hand it to a human.
      const now = Date.now();
      const recent = (this.deaf_recycle_history.get(channel_id) ?? []).filter(
        (t) => now - t < DEAF_RECYCLE_WINDOW_MS,
      );
      if (recent.length >= MAX_DEAF_RECYCLES_PER_WINDOW) {
        this.deaf_recycle_history.set(channel_id, recent);
        console.error(
          `[pool] Channel ${channel_id} went deaf again after ${String(recent.length)} auto-recycle(s) in the last hour — giving up (release without reassign)`,
        );
        await this.stash_session_history(
          session_id,
          session_confirmed,
          channel_id,
          entity_id,
          `${label} loop-guard`,
        );
        await this.release(channel_id);
        return "loop_guard_released";
      }
      recent.push(now);
      this.deaf_recycle_history.set(channel_id, recent);

      // Stash BEFORE release (release nulls the bot's session fields) so
      // assign() below finds the session in history and --resumes it.
      await this.stash_session_history(session_id, session_confirmed, channel_id, entity_id, label);
      await this.release(channel_id);

      let assignment: PoolAssignment | null = null;
      try {
        assignment = await this.assign(
          channel_id,
          entity_id,
          archetype,
          undefined,
          channel_type ?? undefined,
          undefined,
          {
            user: "lobsterfarm-daemon",
            channel_id,
            message_id: "",
            content:
              "Your session's Discord connection went deaf and the daemon auto-recycled it. " +
              "Recent messages in this channel may never have reached you — fetch the " +
              "channel's recent messages and respond to anything left unanswered.",
            ts: new Date().toISOString(),
          },
        );
      } catch (err) {
        console.error(
          `[pool] Deaf recycle reassign failed for channel ${channel_id}: ${String(err)}`,
        );
        sentry.captureException(err, {
          tags: { module: "pool", action: "deaf_recycle" },
          contexts: { recycle: { entity_id, channel_id, label } },
        });
      }

      if (!assignment) return "dark";

      const fresh = this.bots.find((b) => b.id === assignment.bot_id);
      if (fresh && fresh.state === "assigned" && fresh.channel_id === channel_id) {
        fresh.last_inbound_at = new Date();
        fresh.last_processing_at = null;
      }

      console.log(
        `[pool] Recycled deaf channel ${channel_id}: pool-${String(bot.id)} released, ` +
          `pool-${String(assignment.bot_id)} assigned fresh (${label})`,
      );
      return "recycled";
    } finally {
      this.recovering_plugin.delete(bot.id);
    }
  }
  // ── Crash Recovery ──

  /**
   * Attempt to restart a crashed bot's tmux session. Preserves the existing
   * session_id for --resume when available, otherwise spawns a fresh session.
   * Posts to the entity's #alerts channel on success.
   */
  private async restart_crashed_session(bot: PoolBot): Promise<void> {
    // Snapshot assignment state before we attempt anything — if restart fails
    // we still need these for cleanup.
    const entity_id = bot.entity_id;
    const channel_id = bot.channel_id;
    const archetype = bot.archetype;
    const session_id = bot.session_id;

    if (!entity_id || !archetype) {
      console.error(`[pool] Cannot restart pool-${String(bot.id)}: missing fields — force-freeing`);
      this.cancel_session_watcher(bot.id);

      // No session-end extraction here: this branch is reached precisely when
      // entity_id or archetype is missing, which is exactly the condition the
      // extract_on_session_end gate bails on. There's nothing to summarize.

      // Stash session history when possible — allows a future assignment on
      // this channel to resume the session even though we can't restart now.
      // Only stash *confirmed* sessions (JSONL on disk) to avoid planting
      // phantom session_history entries (issue #256).
      if (session_id && bot.session_confirmed && channel_id && entity_id) {
        const key = `${entity_id}:${channel_id}`;
        this.session_history.set(key, session_id);
        this.session_history_ts.set(key, Date.now());
        console.log(`[pool] Stashed session history for ${key}: ${session_id.slice(0, 8)}`);
      }

      bot.state = "free";
      bot.channel_id = null;
      bot.entity_id = null;
      bot.archetype = null;
      bot.channel_type = null;
      bot.session_id = null;
      bot.model = null;
      bot.effort = null;
      bot.last_active = null;
      bot.assigned_at = null;
      await this.persist();
      this.emit("bot:released", { bot_id: bot.id });
      return;
    }

    // Look up entity config for alerting and GH_TOKEN resolution
    const entity_config = this.registry?.get(entity_id);

    // Any in-flight session-confirmation watcher for this bot is stale now —
    // the tmux/Claude process it was observing is dead.
    this.cancel_session_watcher(bot.id);

    // Defensive pre-flight (issue #256): if we have a session_id but its
    // JSONL transcript doesn't exist anywhere on disk, --resume will fail
    // every time. Fall through to a fresh session instead of burning
    // crash-loop retries. We search all project slugs because the session
    // may have been spawned in a worktree cwd that differs from entity_dir.
    const working_dir = entity_dir(this.config.paths, entity_id);
    let resume_id: string;
    let is_resume: boolean;
    if (session_id && (await this.check_session_jsonl_exists_anywhere(session_id))) {
      resume_id = session_id;
      is_resume = true;
    } else {
      if (session_id) {
        console.warn(
          `[pool] pool-${String(bot.id)}: session ${session_id.slice(0, 8)} has no JSONL on disk — spawning fresh session instead of --resume (prevents crash loop)`,
        );
      }
      resume_id = randomUUID();
      is_resume = false;
    }
    let restarted = false;
    try {
      // Resolve per-entity GitHub token (if configured)
      const extra_env: Record<string, string> = {};
      const github_token_ref = this.resolve_github_token_ref(entity_id);
      if (github_token_ref) {
        try {
          extra_env.GH_TOKEN = await this.resolve_op_secret(github_token_ref);
        } catch (err) {
          console.warn(`[pool] Failed to resolve GH_TOKEN for ${entity_id}: ${String(err)}`);
        }
      }

      // Resolve per-entity 1Password token (if present in the daemon env) so the
      // restarted session's `op` points at the entity's own vault.
      // Additive: when absent, the tmux-global platform token is inherited.
      const crash_op_token = this.resolve_entity_op_token(entity_id);
      if (crash_op_token) {
        extra_env.OP_SERVICE_ACCOUNT_TOKEN = crash_op_token;
      }
      console.log(
        `[pool] Restarting pool-${String(bot.id)} entity op token: ${crash_op_token ? "present" : "absent"} (entity: ${entity_id})`,
      );

      // Resolve per-entity CLAUDE_CONFIG_DIR (if configured) so the restarted
      // session uses the entity's own Claude Max subscription.
      const crash_claude_config = this.resolve_claude_config_dir(entity_id);
      if (crash_claude_config) {
        extra_env.CLAUDE_CONFIG_DIR = crash_claude_config;
        console.log(
          `[pool] Restarting pool-${String(bot.id)} with CLAUDE_CONFIG_DIR=${crash_claude_config} (entity: ${entity_id})`,
        );
      }

      // Write access.json so the Discord plugin listens on this channel.
      // Include entity_id so the entity's #alerts channel is added to the
      // outbound allowlist (#40).
      if (channel_id) {
        await this.write_access_json(bot.state_dir, channel_id, entity_id);
      }

      // Restart tmux — use --resume if we have a verified session_id
      await this.start_tmux(
        bot,
        archetype,
        entity_id,
        working_dir,
        resume_id,
        is_resume,
        extra_env,
        channel_id,
      );

      // Update state — bot stays assigned with refreshed timestamps.
      // `is_resume` is only true when we pre-flighted the JSONL on disk, so
      // a resumed session is already confirmed. A fresh session needs the
      // confirmation watcher before persist() will write its session_id.
      bot.session_id = resume_id;
      bot.session_confirmed = is_resume;
      bot.last_active = new Date();
      bot.assigned_at = new Date();

      await this.persist();

      if (!is_resume) {
        this.watch_session_confirmation(bot, working_dir, resume_id);
      }

      restarted = true;
    } catch (err) {
      console.error(`[pool] Failed to restart pool-${String(bot.id)} after crash: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "pool", bot_id: String(bot.id), action: "crash_restart" },
        contexts: { crash: { entity_id, session_id, channel_id } },
      });

      // Restart failed — fall back to the old behavior: stash session history and free the bot.
      // Only stash confirmed sessions (JSONL on disk) so the next channel
      // assignment can't crash-loop on a phantom UUID (issue #256).
      if (session_id && bot.session_confirmed && channel_id && entity_id) {
        const key = `${entity_id}:${channel_id}`;
        this.session_history.set(key, session_id);
        this.session_history_ts.set(key, Date.now());
        console.log(`[pool] Stashed session history for ${key}: ${session_id.slice(0, 8)}`);
      }

      // Post-mortem extraction: the session crashed and the restart failed.
      // Snapshot + fire while we still have entity/archetype/session_id on the
      // bot, before the force-free below nulls them.
      void this.extract_on_session_end(bot);

      bot.state = "free";
      bot.channel_id = null;
      bot.entity_id = null;
      bot.archetype = null;
      bot.channel_type = null;
      bot.session_id = null;
      bot.model = null;
      bot.effort = null;
      bot.last_active = null;
      bot.assigned_at = null;

      await this.persist();

      this.emit("bot:session_ended", {
        bot_id: bot.id,
        channel_id,
        entity_id,
      });
      this.emit("bot:released", { bot_id: bot.id });
    }

    // Everything below runs outside the critical try/catch — a failure here
    // must not undo a successful restart (which would orphan the live tmux session).
    if (restarted) {
      console.log(
        `[pool] Restarted pool-${String(bot.id)} after crash ` +
          `(${is_resume ? `resumed session: ${resume_id.slice(0, 8)}` : "fresh session"})`,
      );

      this.emit("bot:crash_restarted", {
        bot_id: bot.id,
        channel_id,
        entity_id,
        resumed: is_resume,
      });

      // Wrap notify separately — an alert failure should not undo a successful restart
      const label = this.channel_label(entity_id, channel_id);
      try {
        await notify(
          "alerts",
          `\u26a0\ufe0f Pool bot ${String(bot.id)} (${archetype}) crashed and was auto-restarted for ${entity_id}/${label}`,
          entity_config,
        );
      } catch (notify_err) {
        console.warn(
          `[pool] Failed to alert #alerts for pool-${String(bot.id)}: ${String(notify_err)}`,
        );
      }
    }
  }

  /**
   * Handle a crash loop — release the bot and alert.
   * Called when a bot has crashed >3 times in the last hour.
   */
  private async handle_crash_loop(bot: PoolBot): Promise<void> {
    const entity_id = bot.entity_id;
    const channel_id = bot.channel_id;
    const archetype = bot.archetype;

    console.error(`[pool] Crash loop detected for pool-${String(bot.id)} — releasing`);
    this.cancel_session_watcher(bot.id);

    // Look up entity config for alerting
    const entity_config = entity_id ? this.registry?.get(entity_id) : undefined;

    // Stash session history before release so the channel can resume later.
    // A crash-looping session is almost certainly broken — the shared gate only
    // stashes if the session is confirmed AND its JSONL still exists on disk.
    // Planting a phantom UUID here is how the original bug self-perpetuated: the
    // next assignment would pull the dead UUID out of history and re-enter the
    // crash loop (issue #256). Same gate as release_broker_to_dark (#92).
    await this.stash_session_history(
      bot.session_id,
      bot.session_confirmed,
      channel_id,
      entity_id,
      "crash-loop",
    );

    // Release the bot — this kills tmux, frees the bot, clears access.json
    if (channel_id) {
      await this.release(channel_id);
    } else {
      // No channel_id — can't go through release(), force-free inline. The
      // channel_id path above delegates to release(), which already fires
      // extraction; only the inline branch needs its own call (no double-fire).
      console.error(
        `[pool] Crash loop for pool-${String(bot.id)} with no channel_id — force-freeing`,
      );
      void this.extract_on_session_end(bot);
      this.kill_tmux(bot.tmux_session);
      void unlink(pending_file_path(bot.tmux_session)).catch(() => {});
      bot.state = "free";
      bot.channel_id = null;
      bot.entity_id = null;
      bot.archetype = null;
      bot.channel_type = null;
      bot.session_id = null;
      bot.model = null;
      bot.effort = null;
      bot.last_active = null;
      bot.assigned_at = null;
      await this.persist();
      this.emit("bot:released", { bot_id: bot.id });
    }

    // Note: bot:session_ended is intentionally NOT emitted here. The crash loop
    // path releases the bot via this.release() which handles cleanup. The
    // restart-failure path emits both bot:session_ended and bot:released because
    // it handles cleanup inline without going through release().
    this.emit("bot:crash_loop", {
      bot_id: bot.id,
      channel_id,
      entity_id,
      archetype,
    });

    // Alert outside the release/event flow — a notify() failure must not
    // prevent the crash_loop event or skip remaining bots in the health check.
    const label = this.channel_label(entity_id, channel_id);
    try {
      await notify(
        "alerts",
        `\ud83d\udd34 Pool bot ${String(bot.id)} crash loop detected for ${entity_id ?? "unknown"}/${label} — released. Check daemon logs.`,
        entity_config,
      );
    } catch (notify_err) {
      console.warn(
        `[pool] Failed to alert #alerts for pool-${String(bot.id)} crash loop: ${String(notify_err)}`,
      );
    }
  }

  /** Record a crash event for a bot. Prunes entries older than 1 hour to stay bounded. */
  private record_crash(bot_id: number): void {
    const one_hour_ago = Date.now() - 60 * 60 * 1000;
    const timestamps = (this.crash_history.get(bot_id) ?? []).filter((t) => t > one_hour_ago);
    timestamps.push(Date.now());
    this.crash_history.set(bot_id, timestamps);
  }

  /** Check if a bot is in a crash loop (>3 crashes in the last hour). */
  private is_crash_loop(bot_id: number): boolean {
    const timestamps = this.crash_history.get(bot_id);
    if (!timestamps) return false;
    const one_hour_ago = Date.now() - 60 * 60 * 1000;
    const recent = timestamps.filter((t) => t > one_hour_ago);
    return recent.length > 3;
  }

  /** Remove crash history entries older than 1 hour to prevent memory growth. */
  private cleanup_crash_history(): void {
    const one_hour_ago = Date.now() - 60 * 60 * 1000;
    for (const [bot_id, timestamps] of this.crash_history) {
      const recent = timestamps.filter((t) => t > one_hour_ago);
      if (recent.length === 0) {
        this.crash_history.delete(bot_id);
      } else {
        this.crash_history.set(bot_id, recent);
      }
    }
  }

  /** Remove session history entries older than 1 hour to prevent memory growth. */
  private cleanup_session_history(): void {
    const one_hour_ago = Date.now() - 60 * 60 * 1000;
    for (const [key, ts] of this.session_history_ts) {
      if (ts < one_hour_ago) {
        this.session_history.delete(key);
        this.session_history_ts.delete(key);
      }
    }
  }

  // ── Session confirmation (issue #256) ──

  /**
   * Watch for Claude Code to write the JSONL transcript for a freshly-spawned
   * session. Once the file appears, promote `bot.session_confirmed` to true
   * and persist — this is the gate that lets `persist()` write the session_id.
   *
   * Until the watcher fires, a daemon restart will see `session_id: null` in
   * pool-state.json and spawn a fresh session on the next assignment instead
   * of trying to --resume a phantom UUID (issue #256).
   *
   * Uses a simple poll loop with a 60-second cap. If the session never
   * commits (e.g. the bot was parked without ever being talked to), we give
   * up — the UUID just stays unpersisted, which is the correct behavior.
   *
   * Protected so tests can override timing.
   */
  protected watch_session_confirmation(
    bot: PoolBot,
    working_dir: string,
    session_id: string,
  ): void {
    // Replace any prior watcher for this bot — only one live at a time
    this.cancel_session_watcher(bot.id);

    const poll_interval_ms = 500;
    const max_attempts = 120; // 60 seconds total
    const bot_id = bot.id;
    let attempts = 0;

    const tick = async (): Promise<void> => {
      // Bot may have been reassigned / released while we were waiting —
      // verify the session_id still matches before promoting.
      const current = this.bots.find((b) => b.id === bot_id);
      if (!current || current.session_id !== session_id) {
        this.session_watchers.delete(bot_id);
        return;
      }

      const exists = await this.check_session_jsonl_exists(working_dir, session_id);

      // Re-check after await: bot may have been reassigned during the async
      // suspension — cancel_session_watcher only stops future ticks, not an
      // in-flight continuation. (#256)
      const still_current = this.bots.find((b) => b.id === bot_id);
      if (!still_current || still_current.session_id !== session_id) {
        this.session_watchers.delete(bot_id);
        return;
      }

      if (exists) {
        still_current.session_confirmed = true;
        this.session_watchers.delete(bot_id);
        console.log(
          `[pool] pool-${String(bot_id)} session ${session_id.slice(0, 8)} confirmed — JSONL on disk, persisting`,
        );
        await this.persist();
        return;
      }

      attempts++;
      if (attempts >= max_attempts) {
        this.session_watchers.delete(bot_id);
        console.warn(
          `[pool] pool-${String(bot_id)} session ${session_id.slice(0, 8)} unconfirmed ` +
            `after ${String(max_attempts * poll_interval_ms)}ms — leaving unpersisted`,
        );
        return;
      }

      const next = setTimeout(() => {
        void tick();
      }, poll_interval_ms);
      this.session_watchers.set(bot_id, next);
    };

    // First tick runs immediately — in tests the file may already exist.
    const initial = setTimeout(() => {
      void tick();
    }, 0);
    this.session_watchers.set(bot_id, initial);
  }

  /** Cancel any pending session-confirmation watcher for a bot. Safe to call
   * when no watcher exists. */
  private cancel_session_watcher(bot_id: number): void {
    const timer = this.session_watchers.get(bot_id);
    if (timer) {
      clearTimeout(timer);
      this.session_watchers.delete(bot_id);
    }
  }

  /** Stop all pool bot sessions. Used during daemon shutdown. */
  async shutdown(): Promise<void> {
    this.stop_health_monitor();
    this.stop_rate_limit_monitor();

    // Cancel a pending post-restart heal pass — recycling mid-shutdown would
    // fight the drain.
    if (this.post_restart_heal_timer) {
      clearTimeout(this.post_restart_heal_timer);
      this.post_restart_heal_timer = null;
    }
    this.post_restart_probation.clear();

    // Cancel all in-flight session confirmation watchers — we're about to
    // kill tmux anyway, and the timers would otherwise keep the event loop
    // alive past shutdown.
    for (const bot_id of Array.from(this.session_watchers.keys())) {
      this.cancel_session_watcher(bot_id);
    }

    // Snapshot current state before killing tmux — this is what the next
    // daemon startup will load for proactive resume.
    await this.persist();

    for (const bot of this.bots) {
      if (bot.state === "assigned") {
        this.kill_tmux(bot.tmux_session);
      }
    }
    console.log("[pool] All pool sessions stopped");
  }

  // ── Persistence ──

  /**
   * Persist current pool state to disk. Called after every state mutation
   * (assign, release, park) for crash resilience — no shutdown hook dependency.
   * Only persists assigned and parked bots; free bots have no meaningful state.
   */
  private async persist(): Promise<void> {
    const to_save: PersistedPoolBot[] = this.bots
      .filter((b) => b.state !== "free" && b.channel_id && b.entity_id && b.archetype)
      .map((b) => ({
        id: b.id,
        state: b.state as "assigned" | "parked",
        channel_id: b.channel_id!,
        entity_id: b.entity_id!,
        archetype: b.archetype!,
        channel_type: b.channel_type,
        // Only persist session_id once Claude has committed the JSONL to disk
        // (issue #256). Writing an unconfirmed UUID would let a restart during
        // the pre-confirmation window crash-loop on --resume of a session that
        // was never materialized.
        session_id: b.session_confirmed ? b.session_id : null,
        model: b.model,
        effort: b.effort,
        last_active: b.last_active?.toISOString() ?? null,
        assigned_at: b.assigned_at?.toISOString() ?? null,
        last_avatar_archetype: b.last_avatar_archetype,
      }));

    // Convert session_history Map to a plain object for serialization
    const history_obj: Record<string, string> = {};
    for (const [key, value] of this.session_history) {
      history_obj[key] = value;
    }

    // Build avatar state for ALL bots (including free ones) — the bot's
    // Discord profile avatar persists independently of pool assignment
    const avatar_obj: Record<string, PersistedBotAvatarState> = {};
    for (const b of this.bots) {
      if (b.last_avatar_archetype && b.last_avatar_set_at) {
        avatar_obj[String(b.id)] = {
          archetype: b.last_avatar_archetype,
          set_at: b.last_avatar_set_at.toISOString(),
        };
      }
    }

    try {
      await save_pool_state(to_save, this.config, history_obj, avatar_obj);
    } catch (err) {
      // Non-fatal: log and continue. Next mutation will retry the write.
      console.error(`[pool] Failed to persist state: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "pool", action: "persist" },
      });
    }
  }

  /**
   * Validate that a persisted entry still references a valid entity and channel.
   * Returns false for stale entries (entity removed, channel deleted, or null metadata).
   */
  private validate_saved_entry(entry: PersistedPoolBot, registry: EntityRegistry): boolean {
    if (!entry.entity_id || !entry.channel_id) {
      console.log(
        `[pool] Rejecting pool-${String(entry.id)}: null metadata ` +
          `(entity: ${String(entry.entity_id)}, channel: ${String(entry.channel_id)})`,
      );
      return false;
    }

    const entity = registry.get(entry.entity_id);
    if (!entity) {
      console.log(
        `[pool] Rejecting pool-${String(entry.id)}: entity "${entry.entity_id}" not in registry`,
      );
      return false;
    }

    const channel = entity.entity.channels.list.find((ch) => ch.id === entry.channel_id);
    if (!channel) {
      console.log(
        `[pool] Rejecting pool-${String(entry.id)}: channel "${entry.channel_id}" ` +
          `not found in entity "${entry.entity_id}"`,
      );
      return false;
    }

    return true;
  }

  // ── Internal ──

  /**
   * Resolve the alerts channel ID for an entity, if any.
   * Returns null when the registry isn't ready, the entity isn't registered,
   * or the entity has no `type: "alerts"` channel configured.
   *
   * Pool bots are assigned to a single inbound channel (general or work_room),
   * but agents are expected to *post* to their entity's #alerts channel for
   * approvals, blockers, and incident notifications. The Discord plugin only
   * permits outbound `reply` to channels present in `access.json.groups`, so
   * we add the alerts channel as an outbound-only entry (see `write_access_json`).
   */
  private resolve_alerts_channel_id(entity_id: string | null): string | null {
    if (!entity_id || !this.registry) return null;
    const entity_config = this.registry.get(entity_id);
    if (!entity_config) return null;
    const alerts_channel = entity_config.entity.channels.list.find((ch) => ch.type === "alerts");
    return alerts_channel?.id ?? null;
  }

  /**
   * Resolve the work_log channel ID for an entity, if any.
   * Returns null when the registry isn't ready, the entity isn't registered,
   * or the entity has no `type: "work_log"` channel configured.
   *
   * Mirrors `resolve_alerts_channel_id`: pool bots are bound to a single
   * inbound channel, but agents are expected to *post* progress to their
   * entity's #work-log channel (the activity feed mandated by the global
   * CLAUDE.md "Communication" norm). The Discord plugin only permits outbound
   * `reply` to channels present in `access.json.groups`, so we add work_log as
   * an outbound-only entry (see `write_access_json`). Only software-blueprint
   * entities declare a work_log channel — content entities have none, so this
   * returns null for them and the channel is simply omitted.
   */
  private resolve_work_log_channel_id(entity_id: string | null): string | null {
    if (!entity_id || !this.registry) return null;
    const entity_config = this.registry.get(entity_id);
    if (!entity_config) return null;
    const work_log_channel = entity_config.entity.channels.list.find(
      (ch) => ch.type === "work_log",
    );
    return work_log_channel?.id ?? null;
  }

  /**
   * Reconcile a pool bot's `access.json.groups` on assignment so that only the
   * permitted entity channels are present:
   *   1. The bot's **assigned channel** — `requireMention: false` (already
   *      written by `write_access_json`; this method is a no-op for it).
   *   2. The entity's **alerts channel** — `requireMention: true` (already
   *      written by `write_access_json`; this method is a no-op for it).
   *   3. The entity's **work_log channel** — `requireMention: true` (already
   *      written by `write_access_json`; this method is a no-op for it).
   *
   * All other same-entity channels are **removed** from the groups map if
   * they are present (self-healing drift from the previous over-granting bug).
   * Channels belonging to other entities or channels not in the entity config
   * are left untouched.
   *
   * Invariants:
   *   - The assigned channel entry is never touched (it was written by
   *     `write_access_json` with the correct policy).
   *   - The alerts channel entry is never touched (same).
   *   - The work_log channel entry is never touched (same).
   *   - dmPolicy and top-level allowFrom are never modified.
   *   - Only called for pool bots, never for infrastructure bots.
   *
   * Cross-room awareness (e.g., letting the marketer bot read #general) is
   * intentional design and must be expressed explicitly — not implied by the
   * entity config membership.
   */
  async ensure_entity_channels_allowlisted(
    state_dir: string,
    entity_id: string,
    assigned_channel_id?: string,
  ): Promise<void> {
    if (!this.registry) return;
    const entity_config = this.registry.get(entity_id);
    if (!entity_config) return;

    const all_entity_channel_ids = new Set(entity_config.entity.channels.list.map((ch) => ch.id));
    if (all_entity_channel_ids.size === 0) return;

    // The channels that belong in the groups map — anything else from this
    // entity is a foreign channel and must be pruned. work_log is permitted
    // here for the same reason as alerts: write_access_json grants it as an
    // outbound-only entry, so it must survive the self-healing prune (otherwise
    // it would be granted and then immediately stripped on assign). See #56.
    const alerts_channel_id = this.resolve_alerts_channel_id(entity_id);
    const work_log_channel_id = this.resolve_work_log_channel_id(entity_id);
    const permitted = new Set<string>();
    if (assigned_channel_id) permitted.add(assigned_channel_id);
    if (alerts_channel_id) permitted.add(alerts_channel_id);
    if (work_log_channel_id) permitted.add(work_log_channel_id);

    const target = join(state_dir, "access.json");

    // Read current access.json. Tolerate ENOENT (write_access_json always runs
    // before this, so the file should exist — but guard defensively).
    let raw: string;
    try {
      raw = await readFile(target, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    let access_data: Record<string, unknown>;
    try {
      access_data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Corrupt file — write_access_json handles recovery for the canonical
      // assign path; here we bail to avoid overwriting a partially-recovered file.
      console.warn(
        `[pool] ensure_entity_channels_allowlisted: corrupt access.json at ${target} — skipping`,
      );
      return;
    }

    const groups = (access_data.groups ?? {}) as Record<
      string,
      { requireMention: boolean; allowFrom: string[] }
    >;

    // Identify entity channels in the groups map that are NOT the assigned
    // channel or the alerts channel — these are foreign and must be removed.
    const to_remove = Object.keys(groups).filter(
      (id) => all_entity_channel_ids.has(id) && !permitted.has(id),
    );

    if (to_remove.length === 0) return;

    for (const id of to_remove) {
      delete groups[id];
    }
    access_data.groups = groups;

    // Atomic write: tmp + rename. Same pattern as
    // CommanderProcess.ensure_channel_allowlisted so a torn write never
    // leaves the plugin staring at a half-written file.
    const tmp = `${target}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(access_data, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, target);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }

    console.log(
      `[pool] Pruned ${String(to_remove.length)} foreign entity channel(s) from access.json for ${entity_id}: ${to_remove.join(", ")}`,
    );
  }

  /**
   * Write the Discord plugin's access.json for a pool bot.
   *
   * The plugin enforces a two-way allowlist:
   *   - Inbound: messages are delivered only from channels in `groups`, gated
   *     by `requireMention` (when true, only @mentions trigger the agent).
   *   - Outbound: `reply` and other send tools only target channels in `groups`.
   *
   * Pool bots are assigned to ONE inbound channel (general or work_room). They
   * also need OUTBOUND access to their entity's #alerts channel so agents can
   * escalate, and to #work-log so they can post progress. Both are added with
   * `requireMention: true` so the bot doesn't accidentally consume their posts
   * as commands — both are broadcast-only output surfaces, not agent input.
   * See #40 (alerts) and #56 (work_log).
   */
  private async write_access_json(
    state_dir: string,
    channel_id: string | null,
    entity_id: string | null = null,
  ): Promise<void> {
    const groups: Record<string, { requireMention: boolean; allowFrom: string[] }> = {};
    if (channel_id) {
      groups[channel_id] = { requireMention: false, allowFrom: [] };
    }

    // Always include the entity's #alerts channel for outbound posts when we
    // can resolve it. Guarded with `requireMention: true` so the channel is
    // strictly an output destination — incoming traffic without an explicit
    // mention is ignored, preserving the broadcast-only semantics.
    const alerts_channel_id = this.resolve_alerts_channel_id(entity_id);
    if (alerts_channel_id && alerts_channel_id !== channel_id) {
      groups[alerts_channel_id] = { requireMention: true, allowFrom: [] };
    }

    // Same rationale as #alerts: agents post progress to #work-log, so the bot
    // needs OUTBOUND access to it. `requireMention: true` keeps it output-only —
    // the work-log feed is a broadcast surface, never an agent input. Resolves
    // to null (and is skipped) for entities without a work_log channel, e.g.
    // content-blueprint entities. See #56.
    const work_log_channel_id = this.resolve_work_log_channel_id(entity_id);
    if (work_log_channel_id && work_log_channel_id !== channel_id) {
      groups[work_log_channel_id] = { requireMention: true, allowFrom: [] };
    }

    // The owner's Discord user ID controls who can DM pool bots.
    // Falls back to empty allowlist if not configured — the user must set
    // discord.user_id in config.yaml (captured during lf init).
    const owner_id = this.config.discord?.user_id;
    const allow_from = owner_id ? [owner_id] : [];

    const access = {
      dmPolicy: "allowlist",
      allowFrom: allow_from,
      groups,
      pending: {},
      ackReaction: "👀",
      replyToMode: "first",
      textChunkLimit: 2000,
      chunkMode: "newline",
    };

    await writeFile(join(state_dir, "access.json"), JSON.stringify(access, null, 2), "utf-8");
  }

  private async start_tmux(
    bot: PoolBot,
    archetype: ArchetypeRole,
    entity_id: string,
    working_dir: string,
    session_id: string,
    is_resume = false,
    extra_env: Record<string, string> = {},
    channel_id: string | null = null,
  ): Promise<void> {
    const claude_bin = process.env.CLAUDE_BIN ?? "claude";
    const agent_name = resolve_agent_name(archetype, this.config);

    // ── Transport selector (epic #84 / #85) ──
    // Default is the official Discord plugin, byte-identical to today. Only when
    // the broker flag is enabled AND this channel is in the pilot allowlist do
    // we swap in the LF shim. If broker prep fails, we fall back to the plugin
    // (prepare_broker_session returns null) — a broker fault never blocks a
    // session bring-up.
    let broker_session: { mcp_config_path: string; env: Record<string, string> } | null = null;
    if (channel_id && this.uses_broker(channel_id)) {
      // Read global mcpServers from the SAME config dir this session will use,
      // so --strict-mcp-config parity holds even under a per-entity
      // CLAUDE_CONFIG_DIR override.
      const broker_claude_config = this.resolve_claude_config_dir(entity_id);
      broker_session = await this.prepare_broker_session(bot, channel_id, broker_claude_config);
    }
    const use_broker = broker_session !== null;
    // Merge broker env into a local (never reassign the param) so both the tmux
    // command string and the spawn env carry LF_BROKER_* for broker sessions.
    const session_env = broker_session ? { ...extra_env, ...broker_session.env } : extra_env;

    // Resolve model and effort from archetype defaults
    const archetype_defaults = DEFAULT_ARCHETYPES[archetype];
    const model_id = resolve_model_id(archetype_defaults);
    const effort = resolve_effort(archetype_defaults.think);

    // Trusted directory set for `--permission-mode bypassPermissions`. Beyond
    // the entity/working dir we also include:
    //   - ~/.claude  — global skill + agent library. Bots load skills from
    //     here via auto-load, so operator meta-tasks that need to read or
    //     write the skill files themselves (e.g. diffing, porting) don't
    //     trigger an interactive approval modal. See issue #260.
    //   - /tmp       — standard scratch dir. Lets bots stage intermediate
    //     artifacts without polluting the entity worktree's git status.
    //     Security note: /tmp is world-writable. We accept this because pool
    //     bots already run under bypassPermissions for the entity worktree —
    //     the threat model assumes a trusted single-user environment. If
    //     multi-tenant isolation is ever required, replace with a per-entity
    //     temp dir.
    // Both paths are already world-accessible to this user — adding them to
    // the trusted set doesn't widen the blast radius, it just stops the
    // modal stalls. We resolve ~ via homedir() because tmux command-string
    // parsing doesn't expand tildes.
    // Broker sessions register the LF shim via --mcp-config (keyed
    // SHIM_MCP_SERVER_KEY so tool names stay byte-identical) with
    // --strict-mcp-config so no other MCP servers leak in. Plugin sessions use
    // the official channel plugin exactly as before.
    //
    // Registering the shim as a channel source must clear TWO CLI gates
    // (verified against CLI v2.1.220's routing logic; each was found the hard
    // way, in production, as a "Channel notifications skipped: …" zombie):
    //
    //   Gate 1 (#112): the server must be named in the session's channel-entry
    //     list at all, or every `notifications/claude/channel` is skipped with
    //     "not in --channels list for this session".
    //   Gate 2 (#114): a `server:<key>` entry must ALSO carry the CLI's
    //     internal dev marker, or it is skipped with "not on the approved
    //     channels allowlist (use --dangerously-load-development-channels for
    //     local dev)". Only entries passed via
    //     `--dangerously-load-development-channels` get that marker.
    //
    // Both skips are fatal, not transient: the shim acks the notification it
    // successfully wrote (it cannot see the CLI discarded it), the queue entry
    // is deleted, and the cold-started session idles as an unconfirmed zombie.
    //
    // CRITICAL: the server entry must be passed ONLY via
    // `--dangerously-load-development-channels`, NOT via `--channels` as well.
    // The CLI appends dev-flag entries AFTER --channels entries and matches
    // with first-wins find(); a duplicate non-dev `--channels server:<key>`
    // entry would shadow the dev one and re-fail gate 2.
    //
    // The dev flag pops a confirmation dialog at CLI startup; the auto-accept
    // keypress below (see the broker branch of the trust-dialog timer) answers
    // it. The dialog is by design for foreign channel servers — the shim is
    // our own co-shipped code, so accepting is sound.
    const transport_args =
      use_broker && broker_session
        ? [
            "--mcp-config",
            sq(broker_session.mcp_config_path),
            "--strict-mcp-config",
            "--dangerously-load-development-channels",
            `server:${SHIM_MCP_SERVER_KEY}`,
          ]
        : ["--channels", "plugin:discord@claude-plugins-official"];

    const claude_args = [
      sq(claude_bin),
      ...transport_args,
      "--agent",
      sq(agent_name),
      "--model",
      model_id,
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      sq(working_dir),
      "--add-dir",
      sq(entity_dir(this.config.paths, entity_id)),
      "--add-dir",
      sq(join(homedir(), ".claude")),
      "--add-dir",
      sq("/tmp"),
    ];

    if (effort) {
      claude_args.push("--effort", effort);
    }

    if (is_resume) {
      claude_args.push("--resume", sq(session_id));
    } else {
      // Fresh session — pass explicit session ID so pool-state.json can
      // persist it for proactive resume on future daemon restarts.
      claude_args.push("--session-id", sq(session_id));
    }

    // Note: entity context is NOT injected via --append-system-prompt for pool bots.
    // Multi-line context strings break tmux command parsing. Pool bots load context
    // naturally via CLAUDE.md, skills, and entity memory in the working directory.

    const display_name = resolve_agent_display_name(archetype, this.config);
    const git_env = `GIT_AUTHOR_NAME=${sq(display_name)} GIT_COMMITTER_NAME=${sq(display_name)}`;

    // Build extra env var prefix for the tmux command string (e.g., GH_TOKEN=...)
    const extra_env_str = Object.entries(session_env)
      .map(([k, v]) => `${k}=${sq(v)}`)
      .join(" ");

    const claude_cmd = claude_args.join(" ");
    const env_prefix = extra_env_str ? `${extra_env_str} ` : "";

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "tmux",
        [
          "new-session",
          "-d",
          "-s",
          bot.tmux_session,
          "-x",
          "200",
          "-y",
          "50",
          `DISCORD_STATE_DIR=${sq(bot.state_dir)} ${git_env} ${env_prefix}${claude_cmd}`,
        ],
        {
          cwd: working_dir,
          stdio: "ignore",
          env: {
            ...process.env,
            ...session_env,
            DISCORD_STATE_DIR: bot.state_dir,
            GIT_AUTHOR_NAME: display_name,
            GIT_COMMITTER_NAME: display_name,
          },
        },
      );

      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(
            `[pool] tmux new-session failed for pool-${String(bot.id)} (code ${String(code)})`,
          );
          sentry.captureException(
            new Error(
              `tmux new-session failed for pool-${String(bot.id)} with code ${String(code)}`,
            ),
            {
              tags: { module: "pool", bot_id: String(bot.id) },
            },
          );
          reject(new Error(`tmux failed with code ${String(code)}`));
          return;
        }

        if (this.is_tmux_alive(bot.tmux_session)) {
          // Auto-accept workspace trust dialog
          setTimeout(() => {
            try {
              execFileSync("tmux", ["send-keys", "-t", bot.tmux_session, "Enter"], {
                stdio: "ignore",
              });
            } catch {
              /* dialog may not appear */
            }
          }, 3000);

          // Broker sessions launch with --dangerously-load-development-channels
          // (#114), which pops a confirmation dialog at CLI startup with the
          // accept option preselected — Enter confirms. The dialog blocks the
          // whole startup (MCP servers don't spawn until it's answered), so an
          // unanswered dialog is a dark channel. A second keypress covers the
          // case where the first Enter was consumed by the trust dialog; a
          // spare Enter at an idle prompt (or during a running turn) is a
          // no-op. Broker branch only — plugin sessions keep the single
          // trust-dialog press, byte-identical to before.
          if (use_broker) {
            setTimeout(() => {
              try {
                execFileSync("tmux", ["send-keys", "-t", bot.tmux_session, "Enter"], {
                  stdio: "ignore",
                });
              } catch {
                /* dialog may not appear */
              }
            }, 6000);
          }

          console.log(`[pool] pool-${String(bot.id)} running as ${agent_name} in tmux`);
          resolve();
        } else {
          console.error(`[pool] tmux session did not start for pool-${String(bot.id)}`);
          sentry.captureException(
            new Error(`tmux session did not start for pool-${String(bot.id)}`),
            {
              tags: { module: "pool", bot_id: String(bot.id) },
            },
          );
          reject(new Error("tmux session did not start"));
        }
      });
    });
  }

  /** Human-readable label for a channel in #alerts messages: the channel's
   * configured purpose if known, else the raw id, else "unknown". */
  private channel_label(entity_id: string | null, channel_id: string | null): string {
    const entity_config = entity_id ? this.registry?.get(entity_id) : undefined;
    return (
      entity_config?.entity.channels.list.find((ch) => ch.id === channel_id)?.purpose ??
      channel_id ??
      "unknown"
    );
  }

  /** Look up the github_token_ref for an entity from the registry.
   * Returns the 1Password reference string if configured, or null. */
  private resolve_github_token_ref(entity_id: string): string | null {
    if (!this.registry) return null;
    const entity_config = this.registry.get(entity_id);
    if (!entity_config) return null;
    return entity_config.entity.secrets.github_token_ref ?? null;
  }

  /** Resolve the per-entity 1Password service-account token from the daemon env.
   *
   * The daemon runs under `op run` (start-daemon.sh), so its process env already
   * holds every per-entity token as OP_SERVICE_ACCOUNT_TOKEN_{ENTITY}. Mapping
   * rule: uppercase the entity id and replace hyphens with underscores
   * (e.g. `land-acquisition` → `OP_SERVICE_ACCOUNT_TOKEN_LAND_ACQUISITION`).
   *
   * This is a plain synchronous lookup — the value is already a literal in the
   * env, so there is NO `op read` (no reference to resolve, and a subprocess
   * would risk logging the value). Returns the token or null when unset/empty.
   *
   * SECURITY: never log the return value. Callers log only presence/absence. */
  private resolve_entity_op_token(entity_id: string): string | null {
    const env_var = `OP_SERVICE_ACCOUNT_TOKEN_${entity_id.toUpperCase().replaceAll("-", "_")}`;
    const value = process.env[env_var];
    return value ? value : null;
  }

  /** Look up the subscription.claude_config_dir for an entity from the registry.
   * Returns the absolute path if configured, or null. */
  private resolve_claude_config_dir(entity_id: string): string | null {
    if (!this.registry) return null;
    const entity_config = this.registry.get(entity_id);
    if (!entity_config) return null;
    const raw = entity_config.entity.subscription?.claude_config_dir;
    return raw ? expand_home(raw) : null;
  }

  /** Resolve a 1Password secret reference to its plaintext value.
   * Safe to call in the daemon process (runs under `op run` via start-daemon.sh).
   * The resolved value is held in a JS variable, never written to disk or stdout. */
  private async resolve_op_secret(ref: string): Promise<string> {
    const op_bin = resolve_binary("op");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(op_bin, ["read", ref, "--no-newline"], {
      timeout: 10_000,
    });
    return stdout;
  }

  /** Set a pool bot's server nickname via the daemon bot's Discord client.
   * Uses the cached user ID (extracted during initialize) and the nickname
   * handler (provided by the Discord module) — never reads bot tokens at runtime. */
  private async set_bot_nickname(bot: PoolBot, archetype: ArchetypeRole): Promise<void> {
    const display_name = resolve_agent_display_name(archetype, this.config);

    if (!this.nickname_handler) {
      console.log(
        `[pool] No nickname handler registered — skipping nickname set for pool-${String(bot.id)}`,
      );
      return;
    }

    const user_id = this.bot_user_ids.get(bot.id);
    if (!user_id) {
      console.log(`[pool] No cached user ID for pool-${String(bot.id)} — skipping nickname set`);
      return;
    }

    try {
      await this.nickname_handler(user_id, display_name);
      console.log(`[pool] Set pool-${String(bot.id)} nickname to "${display_name}"`);
    } catch (err) {
      console.log(`[pool] Nickname set failed for pool-${String(bot.id)}: ${String(err)}`);
    }
  }

  /** Set a pool bot's Discord profile avatar to match its archetype.
   * Skips if the archetype hasn't changed since the last set, or if the bot
   * is within the rate limit cooldown window. Avatar failures are non-fatal —
   * the bot continues with its previous avatar. */
  private async set_bot_avatar(bot: PoolBot, archetype: ArchetypeRole): Promise<void> {
    if (!this.avatar_handler) {
      console.log(
        `[pool] No avatar handler registered — skipping avatar set for pool-${String(bot.id)}`,
      );
      return;
    }

    // Skip if archetype hasn't changed since last avatar set
    if (bot.last_avatar_archetype === archetype) {
      console.log(`[pool] pool-${String(bot.id)} already has ${archetype} avatar — skipping`);
      return;
    }

    // Rate limit: skip if within cooldown window
    if (bot.last_avatar_set_at) {
      const elapsed = Date.now() - bot.last_avatar_set_at.getTime();
      if (elapsed < AVATAR_COOLDOWN_MS) {
        const remaining_min = Math.ceil((AVATAR_COOLDOWN_MS - elapsed) / 60_000);
        console.log(
          `[pool] pool-${String(bot.id)} avatar rate-limited — ${String(remaining_min)}min remaining. ` +
            `Keeping ${bot.last_avatar_archetype ?? "default"} avatar`,
        );
        return;
      }
    }

    const agent_name = resolve_agent_name(archetype, this.config);

    try {
      await this.avatar_handler(bot.state_dir, agent_name);
      bot.last_avatar_archetype = archetype;
      bot.last_avatar_set_at = new Date();
      console.log(`[pool] Set pool-${String(bot.id)} avatar to ${agent_name}`);
    } catch (err) {
      // Non-fatal: bot continues with its previous avatar
      console.log(`[pool] Avatar set failed for pool-${String(bot.id)}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "pool", bot_id: String(bot.id), action: "set_avatar" },
      });
    }
  }

  /**
   * Inject a message into a bot's Claude Code session via tmux send-keys.
   *
   * If the bot is at the prompt (❯ visible in tmux pane), the message is
   * sent immediately. Otherwise, it's queued and the next health check cycle
   * (~30s) will retry delivery.
   *
   * Used by the PR watch system to notify bots when their PRs reach
   * a terminal state (merged, closed, review feedback).
   */
  async inject_message_to_bot(tmux_session: string, message: string): Promise<boolean> {
    if (!this.is_tmux_alive(tmux_session)) {
      console.log(`[pool] Cannot inject message — tmux session ${tmux_session} is not alive`);
      return false;
    }

    if (this.is_at_prompt(tmux_session)) {
      let confirmed: boolean;
      try {
        confirmed = await this.send_via_tmux(tmux_session, message);
      } catch (err) {
        console.warn(`[pool] Failed to inject message into ${tmux_session}: ${String(err)}`);
        return false;
      }
      if (!confirmed) {
        console.warn(
          `[pool] Injected message into ${tmux_session} but submit not confirmed — message may be dropped`,
        );
        return false;
      }
      console.log(`[pool] Injected message into ${tmux_session}`);
      return true;
    }

    // Bot is busy — queue for retry on next health check
    const queued = this.pending_injections.get(tmux_session) ?? [];
    queued.push(message);
    this.pending_injections.set(tmux_session, queued);
    console.log(
      `[pool] Bot ${tmux_session} busy — queued message for retry (${String(queued.length)} pending)`,
    );
    return false;
  }

  /** Check if a bot's tmux pane shows the Claude prompt indicator (❯).
   *
   * Note: This uses a simpler check than wait_for_bot_ready (which also
   * requires "Listening for channel messages"). The ❯ prompt is sufficient
   * for drain — if the bot is at the prompt, it can read a file regardless
   * of MCP plugin state. wait_for_bot_ready's stricter check is for the
   * initial bridge path where we need the plugin connected for Discord I/O. */
  private is_at_prompt(session_name: string): boolean {
    try {
      const output = execFileSync("tmux", ["capture-pane", "-t", session_name, "-p"], {
        encoding: "utf-8",
        timeout: 2000,
      });
      const lines = output.trim().split("\n");
      const last_line = lines[lines.length - 1] ?? "";
      return last_line.includes("❯");
    } catch {
      return false;
    }
  }

  /** Send a message to a tmux session via send-keys, verifying the submit
   * landed and retrying the Enter if the input box is left unsubmitted (#65).
   * Returns true only when the submit was confirmed; false on exhausted
   * retries or an unreadable pane (message likely dropped). */
  private async send_via_tmux(session_name: string, message: string): Promise<boolean> {
    return send_keys_with_submit_retry(session_name, message);
  }

  /** Drain queued messages for bots that are now at the prompt. Called from health check. */
  private async drain_pending_injections(): Promise<void> {
    for (const [session, messages] of this.pending_injections) {
      if (!this.is_tmux_alive(session)) {
        this.pending_injections.delete(session);
        console.log(
          `[pool] Dropped ${String(messages.length)} queued message(s) for dead session ${session}`,
        );
        continue;
      }
      if (this.is_at_prompt(session)) {
        let confirmed = 0;
        try {
          for (const message of messages) {
            if (await this.send_via_tmux(session, message)) confirmed++;
          }
        } catch (err) {
          console.warn(`[pool] Failed to deliver queued messages to ${session}: ${String(err)}`);
        }
        // Drop the queue regardless — the bounded submit retries are exhausted,
        // and re-queueing a likely-dead session would just loop the same failure.
        // Dead-session recovery is issue #66's job.
        this.pending_injections.delete(session);
        const failed = messages.length - confirmed;
        if (confirmed > 0) {
          console.log(`[pool] Delivered ${String(confirmed)} queued message(s) to ${session}`);
        }
        if (failed > 0) {
          console.warn(
            `[pool] ${String(failed)} queued message(s) to ${session} unconfirmed — may be dropped`,
          );
        }
      }
      // Still busy — keep queued, will retry next cycle
    }
  }

  /**
   * Safety net for legacy .txt pending files (pre-#290 tmux bridge path).
   *
   * Scans assigned bots for orphaned /tmp/lf-pending-{session}.txt files.
   * If the bot is alive and at the prompt, delivers the message via tmux
   * send-keys and removes the file. Kept as belt-and-suspenders even
   * though the canonical injection path is now the SessionStart hook —
   * see issue #290.
   */
  private async drain_pending_files(): Promise<void> {
    for (const bot of this.bots) {
      if (bot.state !== "assigned") continue;

      const pending_path = pending_file_path(bot.tmux_session);
      try {
        await access(pending_path);
      } catch {
        continue; // No pending file — normal case
      }

      // Skip if a bridge or previous drain is already handling this session's
      // pending file — prevents double-delivery during the 5s cleanup window.
      if (this.draining_sessions.has(bot.tmux_session)) continue;

      // File exists — check if the bot is alive and ready
      if (!this.is_tmux_alive(bot.tmux_session)) continue;
      if (!this.is_at_prompt(bot.tmux_session)) continue;

      // Bot is ready with an undelivered pending file — deliver it
      try {
        const prompt = `A user messaged you earlier but the message wasn't delivered. Read ${pending_path} for their message and respond to them.`;
        const confirmed = await this.send_via_tmux(bot.tmux_session, prompt);
        if (confirmed) {
          console.log(`[pool] Drained pending file for ${bot.tmux_session} via health check`);
        } else {
          console.warn(
            `[pool] Drained pending file for ${bot.tmux_session} but submit not confirmed — may be dropped`,
          );
        }
        // Clean up shortly after — Claude has the prompt and will read it within seconds.
        // Keep this well under the 30s health-check interval to prevent self-re-delivery
        // on the next tick.
        const cleanup = this.mark_draining(bot.tmux_session, pending_path);
        setTimeout(cleanup, 5_000);
      } catch (err) {
        console.warn(`[pool] Failed to drain pending file for ${bot.tmux_session}: ${String(err)}`);
      }
    }
  }

  /**
   * Check if a bot's tmux pane cwd still exists on disk.
   * If the directory has been deleted (e.g., worktree removed), send a `cd`
   * to the entity's primary repo root to recover the session.
   *
   * Best-effort — all errors are caught to avoid disrupting the health loop.
   */
  private async check_cwd_health(bot: PoolBot): Promise<void> {
    try {
      const pane_cwd = execFileSync(
        "tmux",
        ["display-message", "-t", bot.tmux_session, "-p", "#{pane_current_path}"],
        { encoding: "utf-8", timeout: 2000 },
      ).trim();

      if (!pane_cwd) return;

      // Check if the directory still exists and is actually a directory
      try {
        const st = await stat(pane_cwd);
        if (st.isDirectory()) return; // Directory exists — all good
        // Path exists but is not a directory — need to recover
      } catch {
        // Directory doesn't exist — need to recover
      }

      // Resolve a safe fallback path from the entity's primary repo
      let safe_path = homedir(); // ultimate fallback
      if (bot.entity_id && this.registry) {
        const entity_config = this.registry.get(bot.entity_id);
        const repo_path = entity_config?.entity.repos[0]?.path;
        if (repo_path) {
          safe_path = expand_home(repo_path);
        }
      }

      execFileSync("tmux", ["send-keys", "-t", bot.tmux_session, `cd ${sq(safe_path)}`, "Enter"], {
        timeout: 2000,
      });

      console.log(
        `[pool] Recovered orphaned cwd for ${bot.tmux_session}: ${pane_cwd} → ${safe_path}`,
      );

      // Alert the entity's #alerts channel
      if (bot.entity_id && this.registry) {
        const entity_config = this.registry.get(bot.entity_id);
        try {
          await notify(
            "alerts",
            `⚠️ Pool bot ${bot.tmux_session} had orphaned cwd (\`${pane_cwd}\`). Auto-recovered to \`${safe_path}\`.`,
            entity_config,
          );
        } catch {
          // Notification failure must not crash the health loop
        }
      }
    } catch {
      // Best-effort — tmux display-message or send-keys failed.
      // The existing liveness check handles truly dead sessions separately.
    }
  }

  private is_tmux_alive(session_name: string): boolean {
    try {
      execFileSync("tmux", ["has-session", "-t", session_name], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private kill_tmux(session_name: string): void {
    try {
      execFileSync("tmux", ["kill-session", "-t", session_name], { stdio: "ignore" });
    } catch {
      /* may not exist */
    }
  }
}
