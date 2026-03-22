import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { promisify } from "node:util";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { FeatureManager } from "./features.js";
import type { TaskQueue } from "./queue.js";

const exec = promisify(execFile);

function build_context(
  registry: EntityRegistry,
  features: FeatureManager,
  queue: TaskQueue,
): string {
  const entities = registry.get_all();
  const all_features = features.list_features();
  const stats = queue.get_stats();

  const lines: string[] = [
    "## Current LobsterFarm State",
    "",
    `Entities: ${String(entities.length)}`,
  ];

  for (const e of entities) {
    lines.push(`  - ${e.entity.id}: ${e.entity.name} (${e.entity.status})`);
  }

  lines.push(`\nFeatures: ${String(all_features.length)}`);
  for (const f of all_features) {
    lines.push(`  - ${f.id}: ${f.title} [${f.phase}]${f.blocked ? " BLOCKED" : ""}`);
  }

  lines.push(`\nQueue: ${String(stats.active)} active, ${String(stats.pending)} pending`);
  lines.push(`\nDaemon API: http://localhost:7749`);
  lines.push(`Config dir: ${lobsterfarm_dir()}`);

  return lines.join("\n");
}

/** Run a Commander session — a real Claude Code session with full tool access. */
export async function run_commander(
  message: string,
  config: LobsterFarmConfig,
  registry: EntityRegistry,
  features: FeatureManager,
  queue: TaskQueue,
): Promise<string> {
  const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";
  const context = build_context(registry, features, queue);
  const working_dir = lobsterfarm_dir(config.paths);

  // Write context to temp file for --append-system-prompt-file
  const context_file = join(tmpdir(), `lf-commander-ctx-${Date.now()}.txt`);
  await writeFile(context_file, context, "utf-8");

  try {
    const { stdout } = await exec(claude_bin, [
      "-p",
      "--agent", "commander",
      "--model", "claude-opus-4-6",
      "--permission-mode", "bypassPermissions",
      "--append-system-prompt-file", context_file,
      "--add-dir", working_dir,
      "--add-dir", homedir(),
      "--no-session-persistence",
      "--print",
      message,
    ], {
      cwd: working_dir,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    return stdout.trim() || "(no response)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Extract just the useful part of the error
    if (msg.includes("stdout:")) {
      const stdout_match = msg.match(/stdout:\s*([\s\S]*?)(?:\nstderr:|$)/);
      if (stdout_match?.[1]?.trim()) return stdout_match[1].trim();
    }
    return `Commander error: ${msg.slice(0, 500)}`;
  } finally {
    await unlink(context_file).catch(() => {});
  }
}
