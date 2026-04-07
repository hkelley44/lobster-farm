/**
 * Weekly memory pruning — moves daily log files older than 30 days
 * into an archive/ subdirectory per entity.
 *
 * Pure housekeeping: no AI, no summarization, no token cost.
 */

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { entities_dir } from "@lobster-farm/shared";

/** Number of days after which daily logs are archived. */
const MAX_AGE_DAYS = 30;

/** Date pattern for daily log filenames: YYYY-MM-DD.md */
const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Scan all entities and move daily logs older than 30 days to daily/archive/.
 * Designed to run weekly + once on startup. Idempotent and failure-tolerant.
 */
export async function prune_daily_logs(config: LobsterFarmConfig): Promise<void> {
  const base_dir = entities_dir(config.paths);

  let entity_dirs: string[];
  try {
    const entries = await readdir(base_dir, { withFileTypes: true });
    entity_dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No entities directory — nothing to do
    return;
  }

  const now = new Date();

  for (const entity_id of entity_dirs) {
    const daily_dir = join(base_dir, entity_id, "daily");

    let files: string[];
    try {
      const entries = await readdir(daily_dir);
      files = entries.filter((f) => DATE_PATTERN.test(f));
    } catch {
      // Entity has no daily/ directory — skip gracefully
      continue;
    }

    const to_archive: string[] = [];

    for (const file of files) {
      const match = DATE_PATTERN.exec(file);
      if (!match) continue;

      const file_date = new Date(match[1]!);
      const age_days = (now.getTime() - file_date.getTime()) / (1000 * 60 * 60 * 24);

      if (age_days > MAX_AGE_DAYS) {
        to_archive.push(file);
      }
    }

    if (to_archive.length === 0) continue;

    // Ensure archive/ exists
    const archive_dir = join(daily_dir, "archive");
    await mkdir(archive_dir, { recursive: true });

    for (const file of to_archive) {
      await rename(join(daily_dir, file), join(archive_dir, file));
    }

    console.log(`[memory] Archived ${String(to_archive.length)} daily log(s) for ${entity_id}`);
  }
}
