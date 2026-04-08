/**
 * Tests for DNA skill loading and injection into session commands.
 *
 * Verifies that:
 * - load_dna_content reads and concatenates skill files from ~/.claude/skills/
 * - Missing skill files return null without throwing
 * - Empty skill arrays return null
 * - build_command injects DNA content via --append-system-prompt
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir to return our temp directory so tests don't touch real ~/.claude/
const mock_homedir = vi.fn();
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mock_homedir(),
  };
});

// Import after vi.mock so the mock is in effect
import { ClaudeSessionManager, load_dna_content } from "../session.js";

function make_config(overrides?: Partial<LobsterFarmConfig>): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    ...overrides,
  });
}

describe("DNA skill loading", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join("/tmp", `lf-dna-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(tmp, { recursive: true });
    mock_homedir.mockReturnValue(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("load_dna_content", () => {
    it("reads and returns content from skill files", async () => {
      const skill_dir = join(tmp, ".claude", "skills", "test-skill");
      await mkdir(skill_dir, { recursive: true });
      await writeFile(join(skill_dir, "SKILL.md"), "# Test DNA\nThis is test content.");

      const result = await load_dna_content(["test-skill"]);

      expect(result).not.toBeNull();
      expect(result).toContain("# Test DNA");
      expect(result).toContain("This is test content.");
    });

    it("returns null for nonexistent skill (does not throw)", async () => {
      const result = await load_dna_content(["nonexistent-skill"]);

      expect(result).toBeNull();
    });

    it("returns null for empty array", async () => {
      const result = await load_dna_content([]);

      expect(result).toBeNull();
    });

    it("concatenates multiple skill files with separator", async () => {
      const skill_a = join(tmp, ".claude", "skills", "skill-a");
      const skill_b = join(tmp, ".claude", "skills", "skill-b");
      await mkdir(skill_a, { recursive: true });
      await mkdir(skill_b, { recursive: true });
      await writeFile(join(skill_a, "SKILL.md"), "Content A");
      await writeFile(join(skill_b, "SKILL.md"), "Content B");

      const result = await load_dna_content(["skill-a", "skill-b"]);

      expect(result).not.toBeNull();
      expect(result).toContain("Content A");
      expect(result).toContain("Content B");
      expect(result).toContain("---"); // separator between sections
    });

    it("skips missing files and returns content from existing ones", async () => {
      const skill_dir = join(tmp, ".claude", "skills", "exists");
      await mkdir(skill_dir, { recursive: true });
      await writeFile(join(skill_dir, "SKILL.md"), "Existing content");

      const result = await load_dna_content(["missing", "exists"]);

      expect(result).not.toBeNull();
      expect(result).toContain("Existing content");
    });
  });

  describe("build_command DNA injection", () => {
    it("includes --append-system-prompt twice when DNA skill file exists", async () => {
      // Set up a mock skill file
      const skill_dir = join(tmp, ".claude", "skills", "coding-dna");
      await mkdir(skill_dir, { recursive: true });
      await writeFile(join(skill_dir, "SKILL.md"), "# Coding DNA\nEngineering standards.");

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const { args } = await mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Build feature #42",
        interactive: false,
      });

      // --append-system-prompt should appear twice: entity context + DNA
      const append_count = args.filter((a) => a === "--append-system-prompt").length;
      expect(append_count).toBe(2);

      // The DNA content should be in the args (after the last --append-system-prompt)
      const last_append_idx = args.lastIndexOf("--append-system-prompt");
      const dna_arg = args[last_append_idx + 1];
      expect(dna_arg).toContain("Coding DNA");
      expect(dna_arg).toContain("Engineering standards.");
    });

    it("includes --append-system-prompt once when DNA skill file is missing", async () => {
      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const { args } = await mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: ["nonexistent-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Build feature #42",
        interactive: false,
      });

      // Only entity context — DNA file doesn't exist
      const append_count = args.filter((a) => a === "--append-system-prompt").length;
      expect(append_count).toBe(1);
    });
  });
});
