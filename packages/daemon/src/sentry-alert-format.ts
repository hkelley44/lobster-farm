/**
 * Sentry alert formatting + short-lived issue-details cache (#259).
 *
 * The initial Discord alert posted for a Sentry webhook used to be three
 * lines (`Sentry: {title}`, `Project: {slug}`, `{url}`). This module
 * enriches it with metadata fetched from the Sentry API so the alert
 * stands on its own without waiting for Ray's triage follow-up.
 *
 * Format (full, with all fields):
 *
 *   ⚠️ Sentry [error]: TimeoutError: request timed out
 *   SONAR-BACKEND-A7K · sonar-backend · release a7b3c9d
 *   asyncpg.pool.close  (8 events, first 2m ago)
 *   → apps/backend/src/db/pool.py:142 cleanup()
 *   https://ultim8.sentry.io/issues/7409847425/
 *
 * Rules:
 *   - Line 1 emoji by level: 🔥 fatal, ⚠️ error, ℹ️ warning, none otherwise.
 *   - Line 2: `shortId · project · release {short_sha}` — missing tokens
 *     are dropped; the ` · ` separator is applied over what remains.
 *     Environment is intentionally omitted (prod-only by design).
 *   - Line 3: `culprit  (N events, first Xm/h ago)`. Dropped entirely if
 *     culprit is empty and count/first_seen are unavailable.
 *   - Line 4: top in-app stack frame, if available. Dropped otherwise.
 *   - Line 5: permalink.
 *
 * Fallback: `format_sentry_alert_minimal()` is the pre-#259 format and is
 * used when enrichment fails for any reason — we never drop the alert.
 *
 * Cache: `get_cached_issue_details()` wraps the API fetch in a 30-second
 * in-memory promise cache keyed on Sentry issue id. The webhook handler
 * (for enrichment) and the triage path (for Ray's prompt) both go through
 * this cache, so a single event results in at most one API call — even if
 * the two code paths race.
 */

import {
  type SentryIssueDetails,
  type SentryTopFrame,
  extract_top_frame_from_event,
} from "./sentry-api.js";

// ── Types ──

export type TopStackFrame = SentryTopFrame;

/**
 * Re-export under the original name so tests and callers can import
 * this helper from the alert-format module alongside the formatter.
 */
export const extract_top_app_frame = extract_top_frame_from_event;

export interface FormatSentryAlertInput {
  action: string | undefined;
  short_id: string | null;
  project_slug: string;
  details: SentryIssueDetails;
  top_frame: TopStackFrame | null;
}

export interface FormatSentryAlertMinimalInput {
  action: string | undefined;
  error_title: string;
  project_slug: string;
  issue_url: string;
}

// ── Level → emoji ──

function level_emoji(level: string): string {
  switch (level) {
    case "fatal":
      return "🔥";
    case "error":
      return "⚠️";
    case "warning":
      return "ℹ️";
    default:
      return "";
  }
}

// ── Action → prefix ──

function action_prefix(action: string | undefined): { prefix: string; tag: string } {
  if (action === "resolved") return { prefix: "Resolved", tag: "" };
  if (action === "unresolved") return { prefix: "Sentry", tag: "[unresolved]" };
  if (action === "regression") return { prefix: "Sentry", tag: "[regression]" };
  return { prefix: "Sentry", tag: "" };
}

// ── Relative time formatter ──

/**
 * Format an ISO timestamp as a compact relative time: "30s", "5m", "3h", "2d".
 *
 * `now` is injectable for deterministic tests. Returns "" on invalid input.
 */
export function relative_time(iso: string, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const delta_s = Math.max(0, Math.floor((now - then) / 1000));
  if (delta_s < 60) return `${String(delta_s)}s`;

  const delta_m = Math.floor(delta_s / 60);
  if (delta_m < 60) return `${String(delta_m)}m`;

  const delta_h = Math.floor(delta_m / 60);
  if (delta_h < 24) return `${String(delta_h)}h`;

  const delta_d = Math.floor(delta_h / 24);
  return `${String(delta_d)}d`;
}

// ── Release tag lookup ──

function find_release(tags: SentryIssueDetails["tags"]): string | null {
  const tag = tags.find((t) => t.key === "release");
  if (!tag?.value) return null;
  // Sentry releases are commonly a full 40-char SHA or a semver string.
  // For the alert we want 7 chars of a SHA-like value; longer semver/release
  // names pass through unchanged.
  const value = tag.value;
  if (/^[0-9a-f]{8,}$/i.test(value)) return value.slice(0, 7);
  return value;
}

// ── Main formatter ──

export function format_sentry_alert(input: FormatSentryAlertInput): string {
  const { action, short_id, project_slug, details, top_frame } = input;

  const { prefix, tag } = action_prefix(action);
  const emoji = level_emoji(details.level);
  const level_bracket = `[${details.level}]`;

  // Header: "<emoji> <prefix> [level]: <title>" (action tag replaces level when set)
  const header_tag = tag || level_bracket;
  const emoji_part = emoji ? `${emoji} ` : "";
  const header = `${emoji_part}${prefix} ${header_tag}: ${details.title}`;

  // Meta line: shortId · project · release (omit missing tokens)
  const release = find_release(details.tags);
  const meta_tokens: string[] = [];
  if (short_id) meta_tokens.push(short_id);
  meta_tokens.push(project_slug);
  if (release) meta_tokens.push(`release ${release}`);
  const meta = meta_tokens.join(" · ");

  // Culprit + count line
  const count_num = Number.parseInt(details.count, 10);
  const has_count = Number.isFinite(count_num) && count_num > 0;
  const rel = relative_time(details.first_seen);
  let culprit_line: string | null = null;
  if (details.culprit || has_count) {
    const count_part =
      has_count && rel
        ? `(${String(count_num)} events, first ${rel} ago)`
        : has_count
          ? `(${String(count_num)} events)`
          : "";
    if (details.culprit && count_part) {
      culprit_line = `${details.culprit}  ${count_part}`;
    } else if (details.culprit) {
      culprit_line = details.culprit;
    } else if (count_part) {
      culprit_line = count_part;
    }
  }

  // Stack frame line
  let stack_line: string | null = null;
  if (top_frame) {
    const loc =
      top_frame.lineno != null
        ? `${top_frame.filename}:${String(top_frame.lineno)}`
        : top_frame.filename;
    stack_line = `→ ${loc} ${top_frame.function}()`;
  }

  const lines = [header, meta];
  if (culprit_line) lines.push(culprit_line);
  if (stack_line) lines.push(stack_line);
  lines.push(details.web_url);
  return lines.join("\n");
}

// ── Minimal fallback formatter ──

export function format_sentry_alert_minimal(input: FormatSentryAlertMinimalInput): string {
  const { action, error_title, project_slug, issue_url } = input;
  const prefix = action === "resolved" ? "Resolved" : "Sentry";
  const tag = action && action !== "resolved" && action !== "created" ? ` [${action}]` : "";
  return `${prefix}${tag}: ${error_title}\nProject: ${project_slug}\n${issue_url}`;
}

// ── In-memory cache ──

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  promise: Promise<SentryIssueDetails>;
  expires_at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetch Sentry issue details via `fetcher`, memoizing by issue id for 30s.
 *
 * Concurrent callers for the same id share the same in-flight promise, so
 * the webhook handler and the triage path never double-fetch. A rejected
 * fetch is removed from the cache immediately so the next call can retry.
 *
 * The fetcher is injected (not imported directly) so callers can supply
 * already-authenticated closures: `() => fetch_sentry_issue_details(id, token, org)`.
 */
export function get_cached_issue_details(
  issue_id: string,
  fetcher: () => Promise<SentryIssueDetails>,
): Promise<SentryIssueDetails> {
  const now = Date.now();
  const existing = cache.get(issue_id);
  if (existing && existing.expires_at > now) {
    return existing.promise;
  }

  const promise = fetcher();
  cache.set(issue_id, { promise, expires_at: now + CACHE_TTL_MS });

  // Evict on failure so transient errors do not poison the cache for 30s.
  promise.catch(() => {
    const current = cache.get(issue_id);
    if (current?.promise === promise) {
      cache.delete(issue_id);
    }
  });

  return promise;
}

// ── Incident thread formatting (#310) ──

/**
 * Discord user ID for the entity owner (e.g. Jax). Hardcoded for now.
 *
 * When multi-user support lands, read this from entity config instead. For
 * this issue the only consumer is lobster-farm's own alerts.
 */
const USER_MENTION = "<@732686813856006245>";

/**
 * Mention the user who should act on a Sentry incident. Used in thread
 * updates that require human attention (P0, parse failures, crashes,
 * fix-attempt exhaustion).
 */
export function mention_user(): string {
  return USER_MENTION;
}

/**
 * Truncate an issue title to the 80-char embed title budget, with ellipsis.
 */
export function truncate_title(title: string, max = 80): string {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}

/**
 * Body for the ingress incident_open alert. Deliberately minimal — the
 * thread will carry the actual lifecycle.
 */
export function format_incident_open_body(web_url: string): string {
  return `${web_url}\n\nStatus: received — spawning triage`;
}

/** Body for "triage session started" thread update. */
export function format_triaging_body(): string {
  return "\u{1f50d} Triage session started";
}

/**
 * Body for the verdict thread update. Tags the user when severity is P0.
 */
export function format_verdict_body(verdict: {
  severity: "P0" | "P1" | "P2";
  auto_fixable: boolean;
  github_issue: number | null;
  fix_approach: string | null;
}): string {
  const needs_tag = verdict.severity === "P0";
  const tag = needs_tag ? `${USER_MENTION} ` : "";
  const summary = verdict.fix_approach ?? "(no fix summary)";
  const lines = [`✅ ${tag}Verdict: ${verdict.severity} — ${summary}`];
  if (verdict.github_issue != null) {
    lines.push(`GitHub: #${String(verdict.github_issue)}`);
  } else {
    lines.push("No GitHub issue created");
  }
  const fix_note = verdict.auto_fixable
    ? `Auto-fix: yes — ${verdict.fix_approach ?? "approach TBD"}`
    : "Auto-fix: no";
  lines.push(fix_note);
  return lines.join("\n");
}

/**
 * Body for the "no verdict parsed" thread update. Always tags the user
 * and appends the last 20 lines of Ray's output (code-blocked) so the
 * user can see what went wrong.
 */
export function format_no_verdict_body(output_lines: string[] | undefined): string {
  const tail = (output_lines ?? []).slice(-20).join("\n");
  const tail_block =
    tail.length > 0 ? `\n\n**Last 20 lines of output:**\n\`\`\`\n${tail}\n\`\`\`` : "";
  return `⚠️ ${USER_MENTION} Ray completed but didn't emit a verdict block.${tail_block}`;
}

/** Body for "session crashed" thread update. */
export function format_session_failed_body(error: string): string {
  return `❌ ${USER_MENTION} Triage session crashed: ${error}`;
}

/** Body for "auto-fix session spawned" thread update. */
export function format_fix_spawned_body(): string {
  return "\u{1f6e0}️ Auto-fix session spawned (Bob, Opus)";
}

/** Body for "auto-fix exhausted attempts" thread update. */
export function format_fix_exhausted_body(attempts: number, last_pr_url?: string | null): string {
  const suffix = last_pr_url ? ` Last PR: ${last_pr_url}` : "";
  return `❌ ${USER_MENTION} Auto-fix failed after ${String(attempts)} attempts.${suffix}`;
}

/** Body for "fix PR merged — incident resolved" thread update. */
export function format_fix_merged_body(pr_number: number): string {
  return `Fix PR #${String(pr_number)} merged`;
}

// ── Test helpers ──

/**
 * Reset the in-memory cache between tests. Not for production use.
 */
export function _reset_cache_for_test(): void {
  cache.clear();
}
