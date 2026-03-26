import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FeatureState, LobsterFarmConfig, ArchetypeRole, ChannelType } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";

const STATE_DIR = "state";
const FEATURES_FILE = "features.json";
const PR_REVIEWS_FILE = "pr-reviews.json";
const POOL_STATE_FILE = "pool-state.json";

function state_dir(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), STATE_DIR);
}

function features_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), FEATURES_FILE);
}

function pr_reviews_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), PR_REVIEWS_FILE);
}

function pool_state_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), POOL_STATE_FILE);
}

/** Save all features to disk. */
export async function save_features(
  features: FeatureState[],
  config: LobsterFarmConfig,
): Promise<void> {
  const path = features_path(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(features, null, 2), "utf-8");
}

/** Load features from disk. Returns empty array if file doesn't exist. */
export async function load_features(
  config: LobsterFarmConfig,
): Promise<FeatureState[]> {
  const path = features_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);
    if (!Array.isArray(data)) return [];
    return data as FeatureState[];
  } catch {
    return [];
  }
}

// ── PR Review State ──

export interface ProcessedPR {
  entity_id: string;
  pr_number: number;
  reviewed_at: string;       // ISO timestamp
  outcome: "approved" | "changes_requested" | "pending";
}

/** Keyed by "entity_id:pr_number" */
export type PRReviewState = Record<string, ProcessedPR>;

/** Save PR review state to disk. */
export async function save_pr_reviews(
  state: PRReviewState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = pr_reviews_path(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

/** Load PR review state from disk. Returns empty object if file doesn't exist. */
export async function load_pr_reviews(
  config: LobsterFarmConfig,
): Promise<PRReviewState> {
  const path = pr_reviews_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return data as PRReviewState;
  } catch {
    return {};
  }
}

// ── Pool State ──

export interface PersistedPoolBot {
  id: number;
  state: "assigned" | "parked";  // free bots are not persisted
  channel_id: string;
  entity_id: string;
  archetype: ArchetypeRole;
  channel_type: ChannelType | null;
  session_id: string | null;
  last_active: string | null;  // ISO timestamp
}

/** Save pool bot state to disk. Only assigned/parked bots should be included. */
export async function save_pool_state(
  bots: PersistedPoolBot[],
  config: LobsterFarmConfig,
): Promise<void> {
  const path = pool_state_path(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(bots, null, 2), "utf-8");
}

/** Load pool bot state from disk. Returns empty array if file doesn't exist or is malformed. */
export async function load_pool_state(
  config: LobsterFarmConfig,
): Promise<PersistedPoolBot[]> {
  const path = pool_state_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);
    if (!Array.isArray(data)) return [];
    return data as PersistedPoolBot[];
  } catch {
    return [];
  }
}
