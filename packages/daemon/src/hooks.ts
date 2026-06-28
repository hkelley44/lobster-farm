import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { entity_daily_dir, lobsterfarm_dir } from "@lobster-farm/shared";
import { find_session_file } from "./session-context.js";

const exec = promisify(execFile);

// ── Session transcript reading ──

/** Null-sentinel used by the pool when a bot transitions out of `assigned`
 * before its JSONL was confirmed on disk. There is no transcript to read for
 * these, so `extract_session_learnings` skips the read and emits a marker. */
export const NO_SESSION = "no-session";

/** Cap the number of recent assistant turns we feed Haiku. The transcript is
 * read tail-first, so this keeps the most recent (most relevant) work while
 * bounding prompt size. Generous enough to capture a full session's arc. */
const MAX_ASSISTANT_TURNS = 40;

/** Hard char cap on the transcript slice handed to Haiku, applied after the
 * turn cap. Belt-and-suspenders so a handful of very long turns can't blow
 * past Haiku's context. ~12k chars ≈ a few thousand tokens. */
const MAX_TRANSCRIPT_CHARS = 12_000;

/**
 * Read the last N assistant text turns from a session's JSONL transcript.
 *
 * We pull only the `text` blocks from assistant messages — that's the agent's
 * user-facing reasoning and conclusions, the actual signal. Tool-call noise,
 * thinking blocks, and raw tool output are deliberately skipped so Haiku
 * summarizes what the agent *concluded*, not the mechanics of how it got there.
 *
 * Bounded two ways: the last `MAX_ASSISTANT_TURNS` turns, then a trailing
 * `MAX_TRANSCRIPT_CHARS` slice. Tail-first so the most recent work wins when
 * we have to truncate.
 *
 * Best-effort: returns "" on any failure (file missing, parse error). The
 * caller falls back to its marker-entry behavior when this is empty.
 */
async function read_session_transcript(session_id: string): Promise<string> {
  // The null-sentinel means the JSONL was never confirmed on disk — nothing
  // to read. Skip straight to the caller's marker fallback.
  if (session_id === NO_SESSION) return "";

  try {
    const file_path = await find_session_file(session_id);
    if (!file_path) return "";

    const content = await readFile(file_path, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // Collect assistant text turns in order, then keep only the tail.
    const turns: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== "assistant") continue;
        const message = entry.message as Record<string, unknown> | undefined;
        const blocks = message?.content;
        if (!Array.isArray(blocks)) continue;
        const text = blocks
          .filter(
            (b): b is { type: "text"; text: string } =>
              typeof b === "object" &&
              b !== null &&
              (b as { type?: unknown }).type === "text" &&
              typeof (b as { text?: unknown }).text === "string",
          )
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join("\n");
        if (text) turns.push(text);
      } catch {
        // skip malformed lines
      }
    }

    if (turns.length === 0) return "";

    const recent = turns.slice(-MAX_ASSISTANT_TURNS).join("\n\n");
    // Char cap applied tail-first so the latest content survives truncation.
    return recent.length > MAX_TRANSCRIPT_CHARS ? recent.slice(-MAX_TRANSCRIPT_CHARS) : recent;
  } catch {
    // Transcript read is best-effort — a missing or unreadable file just
    // means Haiku gets the marker fallback instead of real content.
    return "";
  }
}

// ── Daily log management ──

function today_str(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Append a session summary to today's daily log. */
export async function append_to_daily_log(
  entity_id: string,
  content: string,
  config: LobsterFarmConfig,
): Promise<string> {
  const daily_dir = entity_daily_dir(config.paths, entity_id);
  await mkdir(daily_dir, { recursive: true });

  const log_path = join(daily_dir, `${today_str()}.md`);

  // Create file with header if it doesn't exist
  try {
    await readFile(log_path, "utf-8");
  } catch {
    await writeFile(log_path, `# Daily Log — ${today_str()}\n\n`, "utf-8");
  }

  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  await appendFile(log_path, `\n## ${timestamp}\n\n${content}\n`, "utf-8");

  return log_path;
}

// ── Stop hook: session memory extraction ──

/**
 * Extract learnings from a completed session using Haiku.
 * Writes a summary to the daily log.
 *
 * This runs after a session completes. It asks Haiku to summarize
 * what was accomplished and what's worth remembering.
 */
export async function extract_session_learnings(
  entity_id: string,
  feature_id: string,
  archetype: string,
  session_id: string,
  config: LobsterFarmConfig,
): Promise<void> {
  // Pull the real session content so Haiku summarizes what actually happened
  // rather than hallucinating from metadata alone. Empty when there's no
  // confirmed transcript (the `no-session` sentinel, or a file we can't read).
  const transcript = await read_session_transcript(session_id);

  // No transcript → no signal to summarize. Skip the Haiku round-trip and
  // write a marker entry directly, rather than asking Haiku to invent a
  // summary from metadata (which produces generic filler / hallucination).
  if (!transcript) {
    const entry = `**Session ended: ${archetype} on ${feature_id}** (${session_id.slice(0, 8)}) — no transcript to summarize`;
    await append_to_daily_log(entity_id, entry, config);
    console.log(`[hooks] Session-end marker written for ${feature_id} (no transcript)`);
    return;
  }

  const prompt = [
    "You are a memory extraction assistant. A Claude Code session just completed.",
    "",
    `Entity: ${entity_id}`,
    `Feature: ${feature_id}`,
    `Archetype: ${archetype}`,
    `Session: ${session_id}`,
    "",
    "Below is the transcript of the session (the agent's own messages, most",
    "recent last). Summarize ONLY what these messages show — do not invent",
    "details that aren't present.",
    "",
    "--- SESSION TRANSCRIPT ---",
    transcript,
    "--- END TRANSCRIPT ---",
    "",
    "Write a brief summary for the daily log. Include:",
    "- What was worked on",
    "- Key decisions made",
    "- Any gotchas or issues encountered",
    "- Items that might be worth promoting to MEMORY.md",
    "",
    "Keep it concise — 3-8 bullet points. Write in markdown.",
  ].join("\n");

  try {
    const claude_bin = process.env.CLAUDE_BIN ?? "claude";
    const { stdout } = await exec(
      claude_bin,
      ["-p", "--model", "haiku", "--no-session-persistence", "--print", prompt],
      { timeout: 30_000 },
    );

    const summary = stdout.trim();
    if (summary) {
      const entry = [
        `**Session: ${archetype} on ${feature_id}** (${session_id.slice(0, 8)})`,
        "",
        summary,
      ].join("\n");

      await append_to_daily_log(entity_id, entry, config);
      console.log(`[hooks] Extracted session learnings for ${feature_id}`);
    }
  } catch (err) {
    // Haiku extraction is best-effort — don't fail the flow
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[hooks] Memory extraction skipped: ${msg}`);

    // Still write a basic marker to the daily log
    const entry = `**Session ended: ${archetype} on ${feature_id}** (${session_id.slice(0, 8)}) — extraction skipped`;
    await append_to_daily_log(entity_id, entry, config);
  }
}

// ── Global learnings ──

const GLOBAL_LEARNINGS_FILE = "global-learnings.md";

/** Get the path to the global learnings file. */
export function global_learnings_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), GLOBAL_LEARNINGS_FILE);
}

/** Append a learning to the global learnings file. */
export async function append_global_learning(
  content: string,
  source_entity: string,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = global_learnings_path(config);
  await mkdir(dirname(path), { recursive: true });

  // Create file with header if it doesn't exist
  try {
    await readFile(path, "utf-8");
  } catch {
    await writeFile(
      path,
      [
        "# Global Learnings",
        "",
        "_Cross-entity knowledge staging area. Reviewed by Commander and routed to DNA evolution or specific entities._",
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  const timestamp = new Date().toISOString().split("T")[0];
  await appendFile(path, `\n### ${timestamp} (from ${source_entity})\n\n${content}\n`, "utf-8");

  console.log(`[hooks] Global learning recorded from ${source_entity}`);
}
