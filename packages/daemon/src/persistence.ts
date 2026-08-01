import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArchetypeRole, ChannelType, LobsterFarmConfig } from "@lobster-farm/shared";
import { entity_dir, lobsterfarm_dir } from "@lobster-farm/shared";

const STATE_DIR = "state";
const PR_REVIEWS_FILE = "pr-reviews.json";
const POOL_STATE_FILE = "pool-state.json";
const PR_WATCHES_FILE = "pr-watches.json";
const DEPLOY_TRIAGE_FILE = "deploy-triage.json";

function state_dir(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), STATE_DIR);
}

/**
 * Belt-and-suspenders guard against tests leaking into live state (#102 Gap 3).
 *
 * Under `NODE_ENV === "test"`, refuse to write when the resolved state root is
 * the real `~/.lobsterfarm` — i.e. a test built a config without overriding
 * `paths.lobsterfarm_dir`. Throwing loudly here beats silently corrupting the
 * developer's live daemon state (the `lobster-farm:6010` leak was exactly this:
 * `pr-cron-lease.test.ts` used a fixture PR with no `paths` override, so
 * `save_pr_reviews` wrote straight to `~/.lobsterfarm/state/pr-reviews.json`).
 *
 * No-op outside tests — production always writes to the configured root.
 */
function assert_writable_state_root(path: string, config: LobsterFarmConfig): void {
  if (process.env.NODE_ENV !== "test") return;
  const configured_root = lobsterfarm_dir(config.paths);
  const real_root = lobsterfarm_dir(); // default "~/.lobsterfarm", expanded
  if (configured_root === real_root) {
    throw new Error(
      `[persistence] Refusing to write ${path} under the real state root (${real_root}) during tests. Point config.paths.lobsterfarm_dir at a tmp dir (see #102 Gap 3).`,
    );
  }
}

function pr_reviews_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), PR_REVIEWS_FILE);
}

function pool_state_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), POOL_STATE_FILE);
}

function pr_watches_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), PR_WATCHES_FILE);
}

function deploy_triage_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), DEPLOY_TRIAGE_FILE);
}

// ── PR Review State ──

export interface ProcessedPR {
  entity_id: string;
  pr_number: number;
  reviewed_at: string; // ISO timestamp
  outcome: "approved" | "changes_requested" | "dismissed" | "pending";
  /** JSON-stringified sorted failure names — used to deduplicate CI failure alerts.
   * Only set when a CI failure alert has been sent for this PR. */
  ci_failure_alerted?: string;
  /** Number of CI fix attempts spawned for this PR.
   * Incremented each time a builder is spawned to fix CI failures.
   * Reset when new commits arrive from a non-builder source. (#196) */
  ci_fix_attempts?: number;
  /** Diagnostic-only: where the last review outcome came from (#46).
   * "review" = formal `PullRequestReview` via `reviewDecision`.
   * "comment" = findings-comment fallback in single-dev repos. */
  verdict_source?: "review" | "comment";
  /** Cycle index at which we escalated to #alerts for hitting the review
   * cycle cap (#46). Set so subsequent cron ticks don't re-alert for the
   * same cap-hit state. */
  escalated_at_cycle?: number;

  // ── v2 PR lifecycle (#257) ──
  /** Last head SHA the v2 check-suite-handler dispatched on.
   * Used to deduplicate `check_suite.completed` events that fire multiple
   * times for the same SHA (e.g., one per workflow). */
  v2_last_dispatched_sha?: string;
  /** Number of CI flake-retry rerun attempts for the current SHA.
   * Resets when SHA changes. Cap = 1 per Decision 4 in the spec. */
  v2_flake_retries?: number;
  /** SHA that v2_flake_retries belongs to — reset counter when SHA changes. */
  v2_flake_retry_sha?: string;
  /** The most recent reviewer feedback body (set when the reviewer requested
   * changes). Passed back to the reviewer on the next pass so it can verify
   * the builder addressed the feedback (Decision 5). */
  v2_last_review_feedback?: string;
  /** SHA the previous review was performed against — paired with
   * v2_last_review_feedback so we can show the reviewer "since SHA X". */
  v2_last_review_sha?: string;
}

/** Keyed by "entity_id:pr_number" */
export type PRReviewState = Record<string, ProcessedPR>;

/** Save PR review state to disk. Uses atomic write-to-temp-then-rename. */
export async function save_pr_reviews(
  state: PRReviewState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = pr_reviews_path(config);
  assert_writable_state_root(path, config);
  const tmp_path = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp_path, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp_path, path);
}

/**
 * Validate/repair a raw pr-reviews object (#102 Gap 3). Drops any entry whose:
 *   - key is not `${entity_id}:${pr_number}` shaped, or
 *   - embedded `pr_number` does not equal the key's numeric suffix, or
 *   - embedded `entity_id` does not equal the key's prefix, or
 *   - `entity_id` is not a registered entity (only when `known_entity_ids` is
 *     supplied — the caller must have a registry to enable this check).
 *
 * This makes the store self-healing against leaks like the `lobster-farm:6010`
 * bogus key a test fixture wrote into live state. Returns the cleaned map and
 * the list of dropped keys so the caller can log + rewrite.
 */
export function sanitize_pr_reviews(
  data: Record<string, unknown>,
  known_entity_ids?: ReadonlySet<string>,
): {
  clean: PRReviewState;
  dropped: string[];
} {
  const clean: PRReviewState = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    // Key must be exactly "<entity_id>:<pr_number>" with a numeric suffix.
    const sep = key.lastIndexOf(":");
    const key_entity = sep > 0 ? key.slice(0, sep) : "";
    const key_num_str = sep > 0 ? key.slice(sep + 1) : "";
    const key_num = Number(key_num_str);

    const shape_ok =
      key_entity.length > 0 &&
      key_num_str.length > 0 &&
      Number.isInteger(key_num) &&
      typeof value === "object" &&
      value !== null;

    if (!shape_ok) {
      dropped.push(key);
      continue;
    }

    const entry = value as Partial<ProcessedPR>;
    if (entry.pr_number !== key_num || entry.entity_id !== key_entity) {
      dropped.push(key);
      continue;
    }

    // Unknown-entity check — only when the caller passed a registry snapshot.
    if (known_entity_ids && !known_entity_ids.has(key_entity)) {
      dropped.push(key);
      continue;
    }

    clean[key] = entry as ProcessedPR;
  }

  return { clean, dropped };
}

/**
 * Load PR review state from disk. Returns empty object if file doesn't exist.
 *
 * Sanitizes on load (#102 Gap 3): malformed / mismatched / unknown-entity
 * entries are dropped, each logged by key, and the cleaned file is rewritten so
 * the corruption doesn't linger. This is what heals leaks such as the bogus
 * `lobster-farm:6010` key. Pass `known_entity_ids` (from the registry) to also
 * drop entries for entities that no longer exist.
 */
export async function load_pr_reviews(
  config: LobsterFarmConfig,
  known_entity_ids?: ReadonlySet<string>,
): Promise<PRReviewState> {
  const path = pr_reviews_path(config);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return {};
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};

  const { clean, dropped } = sanitize_pr_reviews(data as Record<string, unknown>, known_entity_ids);
  if (dropped.length > 0) {
    console.warn(
      `[persistence] pr-reviews.json: dropped ${String(dropped.length)} malformed/mismatched ` +
        `entr${dropped.length === 1 ? "y" : "ies"}: ${dropped.join(", ")} — rewriting clean`,
    );
    try {
      await save_pr_reviews(clean, config);
    } catch (err) {
      // A failed rewrite must not break loading — the in-memory state is already
      // clean; we just couldn't persist the repair this cycle.
      console.warn(`[persistence] Failed to rewrite cleaned pr-reviews.json: ${String(err)}`);
    }
  }
  return clean;
}

// ── Pool State ──

export interface PersistedPoolBot {
  id: number;
  state: "assigned" | "parked"; // free bots are not persisted
  channel_id: string;
  entity_id: string;
  archetype: ArchetypeRole;
  channel_type: ChannelType | null;
  session_id: string | null;
  /** Claude CLI model ID (e.g., "claude-opus-4-6"). Added in #101. */
  model?: string | null;
  /** Claude CLI effort level (e.g., "high"). Added in #101. */
  effort?: string | null;
  last_active: string | null; // ISO timestamp
  assigned_at?: string | null; // ISO timestamp — when the bot was assigned to its current channel
  /** The archetype whose avatar is currently set on this bot's Discord profile.
   * Persisted so we don't redundantly set avatars on restart. */
  last_avatar_archetype?: ArchetypeRole | null;
}

/** Per-bot avatar state, persisted for ALL bots (including free ones).
 * A bot's Discord profile avatar persists even when the bot is released from
 * the pool — we need to track it across assignment cycles. */
export interface PersistedBotAvatarState {
  archetype: ArchetypeRole;
  set_at: string; // ISO timestamp
}

/** Persisted pool state: bots + session history for cross-eviction resume. */
export interface PersistedPoolState {
  bots: PersistedPoolBot[];
  /** Maps "{entity_id}:{channel_id}" → session_id. Preserved across evictions
   * so a channel can resume its old session when a bot is reassigned to it. */
  session_history: Record<string, string>;
  /** Per-bot avatar state, keyed by bot ID string. Persisted for ALL bots
   * (including free ones) because the Discord profile avatar persists
   * independently of pool assignment. */
  avatar_state?: Record<string, PersistedBotAvatarState>;
}

/** Save pool state (bots + session history + avatar state) to disk.
 * Uses atomic write-to-temp-then-rename so a crash mid-write never
 * corrupts the real file. rename() is atomic on POSIX same-device. */
export async function save_pool_state(
  bots: PersistedPoolBot[],
  config: LobsterFarmConfig,
  session_history?: Record<string, string>,
  avatar_state?: Record<string, PersistedBotAvatarState>,
): Promise<void> {
  const path = pool_state_path(config);
  assert_writable_state_root(path, config);
  const tmp_path = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  const state: PersistedPoolState = {
    bots,
    session_history: session_history ?? {},
    avatar_state: avatar_state ?? {},
  };
  await writeFile(tmp_path, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp_path, path);
}

/**
 * Load pool state from disk.
 * Backward-compatible: if the file contains a plain array (old format),
 * treats it as bots-only with empty session history.
 */
export async function load_pool_state(config: LobsterFarmConfig): Promise<PersistedPoolState> {
  const path = pool_state_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);

    // Old format: plain array of bots
    if (Array.isArray(data)) {
      console.log(
        `[pool] Loaded pool-state.json (old array format, ${String(data.length)} entries)`,
      );
      return { bots: data as PersistedPoolBot[], session_history: {}, avatar_state: {} };
    }

    // New format: { bots, session_history, avatar_state? }
    if (typeof data === "object" && data !== null && "bots" in data) {
      const obj = data as Record<string, unknown>;
      const bots = Array.isArray(obj.bots) ? (obj.bots as PersistedPoolBot[]) : [];
      const history =
        typeof obj.session_history === "object" &&
        obj.session_history !== null &&
        !Array.isArray(obj.session_history)
          ? (obj.session_history as Record<string, string>)
          : {};
      const avatars =
        typeof obj.avatar_state === "object" &&
        obj.avatar_state !== null &&
        !Array.isArray(obj.avatar_state)
          ? (obj.avatar_state as Record<string, PersistedBotAvatarState>)
          : {};
      console.log(
        `[pool] Loaded pool-state.json (${String(bots.length)} bots, ` +
          `${String(Object.keys(history).length)} history entries, ` +
          `${String(Object.keys(avatars).length)} avatar entries)`,
      );
      return { bots, session_history: history, avatar_state: avatars };
    }

    console.log("[pool] pool-state.json has unexpected format — starting fresh");
    return { bots: [], session_history: {}, avatar_state: {} };
  } catch (err) {
    const msg =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "file not found"
        : String(err);
    console.log(`[pool] Could not load pool-state.json: ${msg} — starting fresh`);
    return { bots: [], session_history: {}, avatar_state: {} };
  }
}

// ── Session Log ──

const SESSION_LOG_FILE = "session-log.jsonl";

export interface SessionLogEntry {
  session_id: string;
  entity_id: string;
  feature_id: string | null;
  archetype: ArchetypeRole;
  phase: string | null;
  source: "queue" | "pool";
  started_at: string; // ISO timestamp
  ended_at: string | null; // ISO timestamp, null if still running
  exit_code: number | null; // null if still running
  duration_ms: number | null; // computed from start/end
  bot_id: number | null; // pool bot ID if pool-sourced
  resume: boolean; // was this a resumed session?
}

function session_log_path(config: LobsterFarmConfig, entity_id: string): string {
  return join(entity_dir(config.paths, entity_id), SESSION_LOG_FILE);
}

/**
 * Append a session log entry to the entity's JSONL log file.
 * Creates the file and parent directories if they don't exist.
 */
export async function append_session_log(
  entity_id: string,
  entry: SessionLogEntry,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = session_log_path(config, entity_id);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

/**
 * Read session log entries for an entity.
 * Skips malformed lines gracefully. Supports optional `since` date filter and `limit`.
 *
 * Note: `since` filters entries before collecting, while `limit` truncates after.
 * When both are provided, `limit` applies to the already-filtered result set.
 * The entire file is read into memory first. For large files, consider implementing
 * JSONL rotation (e.g., daily segments) to bound memory usage.
 */
export async function read_session_log(
  entity_id: string,
  config: LobsterFarmConfig,
  opts?: { since?: Date; limit?: number },
): Promise<SessionLogEntry[]> {
  const path = session_log_path(config, entity_id);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter(Boolean);
  const entries: SessionLogEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionLogEntry;

      if (opts?.since) {
        const entry_time = entry.ended_at ?? entry.started_at;
        if (new Date(entry_time) < opts.since) continue;
      }

      entries.push(entry);
    } catch {
      // Skip malformed lines -- append-only log may have partial writes
    }
  }

  if (opts?.limit && entries.length > opts.limit) {
    return entries.slice(-opts.limit);
  }

  return entries;
}

// ── PR Watches ──

/** A single PR watch: a bot is interested in this PR's terminal state. */
export interface PersistedPRWatch {
  repo: string; // "owner/repo"
  pr_number: number;
  channel_id: string; // Discord channel that registered the watch
  created_at: string; // ISO timestamp
}

/** Keyed by "owner/repo#pr_number" */
export type PRWatchState = Record<string, PersistedPRWatch>;

/** Save PR watches to disk. Uses atomic write-to-temp-then-rename. */
export async function save_pr_watches(
  state: PRWatchState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = pr_watches_path(config);
  assert_writable_state_root(path, config);
  const tmp_path = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp_path, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp_path, path);
}

/** Load PR watches from disk. Returns empty object if file doesn't exist. */
export async function load_pr_watches(config: LobsterFarmConfig): Promise<PRWatchState> {
  const path = pr_watches_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return data as PRWatchState;
  } catch {
    return {};
  }
}

// ── Deploy Triage State (#199) ──

export interface DeployTriageEntry {
  entity_id: string;
  workflow_run_id: number;
  workflow_name: string;
  workflow_url: string;
  head_sha: string; // commit that triggered the deploy
  first_seen_at: string; // ISO timestamp
  fix_attempts: number; // incremented on each Gary spawn
  last_attempt_at: string; // ISO timestamp
  resolved: boolean;
}

/** Keyed by "entity_id:workflow_run_id" */
export type DeployTriageState = Record<string, DeployTriageEntry>;

/** Save deploy triage state to disk. Uses atomic write-to-temp-then-rename. */
export async function save_deploy_triage(
  state: DeployTriageState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = deploy_triage_path(config);
  assert_writable_state_root(path, config);
  const tmp_path = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp_path, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp_path, path);
}

/** Load deploy triage state from disk. Returns empty object if file doesn't exist. */
export async function load_deploy_triage(config: LobsterFarmConfig): Promise<DeployTriageState> {
  const path = deploy_triage_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return data as DeployTriageState;
  } catch {
    return {};
  }
}
