import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
}));

// We'll override the CLAUDE_PROJECTS_DIR by mocking the homedir
const test_home = join(tmpdir(), "session-context-test-");
let tmp_dir: string;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmp_dir,
  };
});

const { read_session_context, find_session_file } = await import("../session-context.js");

describe("session-context", () => {
  beforeEach(async () => {
    tmp_dir = await mkdtemp(test_home);
    // Create the .claude/projects directory structure
    await mkdir(join(tmp_dir, ".claude", "projects", "test-project"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  describe("find_session_file", () => {
    it("finds a session file in a project directory", async () => {
      const session_id = "abc12345-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);
      await writeFile(file_path, "{}");

      const result = await find_session_file(session_id);
      expect(result).toBe(file_path);
    });

    it("returns null when session file does not exist", async () => {
      const result = await find_session_file("nonexistent-session-id");
      expect(result).toBeNull();
    });

    it("searches across multiple project directories", async () => {
      const session_id = "multi-proj-1234-5678-9012-123456789012";
      await mkdir(join(tmp_dir, ".claude", "projects", "other-project"), { recursive: true });
      const file_path = join(
        tmp_dir,
        ".claude",
        "projects",
        "other-project",
        `${session_id}.jsonl`,
      );
      await writeFile(file_path, "{}");

      const result = await find_session_file(session_id);
      expect(result).toBe(file_path);
    });
  });

  describe("read_session_context", () => {
    it("parses assistant messages and returns context usage", async () => {
      const session_id = "ctx-test-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 500,
              cache_read_input_tokens: 200,
              output_tokens: 300,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 5000,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 4000,
              output_tokens: 600,
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      // Last turn: input_tokens=5000 + cache_creation=1000 + cache_read=4000 = 10000
      expect(result!.used_tokens).toBe(10_000);
      expect(result!.total_tokens).toBe(1_000_000);
      expect(result!.percent).toBe(1);
      expect(result!.summary).toBe("10k / 1m (1%)");
      expect(result!.compactions).toBe(0);
    });

    it("returns null when session file is not found", async () => {
      const result = await read_session_context("nonexistent-session");
      expect(result).toBeNull();
    });

    it("returns null when session has no assistant messages", async () => {
      const session_id = "empty-sess-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);
      await writeFile(file_path, JSON.stringify({ type: "human", message: { text: "hello" } }));

      const result = await read_session_context(session_id);
      expect(result).toBeNull();
    });

    it("skips malformed JSONL lines gracefully", async () => {
      const session_id = "malformed-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      const lines = [
        "not valid json",
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 3000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 2000,
              output_tokens: 100,
            },
          },
        }),
        "{also not valid",
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.used_tokens).toBe(5000);
    });

    it("uses the last assistant turn for context fill", async () => {
      const session_id = "last-turn-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      // First turn: small context
      // Second turn: larger context (cumulative)
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 50,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 50000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 100000,
              output_tokens: 200,
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      // Last turn: 50000 + 0 + 100000 = 150000
      expect(result!.used_tokens).toBe(150_000);
      expect(result!.percent).toBe(15);
      expect(result!.summary).toBe("150k / 1m (15%)");
    });

    it("does not carry cache tokens forward from earlier turns", async () => {
      const session_id = "cache-bleed-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      // Turn 1 has cache_creation_input_tokens: 500
      // Turn 2 has input_tokens: 5000 but cache_creation_input_tokens is ABSENT (not 0)
      // Without the fix, last_cache_creation would bleed through from turn 1 → used_tokens = 5500
      // With the fix, all cache fields reset when input_tokens updates → used_tokens = 5000
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 500,
              cache_read_input_tokens: 0,
              output_tokens: 100,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 5000,
              output_tokens: 200,
              // cache_creation_input_tokens intentionally absent
              // cache_read_input_tokens intentionally absent
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.used_tokens).toBe(5000);
    });

    it("detects compaction events", async () => {
      const session_id = "compact-ev-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      // Simulate: context grows, then drops sharply (compaction), grows again,
      // drops sharply again (second compaction).
      const lines = [
        // Turn 1: 100k total
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 80000,
              cache_creation_input_tokens: 10000,
              cache_read_input_tokens: 10000,
              output_tokens: 500,
            },
          },
        }),
        // Turn 2: grows to 200k
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 150000,
              cache_creation_input_tokens: 20000,
              cache_read_input_tokens: 30000,
              output_tokens: 600,
            },
          },
        }),
        // Turn 3: drops to 50k — compaction #1 (50k < 200k * 0.5)
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 40000,
              cache_creation_input_tokens: 5000,
              cache_read_input_tokens: 5000,
              output_tokens: 300,
            },
          },
        }),
        // Turn 4: grows back to 150k
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 100000,
              cache_creation_input_tokens: 20000,
              cache_read_input_tokens: 30000,
              output_tokens: 400,
            },
          },
        }),
        // Turn 5: drops to 30k — compaction #2 (30k < 150k * 0.5)
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 20000,
              cache_creation_input_tokens: 5000,
              cache_read_input_tokens: 5000,
              output_tokens: 200,
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.compactions).toBe(2);
      expect(result!.used_tokens).toBe(30_000);
    });

    it("detects compaction via compact_boundary JSONL entries", async () => {
      const session_id = "boundary-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      // Simulate a session where Claude Code writes a compact_boundary marker
      // between assistant turns. The marker should be counted as a compaction
      // even if no token-drop is visible yet (e.g., checked before the next
      // assistant turn lands).
      const lines = [
        // Turn 1: 100k context
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 80000,
              cache_creation_input_tokens: 10000,
              cache_read_input_tokens: 10000,
              output_tokens: 500,
            },
          },
        }),
        // Compact boundary marker — written by Claude Code on /compact
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          timestamp: "2026-04-14T11:34:09.276Z",
          compactMetadata: {
            trigger: "auto",
            preTokens: 167153,
            postTokens: 8287,
            durationMs: 132766,
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.compactions).toBe(1);
      // used_tokens is still from the last assistant turn (100k)
      expect(result!.used_tokens).toBe(100_000);
    });

    it("counts both compact_boundary markers and token-drop compactions", async () => {
      const session_id = "both-det-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      // Session with one compact_boundary marker AND one token-drop compaction.
      // The compact_boundary is the primary detection; the token-drop is fallback
      // for older transcripts. Both should count independently.
      const lines = [
        // Turn 1: 100k context
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 80000,
              cache_creation_input_tokens: 10000,
              cache_read_input_tokens: 10000,
              output_tokens: 500,
            },
          },
        }),
        // Explicit compact_boundary — compaction #1
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          timestamp: "2026-04-14T11:34:09.276Z",
        }),
        // Turn 2: post-compaction, much smaller — but this is an expected drop
        // after a compact_boundary, so the token-drop heuristic also fires
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 8000,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 1000,
              output_tokens: 200,
            },
          },
        }),
        // Turn 3: grows to 80k
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 60000,
              cache_creation_input_tokens: 10000,
              cache_read_input_tokens: 10000,
              output_tokens: 400,
            },
          },
        }),
        // Turn 4: drops to 15k — token-drop compaction #2 (no boundary marker)
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 10000,
              cache_creation_input_tokens: 2500,
              cache_read_input_tokens: 2500,
              output_tokens: 150,
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      // 1 from compact_boundary + 1 from token-drop after turn 2 + 1 from token-drop after turn 4 = 3
      expect(result!.compactions).toBe(3);
    });

    it("does not count minor token decreases as compactions", async () => {
      const session_id = "no-cmpact-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      // Simulate minor decreases (10-20%) — not compactions
      const lines = [
        // Turn 1: 100k total
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 80000,
              cache_creation_input_tokens: 10000,
              cache_read_input_tokens: 10000,
              output_tokens: 500,
            },
          },
        }),
        // Turn 2: drops to 90k (10% decrease — NOT a compaction)
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 70000,
              cache_creation_input_tokens: 10000,
              cache_read_input_tokens: 10000,
              output_tokens: 400,
            },
          },
        }),
        // Turn 3: drops to 72k (20% decrease — NOT a compaction, still above 50%)
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 52000,
              cache_creation_input_tokens: 10000,
              cache_read_input_tokens: 10000,
              output_tokens: 300,
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.compactions).toBe(0);
    });

    it("formats sub-thousand token counts correctly", async () => {
      const session_id = "small-tok-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 500,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 50,
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("500 / 1m (0.1%)");
    });
  });
});
