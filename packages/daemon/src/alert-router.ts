/**
 * Tiered alert router for entity #alerts channels (#253).
 *
 * Routes notifications into three tiers:
 *   - Tier 1 (action_required): top-level embeds — needs human attention
 *   - Tier 2 (routine): daily activity thread — informational
 *   - Tier 3 (incident_open / incident_update): per-incident threads
 *
 * Single entry point: `post_alert()`. All call sites that previously used
 * `notify_alerts()` or `send_to_entity("alerts", ...)` go through here.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import { EmbedBuilder } from "discord.js";
import type { DiscordBot } from "./discord.js";
import * as sentry from "./sentry.js";

// ── Types ──

export type AlertTier = "action_required" | "routine" | "incident_open" | "incident_update";

export interface AlertPayload {
  entity_id: string;
  tier: AlertTier;
  title: string;
  body: string;
  /** For incident_update — which thread to post to. */
  incident_id?: string;
  /** Override the default tier color. */
  embed_color?: number;
}

export interface AlertResult {
  message_id: string | null;
  thread_id?: string;
}

// ── Embed colors ──

export const ALERT_COLOR_RED = 0xef4444;
export const ALERT_COLOR_AMBER = 0xf59e0b;
export const ALERT_COLOR_GREEN = 0x10b981;

// ── Daily thread title format ──

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Format the daily thread title: "📋 Activity — Mon DD"
 * `now` is injectable for deterministic tests.
 */
export function daily_thread_title(now: Date = new Date()): string {
  const weekday = WEEKDAYS[now.getDay()]!;
  const month = MONTHS[now.getMonth()]!;
  const day = now.getDate();
  return `\u{1f4cb} Activity \u2014 ${weekday} ${month} ${String(day)}`;
}

/**
 * Date key for daily thread cache: "entity_id:YYYY-MM-DD".
 * `now` is injectable for testing.
 */
function daily_cache_key(entity_id: string, now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${entity_id}:${String(yyyy)}-${mm}-${dd}`;
}

// ── Active incident persistence ──

const ACTIVE_INCIDENTS_FILE = "active-incidents.json";

export interface ActiveIncident {
  entity_id: string;
  thread_id: string;
  message_id: string;
  channel_id: string;
  title: string;
  created_at: string;
}

export type ActiveIncidentsState = Record<string, ActiveIncident>;

function incidents_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), "state", ACTIVE_INCIDENTS_FILE);
}

export async function load_active_incidents(
  config: LobsterFarmConfig,
): Promise<ActiveIncidentsState> {
  const path = incidents_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return data as ActiveIncidentsState;
  } catch {
    return {};
  }
}

export async function save_active_incidents(
  state: ActiveIncidentsState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = incidents_path(config);
  const tmp_path = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp_path, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp_path, path);
}

// ── Alert Router ──

/** Options for testing internals without exposing them on the public API. */
export interface AlertRouterTestOptions {
  daily_threads?: Map<string, string>;
}

export class AlertRouter {
  private discord: DiscordBot | null;
  private config: LobsterFarmConfig;

  /** In-memory cache: daily_cache_key → thread_id */
  private daily_threads: Map<string, string>;

  constructor(
    discord: DiscordBot | null,
    config: LobsterFarmConfig,
    _testing?: AlertRouterTestOptions,
  ) {
    this.discord = discord;
    this.config = config;
    this.daily_threads = _testing?.daily_threads ?? new Map();
  }

  /**
   * Route a notification to the correct tier in the entity's #alerts channel.
   *
   * Returns the message_id and optional thread_id for chaining (e.g., passing
   * an incident thread_id to agent spawn prompts).
   */
  async post_alert(payload: AlertPayload): Promise<AlertResult> {
    const { entity_id, tier } = payload;

    // Always log regardless of Discord connectivity
    console.log(`[alert-router] [${tier}] ${payload.title}: ${payload.body}`);

    if (!this.discord) {
      return { message_id: null };
    }

    const channel_id = this.discord.get_entity_channel_id(entity_id, "alerts");
    if (!channel_id) {
      console.log(`[alert-router] No alerts channel for entity ${entity_id}`);
      return { message_id: null };
    }

    try {
      switch (tier) {
        case "action_required":
          return await this.post_action_required(channel_id, payload);
        case "routine":
          return await this.post_routine(channel_id, entity_id, payload);
        case "incident_open":
          return await this.post_incident_open(channel_id, entity_id, payload);
        case "incident_update":
          return await this.post_incident_update(payload);
        default: {
          // Exhaustive check
          const _never: never = tier;
          console.error(`[alert-router] Unknown tier: ${String(_never)}`);
          return { message_id: null };
        }
      }
    } catch (err) {
      console.error(`[alert-router] Failed to post ${tier} alert: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "alert-router", tier, entity: entity_id },
      });
      return { message_id: null };
    }
  }

  // ── Tier 1: Action Required ──

  private async post_action_required(
    channel_id: string,
    payload: AlertPayload,
  ): Promise<AlertResult> {
    const color = payload.embed_color ?? ALERT_COLOR_RED;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(payload.title)
      .setDescription(payload.body)
      .setTimestamp();

    const message_id = await this.discord!.send_embed(channel_id, embed);
    return { message_id };
  }

  // ── Tier 2: Routine (daily thread) ──

  private async post_routine(
    channel_id: string,
    entity_id: string,
    payload: AlertPayload,
  ): Promise<AlertResult> {
    const thread_id = await this.resolve_daily_thread(channel_id, entity_id);

    if (thread_id) {
      const line = `**${payload.title}** ${payload.body}`;
      await this.discord!.send_to_thread(thread_id, line);
      return { message_id: null, thread_id };
    }

    // Fallback: if thread creation fails, post to channel directly (plain text)
    console.warn("[alert-router] Daily thread unavailable, falling back to channel");
    await this.discord!.send(channel_id, `${payload.title}: ${payload.body}`);
    return { message_id: null };
  }

  /**
   * Find or create today's daily activity thread.
   * Checks in-memory cache first, then scans Discord, then creates.
   */
  private async resolve_daily_thread(
    channel_id: string,
    entity_id: string,
    now: Date = new Date(),
  ): Promise<string | null> {
    const cache_key = daily_cache_key(entity_id, now);

    // Evict stale entries from previous days to prevent unbounded growth.
    // Key format: "entity_id:YYYY-MM-DD" — extract today's date and drop non-matching keys.
    const today_date = cache_key.slice(cache_key.lastIndexOf(":"));
    for (const key of this.daily_threads.keys()) {
      if (!key.endsWith(today_date)) {
        this.daily_threads.delete(key);
      }
    }

    // In-memory cache hit
    const cached = this.daily_threads.get(cache_key);
    if (cached) return cached;

    const title = daily_thread_title(now);

    // Scan Discord for an existing thread with today's name
    const existing_id = await this.discord!.find_thread_by_name(channel_id, title);
    if (existing_id) {
      this.daily_threads.set(cache_key, existing_id);
      return existing_id;
    }

    // Create a new daily thread: post a placeholder message, then thread it
    const placeholder_embed = new EmbedBuilder()
      .setColor(0x6366f1) // indigo — neutral, distinct from alert colors
      .setTitle(title)
      .setDescription("Today's routine activity feed.")
      .setTimestamp(now);

    const msg_id = await this.discord!.send_embed(channel_id, placeholder_embed);
    if (!msg_id) return null;

    const thread_id = await this.discord!.create_thread_from_message(channel_id, msg_id, title);

    if (thread_id) {
      this.daily_threads.set(cache_key, thread_id);
    }

    return thread_id;
  }

  // ── Tier 3: Incident Open ──

  private async post_incident_open(
    channel_id: string,
    entity_id: string,
    payload: AlertPayload,
  ): Promise<AlertResult> {
    const color = payload.embed_color ?? ALERT_COLOR_RED;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(payload.title)
      .setDescription(payload.body)
      .setTimestamp();

    const message_id = await this.discord!.send_embed(channel_id, embed);
    if (!message_id) return { message_id: null };

    // Create incident thread from the embed message
    const thread_title = payload.title.slice(0, 100);
    const thread_id = await this.discord!.create_thread_from_message(
      channel_id,
      message_id,
      thread_title,
    );

    // Persist the incident so we can update it later (and across restarts)
    if (thread_id) {
      const incident: ActiveIncident = {
        entity_id,
        thread_id,
        message_id,
        channel_id,
        title: payload.title,
        created_at: new Date().toISOString(),
      };

      try {
        const state = await load_active_incidents(this.config);
        state[thread_id] = incident;
        await save_active_incidents(state, this.config);
      } catch (err) {
        console.error(`[alert-router] Failed to persist incident: ${String(err)}`);
      }
    }

    return { message_id, thread_id: thread_id ?? undefined };
  }

  // ── Tier 3: Incident Update ──

  private async post_incident_update(payload: AlertPayload): Promise<AlertResult> {
    const { incident_id, body } = payload;

    if (!incident_id) {
      console.warn("[alert-router] incident_update without incident_id — dropping");
      return { message_id: null };
    }

    await this.discord!.send_to_thread(incident_id, body);
    return { message_id: null, thread_id: incident_id };
  }

  /**
   * Mark an incident as resolved: edit the original top-level embed to green
   * with a resolved title and remove from persistent state.
   */
  async resolve_incident(incident_id: string, resolution_body: string): Promise<void> {
    const state = await load_active_incidents(this.config);
    const incident = state[incident_id];

    if (!incident) {
      console.log(`[alert-router] No active incident for thread ${incident_id} — may be stale`);
      return;
    }

    // Edit the original top-level embed to green + resolved title
    if (this.discord) {
      const resolved_embed = new EmbedBuilder()
        .setColor(ALERT_COLOR_GREEN)
        .setTitle(
          `\u2705 Resolved: ${incident.title.replace(/^[\p{Emoji}\p{Emoji_Component}]+\s*/u, "")}`,
        )
        .setDescription(resolution_body)
        .setTimestamp();

      await this.discord.edit_message_embed(
        incident.channel_id,
        incident.message_id,
        resolved_embed,
      );

      // Post resolution to the incident thread
      await this.discord.send_to_thread(incident_id, `\u2705 ${resolution_body}`);
    }

    // Remove from persistent state
    delete state[incident_id];
    await save_active_incidents(state, this.config);
  }
}
