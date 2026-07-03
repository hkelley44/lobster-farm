/**
 * Stop-hook reply enforcement.
 *
 * On every Claude Code Stop hook fire, the daemon decides whether the agent's
 * last turn was correctly routed to its bound Discord channel:
 *
 *   produced_text  called_reply   action
 *   ─────────────  ────────────   ─────────────────────────────────────────
 *   true           true           pass through (normal)
 *   true           false          mode A: daemon delivers the harvested text
 *                                  itself, then passes through. Falls back to
 *                                  block+reminder only when it can't deliver.
 *   false          true           pass through (mid-turn streaming reply)
 *   false          false          heartbeat: daemon posts Haiku-summary itself
 *
 * Non-Discord-bound sessions (CLI agents, subagents, queue tasks) always pass
 * through. Heartbeats are debounced per-channel to avoid spam; mode-A delivery
 * is deduped per (session, assistant-turn-uuid) — bounded LRU — so a re-fire on
 * the same transcript tail can't double-post, while two distinct turns with
 * identical text still both deliver.
 *
 * See issue #39 for the original spec, #79 for the (a)+(b) hardening, and #81
 * for the review-follow-up (stdin EPIPE guard, bounded guard, uuid re-key).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DiscordBot } from "./discord.js";
import { claude_session_jsonl_path } from "./pool.js";
import type { BotPool } from "./pool.js";
import * as sentry from "./sentry.js";

// ── Tool name constants ──

/**
 * Discord output tool names that count as "the agent routed its message."
 * The MCP plugin namespace can drift over time — keep this list narrow but
 * forgiving (any tool whose name contains both "discord" and "reply"
 * qualifies, see `is_reply_tool_name`).
 */
const DISCORD_REPLY_TOOL_NAMES: readonly string[] = [
  "mcp__plugin_discord_discord__reply",
  "mcp__plugin_discord_discord__edit_message",
];

/** Loose match for any future Discord reply-shaped tool we haven't listed. */
function is_reply_tool_name(name: string): boolean {
  if (DISCORD_REPLY_TOOL_NAMES.includes(name)) return true;
  const lower = name.toLowerCase();
  return lower.includes("discord") && lower.includes("reply");
}

// ── Types ──

export interface TurnSummary {
  /** True if the last assistant turn produced a non-empty text content block. */
  produced_text: boolean;
  /**
   * Concatenated non-empty text blocks of the last assistant turn, joined with
   * `\n\n`. Empty string when the turn produced no user-facing text (tool-only
   * turn, sidechain, or not-found). Used by mode-A to deliver the harvested
   * answer to Discord directly when the agent forgot to call `reply`.
   */
  reply_text: string;
  /** True if the last assistant turn called a Discord reply tool. */
  called_reply: boolean;
  /** True if the last assistant turn was a sidechain (subagent) message. */
  is_sidechain: boolean;
  /**
   * Top-level `uuid` of the assistant JSONL entry this summary was parsed from.
   * Per-turn (per-transcript-entry), not per-content — two distinct turns that
   * harvest identical text still carry different uuids. Empty string when no
   * assistant entry was found or the entry lacked a uuid. Used as the mode-A
   * idempotency key so a genuine new turn is never mistaken for a re-fire.
   */
  uuid: string;
  /**
   * Comma-separated list of tool names invoked in the last assistant turn,
   * used by the heartbeat generator. May be empty when the turn was pure text.
   */
  tool_summary: string;
  /** True if a transcript was found and parsed. False = no JSONL on disk yet. */
  found: boolean;
}

export type StopHookResponse = { ok: true } | { ok: true; block: true; reminder: string };

export interface EvaluateStopDeps {
  pool: BotPool | null;
  discord: DiscordBot | null;
  /** Override clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Override transcript reader for tests. */
  read_turn?: (working_dir: string, session_id: string) => Promise<TurnSummary>;
  /** Override Haiku heartbeat generator for tests. */
  make_heartbeat?: (turn: TurnSummary) => Promise<string>;
}

// ── Cooldown ──

/** Default per-channel heartbeat cooldown (ms). */
export const HEARTBEAT_COOLDOWN_MS = 60_000;

interface CooldownEntry {
  channel_id: string;
  last_at: number;
}

/** Module-level cooldown map. Channels heartbeated within HEARTBEAT_COOLDOWN_MS
 * are skipped on subsequent silent turns. */
const heartbeat_cooldown = new Map<string, CooldownEntry>();

/**
 * Idempotency guard for mode-A daemon-delivered text. Keyed on a hash of
 * `session_id + assistant-turn-uuid` (the top-level `uuid` of the JSONL entry we
 * parsed) so that if enforcement re-runs on the *same* transcript tail (e.g. a
 * liveness restart re-fires the Stop hook), we do not re-post the harvested
 * answer — while two DISTINCT turns that happen to harvest identical text (two
 * separate `"Done."`) both deliver, because they carry different uuids.
 *
 * Keyed on uuid, NOT on content: content-keying silently dropped a legitimately
 * repeated answer (issue #81 item 3). Trimming the text made those collisions
 * more likely, not less.
 *
 * Bounded to `MODE_A_MAX_KEYS` via LRU eviction (insertion-ordered Map: delete +
 * re-insert on access, evict the oldest when over cap). This caps memory on a
 * long-lived daemon — unlike `heartbeat_cooldown`, which is naturally bounded by
 * channel count, this Set/Map would otherwise grow once per mode-A delivery
 * forever (issue #81 item 2).
 */
export const MODE_A_MAX_KEYS = 2_048;

/** Insertion-ordered Map used as an LRU set — the value is a placeholder; only
 * key presence and insertion order matter. Map (not Set) so a future time-window
 * policy could store a timestamp without reshaping the structure. */
const mode_a_delivered = new Map<string, true>();

function mode_a_key(session_id: string, turn_uuid: string): string {
  return createHash("sha256").update(`${session_id}\u0000${turn_uuid}`).digest("hex");
}

/** True if this key was already delivered. LRU touch: move to most-recent. */
function mode_a_seen(key: string): boolean {
  if (!mode_a_delivered.has(key)) return false;
  mode_a_delivered.delete(key);
  mode_a_delivered.set(key, true);
  return true;
}

/** Record a delivered key, evicting the oldest entries past the cap. */
function mode_a_mark(key: string): void {
  mode_a_delivered.delete(key);
  mode_a_delivered.set(key, true);
  while (mode_a_delivered.size > MODE_A_MAX_KEYS) {
    // Map iteration is insertion-ordered — the first key is the oldest.
    const oldest = mode_a_delivered.keys().next().value;
    if (oldest === undefined) break;
    mode_a_delivered.delete(oldest);
  }
}

/** Current size of the mode-A delivery guard. Test-only introspection. */
export function _mode_a_size_for_tests(): number {
  return mode_a_delivered.size;
}

/** Reset cooldowns + mode-A delivery guard. Test-only. */
export function _reset_cooldown_for_tests(): void {
  heartbeat_cooldown.clear();
  mode_a_delivered.clear();
}

function in_cooldown(channel_id: string, now: number): boolean {
  const entry = heartbeat_cooldown.get(channel_id);
  if (!entry) return false;
  return now - entry.last_at < HEARTBEAT_COOLDOWN_MS;
}

function mark_cooldown(channel_id: string, now: number): void {
  heartbeat_cooldown.set(channel_id, { channel_id, last_at: now });
}

// ── Transcript parsing ──

/**
 * Locate and read the last assistant turn from a session's JSONL transcript.
 *
 * Mitigates the transcript-tail flush race: Claude Code writes the JSONL
 * asynchronously, so the Stop hook may fire before the last events have hit
 * disk. We retry with a short backoff up to ~250ms.
 *
 * Returns `found: false` when the transcript does not exist yet (e.g. brand
 * new session) — the caller treats this as "pass through, nothing to enforce".
 */
export async function read_last_assistant_turn(
  working_dir: string,
  session_id: string,
): Promise<TurnSummary> {
  const path = claude_session_jsonl_path(working_dir, session_id);

  // Brief retry loop to mitigate the JSONL flush race: Claude Code writes the
  // transcript asynchronously, so the Stop hook may fire before the last
  // events have hit disk. Retry with backoff, capped at ~250ms total. Settle
  // early once the file size stops growing — single syscall per attempt.
  const delays = [0, 50, 100, 100];
  let last_size = -1;
  let content = "";

  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    let next: string;
    try {
      next = await readFile(path, "utf-8");
    } catch {
      // File not yet on disk; retry within budget.
      continue;
    }
    if (next.length === last_size) {
      break;
    }
    last_size = next.length;
    content = next;
  }

  if (!content) {
    return {
      produced_text: false,
      reply_text: "",
      called_reply: false,
      is_sidechain: false,
      tool_summary: "",
      uuid: "",
      found: false,
    };
  }

  return parse_last_assistant_turn(content);
}

interface JsonlEntry {
  type?: string;
  uuid?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
    }>;
  };
}

/**
 * Pure transcript parser. Walks lines from the tail backward and returns the
 * summary of the most recent `type === "assistant"` entry.
 *
 * Exported for unit tests so we don't have to touch the filesystem.
 */
export function parse_last_assistant_turn(jsonl_content: string): TurnSummary {
  const lines = jsonl_content.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }

    if (entry.type !== "assistant") continue;

    const content = entry.message?.content ?? [];
    let produced_text = false;
    let called_reply = false;
    const tool_names: string[] = [];
    const text_parts: string[] = [];

    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        produced_text = true;
        text_parts.push(block.text);
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        tool_names.push(block.name);
        if (is_reply_tool_name(block.name)) {
          called_reply = true;
        }
      }
    }

    return {
      produced_text,
      reply_text: text_parts.join("\n\n"),
      called_reply,
      is_sidechain: entry.isSidechain === true,
      tool_summary: tool_names.join(", "),
      uuid: typeof entry.uuid === "string" ? entry.uuid : "",
      found: true,
    };
  }

  return {
    produced_text: false,
    reply_text: "",
    called_reply: false,
    is_sidechain: false,
    tool_summary: "",
    uuid: "",
    found: false,
  };
}

// ── Discord-bound check ──

/**
 * Resolve the Discord channel a session is bound to, if any.
 *
 * A session is "Discord-bound" iff there is an *assigned* pool bot whose
 * `session_id` matches and whose `channel_id` is set. Subagents (sidechain
 * sessions) and queue tasks are never directly bound — their session ids
 * never appear in the pool's assignment map.
 */
export function resolve_bound_channel(session_id: string, pool: BotPool | null): string | null {
  if (!pool) return null;
  for (const bot of pool.get_assigned_bots()) {
    if (bot.session_id === session_id && bot.channel_id) {
      return bot.channel_id;
    }
  }
  return null;
}

/** Convenience boolean. */
export function is_discord_bound(session_id: string, pool: BotPool | null): boolean {
  return resolve_bound_channel(session_id, pool) !== null;
}

// ── Heartbeat generation ──

/**
 * Run `claude -p --print` with the prompt fed over **stdin**, returning stdout.
 *
 * Why spawn (not `promisify(execFile)`): `execFile` never closes the child's
 * stdin, so `claude -p` sits waiting on stdin even when the prompt is passed as
 * an arg — it logs `no stdin data received` and routinely blows past the tight
 * heartbeat budget, so the backstop never posts (issue #79).
 *
 * The fix, verified against the pinned `CLAUDE_BIN`: pipe the prompt into stdin
 * and `end()` it immediately. This is the documented `claude -p` invocation and
 * removes the wait entirely. The essential invariant is **stdin is never left
 * open** — we always close it, whether or not we write.
 *
 * Kills the child on timeout and rejects. Rejects on any non-zero exit. Never
 * leaves a dangling process or timer.
 */
export function run_claude_print(
  bin: string,
  args: string[],
  input: string,
  timeout_ms: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${bin} timed out after ${String(timeout_ms)}ms`));
    }, timeout_ms);

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited ${String(code)}: ${stderr.slice(0, 200)}`));
      }
    });

    // Swallow async stdin errors. A broken-pipe (EPIPE) is emitted
    // asynchronously as an `'error'` event on the stdin *stream* when the child
    // dies before draining a payload larger than the pipe buffer. Without this
    // listener Node treats it as an unhandled stream error and crashes the
    // process — violating the module's "NEVER throw / fail-open inside the
    // Stop-hook budget" invariant. The `child.on("error")` and `try/catch`
    // below do NOT catch it (it's neither a spawn error nor synchronous). The
    // `close` handler still settles the promise with the real exit reason.
    child.stdin.on("error", () => {});

    // Feed the prompt over stdin, then close it — this is what unblocks
    // `claude -p`. Guard the synchronous write in case the child died before
    // stdin opened; the async guard above covers the post-write EPIPE case.
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      // The `error`/`close` handlers above will settle the promise.
    }
  });
}

/**
 * Ask Haiku for a one-line "what just happened" summary. Mirrors the shape of
 * `extract_session_learnings` in hooks.ts but bounded tighter — Stop hooks
 * have a 10s budget and Haiku takes 2–5s, so we cap at 6s and bail gracefully.
 *
 * The prompt is fed over stdin (not passed as a positional arg) — see
 * `run_claude_print` for why leaving stdin open breaks the call.
 */
export async function generate_heartbeat(turn: TurnSummary): Promise<string> {
  const tool_list = turn.tool_summary || "(no tools)";
  const prompt = [
    "You are summarizing what an autonomous coding agent just did in one short line.",
    "The agent finished a turn without sending any user-facing text.",
    "",
    `Tools invoked this turn: ${tool_list}`,
    "",
    "Write ONE sentence (max 15 words) describing what's happening, in present continuous tense.",
    'Examples: "Running tests on the new endpoint." / "Refactoring the pool resume logic." /',
    '"Investigating the failing CI check on PR #42."',
    "",
    "Reply with ONLY the sentence, no preamble, no quotes.",
  ].join("\n");

  const claude_bin = process.env.CLAUDE_BIN ?? "claude";
  const stdout = await run_claude_print(
    claude_bin,
    ["-p", "--model", "haiku", "--no-session-persistence", "--print"],
    prompt,
    6_000,
  );
  return stdout.trim();
}

// ── Orchestrator ──

/**
 * Heartbeat prefix — visually distinguishes daemon-authored heartbeats from
 * agent messages. Italic + bracket tag. Helen can refine.
 */
export const HEARTBEAT_PREFIX = "*[heartbeat]* ";

/** Reminder text shown to the agent on the blocked path (failure mode a). */
export const REPLY_REMINDER =
  "You produced assistant text but did not route it to Discord. Call the `reply` tool now with the user-facing portion of your last response. The user only sees what `reply` sends.";

/**
 * Evaluate a Stop hook fire. Returns the response payload the HTTP handler
 * should send back to the hook script.
 *
 * Side effects:
 *   - On heartbeat path: posts a message to the bound Discord channel.
 *   - On any failure: logs + Sentry breadcrumb. NEVER throws — the hook
 *     budget is tight and a thrown error here would fail-closed against
 *     unrelated agent work.
 */
export async function evaluate_stop(
  args: { session_id: string; working_dir: string },
  deps: EvaluateStopDeps,
): Promise<StopHookResponse> {
  const { session_id, working_dir } = args;
  const now_fn = deps.now ?? Date.now;
  const read_turn = deps.read_turn ?? read_last_assistant_turn;
  const make_heartbeat = deps.make_heartbeat ?? generate_heartbeat;

  // Step 1: Discord-bound check is cheap — do it first to short-circuit
  // pass-through cases (subagents, CLI agents, queue tasks).
  const channel_id = resolve_bound_channel(session_id, deps.pool);
  if (!channel_id) {
    return { ok: true };
  }

  // Step 2: parse the last assistant turn from the JSONL tail.
  let turn: TurnSummary;
  try {
    turn = await read_turn(working_dir, session_id);
  } catch (err) {
    // Parsing failed — fail open. Don't block the agent on a transcript bug.
    console.warn(
      `[reply-enforce] transcript read failed for ${session_id.slice(0, 8)}: ${String(err)}`,
    );
    sentry.addBreadcrumb({
      category: "reply-enforce",
      level: "warning",
      message: "transcript read failed",
      data: { session_id: session_id.slice(0, 8), err: String(err) },
    });
    return { ok: true };
  }

  // Belt-and-suspenders: if the transcript flagged this as a sidechain, treat
  // as not bound. (The pool check above should already exclude subagents,
  // since their session ids aren't in the assignment map.)
  if (turn.is_sidechain) {
    return { ok: true };
  }

  if (!turn.found) {
    // No transcript on disk yet (or empty). Pass through — there is nothing
    // to enforce against.
    return { ok: true };
  }

  // Step 3: decide.
  if (turn.produced_text && !turn.called_reply) {
    // Failure mode (a): the agent produced user-facing text but forgot to route
    // it to Discord. Rather than block-and-pray (ask the agent to call `reply`,
    // with nothing guaranteeing it does), the daemon delivers the harvested text
    // itself — delivery becomes guaranteed, not requested. We only fall back to
    // the block+reminder path when the daemon *couldn't* deliver.
    const harvested = turn.reply_text.trim();
    if (deps.discord && harvested) {
      // Key on the assistant turn's JSONL `uuid`, NOT the harvested content. A
      // genuine new turn carries a fresh uuid, so two distinct turns with the
      // SAME text both deliver (content-keying silently dropped the second —
      // issue #81 item 3). A true Stop-hook re-fire re-parses the same tail
      // entry → same uuid → suppressed, preserving the double-post protection.
      //
      // When the entry lacks a uuid (empty string — legacy transcripts or a
      // parse edge), we skip the dedup guard entirely and deliver. Double-post
      // beats never-post: the original guard exists to stop re-posts, not to
      // gate first delivery, and a missing uuid can't safely identify a re-fire.
      const key = turn.uuid ? mode_a_key(session_id, turn.uuid) : null;
      if (key && mode_a_seen(key)) {
        // Enforcement re-ran on the same transcript tail — already delivered.
        // Do NOT re-post; pass through. Low-noise breadcrumb for debuggability
        // (no Discord side effect on this path).
        sentry.addBreadcrumb({
          category: "reply-enforce",
          level: "debug",
          message: "mode-a: re-fire suppressed (already delivered)",
          data: { session_id: session_id.slice(0, 8), len: harvested.length },
        });
        return { ok: true };
      }
      try {
        await deps.discord.send(channel_id, harvested);
        if (key) mode_a_mark(key);
        sentry.addBreadcrumb({
          category: "reply-enforce",
          level: "info",
          message: "mode-a: daemon delivered harvested text",
          data: { session_id: session_id.slice(0, 8), len: harvested.length },
        });
        return { ok: true }; // delivered — do NOT block the agent
      } catch (err) {
        console.warn(
          `[reply-enforce] mode-a harvest send failed for ${session_id.slice(0, 8)}: ${String(err)}`,
        );
        sentry.addBreadcrumb({
          category: "reply-enforce",
          level: "warning",
          message: "mode-a send failed",
          data: { session_id: session_id.slice(0, 8), err: String(err) },
        });
        // Fall through to the reminder as a last resort.
      }
    }
    // Fallback (no discord client, empty text, or send failed): keep the old
    // block+reminder behavior so a produced-but-undelivered answer is never
    // silently dropped.
    return { ok: true, block: true, reminder: REPLY_REMINDER };
  }

  if (!turn.produced_text && !turn.called_reply) {
    // Failure mode (b): heartbeat. Cooldown to prevent spam.
    const now = now_fn();
    if (in_cooldown(channel_id, now)) {
      return { ok: true };
    }

    // Null-discord guard sits BEFORE the Haiku call so we don't burn an API
    // round-trip in the (theoretical) case where a channel is bound but the
    // discord client isn't wired (e.g., daemon during a partial-startup window).
    if (!deps.discord) {
      return { ok: true };
    }

    try {
      const summary = await make_heartbeat(turn);
      const trimmed = summary.trim();
      if (trimmed) {
        await deps.discord.send(channel_id, `${HEARTBEAT_PREFIX}${trimmed}`);
        mark_cooldown(channel_id, now);
      }
    } catch (err) {
      // Haiku timeout / Discord send error — log, don't block.
      console.warn(
        `[reply-enforce] heartbeat skipped for ${session_id.slice(0, 8)}: ${String(err)}`,
      );
      sentry.addBreadcrumb({
        category: "reply-enforce",
        level: "warning",
        message: "heartbeat skipped",
        data: { session_id: session_id.slice(0, 8), err: String(err) },
      });
    }

    return { ok: true };
  }

  // produced_text + called_reply → normal pass-through.
  // !produced_text + called_reply → mid-turn streaming reply, also pass-through.
  return { ok: true };
}
