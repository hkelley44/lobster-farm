import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { FeatureManager } from "./features.js";
import type { TaskQueue } from "./queue.js";

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

// ── Conversation history ──

interface HistoryEntry {
  role: "user" | "commander";
  content: string;
  timestamp: number;
}

// Per-channel conversation history (last N exchanges)
const channel_history = new Map<string, HistoryEntry[]>();
const MAX_HISTORY = 20;
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

function get_history(channel_id: string): HistoryEntry[] {
  const history = channel_history.get(channel_id) ?? [];
  // Prune old entries
  const cutoff = Date.now() - HISTORY_TTL_MS;
  return history.filter((h) => h.timestamp > cutoff);
}

function add_to_history(channel_id: string, role: "user" | "commander", content: string): void {
  const history = get_history(channel_id);
  history.push({ role, content, timestamp: Date.now() });
  // Keep last N entries
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  channel_history.set(channel_id, history);
}

function format_history(channel_id: string): string {
  const history = get_history(channel_id);
  if (history.length === 0) return "";

  const lines = ["\n## Recent Conversation"];
  for (const entry of history) {
    const role = entry.role === "user" ? "User" : "You (Commander)";
    lines.push(`\n**${role}:**\n${entry.content}`);
  }
  return lines.join("\n");
}

/** Run a Commander session — a real Claude Code session with full tool access. */
export async function run_commander(
  message: string,
  channel_id: string,
  config: LobsterFarmConfig,
  registry: EntityRegistry,
  features: FeatureManager,
  queue: TaskQueue,
): Promise<string> {
  // Record user message in history
  add_to_history(channel_id, "user", message);

  const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";
  const context = build_context(registry, features, queue);
  const conversation_history = format_history(channel_id);
  const working_dir = lobsterfarm_dir(config.paths);

  // Write context + history to temp file
  const context_file = join(tmpdir(), `lf-commander-ctx-${Date.now()}.txt`);
  await writeFile(context_file, context + conversation_history, "utf-8");

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const agent_name = config.agents.commander.name.toLowerCase();
      const proc = spawn(claude_bin, [
        "-p",
        "--agent", agent_name,
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
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Close stdin immediately to prevent "no stdin data" warning
      proc.stdin?.end();

      const stdout_chunks: Buffer[] = [];
      const stderr_chunks: Buffer[] = [];

      proc.stdout?.on("data", (chunk: Buffer) => stdout_chunks.push(chunk));
      proc.stderr?.on("data", (chunk: Buffer) => stderr_chunks.push(chunk));

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error("Commander timed out (5 minutes)"));
      }, 300_000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        const stdout = Buffer.concat(stdout_chunks).toString("utf-8").trim();
        const stderr = Buffer.concat(stderr_chunks).toString("utf-8").trim();

        if (code === 0 && stdout) {
          resolve(stdout);
        } else if (stdout) {
          // Non-zero exit but still got output — use it
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Exited with code ${String(code)}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Save commander response to history
    if (result) {
      add_to_history(channel_id, "commander", result.slice(0, 500));
    }

    return result || "(no response)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Commander error: ${msg.slice(0, 500)}`;
  } finally {
    await unlink(context_file).catch(() => {});
  }
}
