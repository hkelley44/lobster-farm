import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotate_log_if_needed } from "../log-rotation.js";

/**
 * Tests for size-based log rotation (#97). launchd never rotates its
 * StandardOutPath, so the daemon caps it on startup.
 */

let dir: string;
let log_path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lf-log-rotate-"));
  log_path = join(dir, "daemon.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rotate_log_if_needed", () => {
  it("does nothing when the log is absent", () => {
    expect(rotate_log_if_needed(log_path, 10)).toBe(false);
    expect(existsSync(log_path)).toBe(false);
  });

  it("does nothing when the log is under the cap", () => {
    writeFileSync(log_path, "small");
    expect(rotate_log_if_needed(log_path, 1024)).toBe(false);
    expect(existsSync(log_path)).toBe(true);
    expect(existsSync(`${log_path}.1`)).toBe(false);
  });

  it("rotates to .1 when the log meets or exceeds the cap", () => {
    const content = "x".repeat(2048);
    writeFileSync(log_path, content);

    expect(rotate_log_if_needed(log_path, 1024)).toBe(true);

    // Original path is now free for launchd to open fresh on the next spawn.
    expect(existsSync(log_path)).toBe(false);
    // Content is preserved in the single backup.
    expect(readFileSync(`${log_path}.1`, "utf-8")).toBe(content);
  });

  it("replaces a prior .1 rather than accumulating backups (bounded disk)", () => {
    writeFileSync(`${log_path}.1`, "old-backup");
    const content = "y".repeat(2048);
    writeFileSync(log_path, content);

    expect(rotate_log_if_needed(log_path, 1024)).toBe(true);
    expect(readFileSync(`${log_path}.1`, "utf-8")).toBe(content);
  });

  it("rotates exactly at the cap boundary", () => {
    writeFileSync(log_path, "z".repeat(1024));
    expect(statSync(log_path).size).toBe(1024);
    expect(rotate_log_if_needed(log_path, 1024)).toBe(true);
  });
});
