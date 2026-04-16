import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// ── Locate the hook script ──
// __dirname points at .../packages/daemon/src/__tests__. The hook lives at
// .../config/claude/hooks/session-start-inject.sh — walk up to the repo root.
const this_dir = dirname(fileURLToPath(import.meta.url));

function find_hook_script(): string {
  let dir = this_dir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "config", "claude", "hooks", "session-start-inject.sh");
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* keep walking */
    }
    dir = resolve(dir, "..");
  }
  throw new Error("Could not locate session-start-inject.sh — is the repo checkout complete?");
}

const HOOK_SCRIPT = find_hook_script();

// ── Detect availability ──
// The hook uses jq + bash. Skip if either is unavailable (CI sandboxes,
// minimal containers). Locally these should always be present.
let hook_available = false;
try {
  execFileSync("jq", ["--version"], { stdio: "ignore" });
  execFileSync("bash", ["--version"], { stdio: "ignore" });
  hook_available = existsSync(HOOK_SCRIPT);
} catch {
  hook_available = false;
}

// ── Helpers ──

/** Invoke the hook script with the given env. Returns stdout + exit code. */
function run_hook(env: Record<string, string>): { stdout: string; stderr: string; code: number } {
  const result = spawnSync("bash", [HOOK_SCRIPT], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 5000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? -1,
  };
}

// ── Tests ──

describe.skipIf(!hook_available)("session-start-inject.sh hook", () => {
  let scratch_dir: string;

  beforeEach(() => {
    scratch_dir = mkdtempSync(join(tmpdir(), "lf-hook-test-"));
  });

  it("emits SessionStart hook output when pending file is valid JSON", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-0.json");
    const payload = {
      user: "alice",
      channel_id: "1234567890",
      message_id: "9876543210",
      content: "hello bot",
      ts: "2026-04-16T12:00:00.000Z",
    };
    writeFileSync(pending_path, JSON.stringify(payload));

    const { stdout, code } = run_hook({ LF_PENDING_FILE: pending_path });

    expect(code).toBe(0);
    expect(stdout.trim()).not.toBe("");

    const emitted = JSON.parse(stdout.trim());
    expect(emitted).toHaveProperty("hookSpecificOutput");
    expect(emitted.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(typeof emitted.hookSpecificOutput.additionalContext).toBe("string");

    const ctx = emitted.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("alice");
    expect(ctx).toContain("hello bot");
    expect(ctx).toContain("1234567890"); // channel_id
    expect(ctx).toContain("2026-04-16T12:00:00.000Z"); // ts
  });

  it("handles multiline content correctly (JSON escaping)", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-1.json");
    const payload = {
      user: "bob",
      channel_id: "ch-1",
      message_id: "msg-1",
      content: "line one\nline two\nline three",
      ts: "2026-04-16T12:00:00.000Z",
    };
    writeFileSync(pending_path, JSON.stringify(payload));

    const { stdout, code } = run_hook({ LF_PENDING_FILE: pending_path });

    expect(code).toBe(0);
    const emitted = JSON.parse(stdout.trim());
    const ctx = emitted.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("line one");
    expect(ctx).toContain("line two");
    expect(ctx).toContain("line three");
  });

  it("handles special chars in content without breaking JSON output", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-2.json");
    const payload = {
      user: "eve",
      channel_id: "ch-2",
      message_id: "msg-2",
      content: `quotes "like this" and backslash \\ and backtick \`code\``,
      ts: "2026-04-16T12:00:00.000Z",
    };
    writeFileSync(pending_path, JSON.stringify(payload));

    const { stdout, code } = run_hook({ LF_PENDING_FILE: pending_path });

    expect(code).toBe(0);
    // If JSON escaping is broken, JSON.parse will throw
    const emitted = JSON.parse(stdout.trim());
    const ctx = emitted.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(`quotes "like this"`);
    expect(ctx).toContain("backtick `code`");
  });

  it("unlinks the pending file after successful read", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-3.json");
    writeFileSync(
      pending_path,
      JSON.stringify({
        user: "a",
        channel_id: "c",
        message_id: "m",
        content: "x",
        ts: "2026-04-16T00:00:00Z",
      }),
    );
    expect(existsSync(pending_path)).toBe(true);

    const { code } = run_hook({ LF_PENDING_FILE: pending_path });
    expect(code).toBe(0);

    // File must be gone — otherwise a later --resume would re-inject stale content.
    expect(existsSync(pending_path)).toBe(false);
  });

  it("no-ops silently (exit 0, empty stdout) when LF_PENDING_FILE is unset", () => {
    const { stdout, code } = run_hook({});
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("no-ops silently when LF_PENDING_FILE points at a missing file", () => {
    const missing = join(scratch_dir, "does-not-exist.json");
    const { stdout, code } = run_hook({ LF_PENDING_FILE: missing });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("no-ops and cleans up when the file is empty", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-4.json");
    writeFileSync(pending_path, "");

    const { stdout, code } = run_hook({ LF_PENDING_FILE: pending_path });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(existsSync(pending_path)).toBe(false);
  });

  it("no-ops (but cleans up) when content field is empty", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-5.json");
    writeFileSync(
      pending_path,
      JSON.stringify({
        user: "a",
        channel_id: "c",
        message_id: "m",
        content: "",
        ts: "t",
      }),
    );

    const { stdout, code } = run_hook({ LF_PENDING_FILE: pending_path });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(existsSync(pending_path)).toBe(false);
  });

  it("no-ops gracefully (exit 0) when file contains invalid JSON", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-6.json");
    writeFileSync(pending_path, "not-json-at-all");

    const { code } = run_hook({ LF_PENDING_FILE: pending_path });

    // Must NOT return non-zero — we never want to block Claude session start.
    expect(code).toBe(0);
    // Clean up the malformed file so we don't get stuck in a loop.
    expect(existsSync(pending_path)).toBe(false);
  });

  it("falls back to 'a user' when the user field is missing", () => {
    const pending_path = join(scratch_dir, "lf-pending-pool-7.json");
    writeFileSync(
      pending_path,
      JSON.stringify({
        channel_id: "ch-7",
        message_id: "m-7",
        content: "anonymous message",
        ts: "2026-04-16T00:00:00Z",
      }),
    );

    const { stdout, code } = run_hook({ LF_PENDING_FILE: pending_path });
    expect(code).toBe(0);
    const emitted = JSON.parse(stdout.trim());
    const ctx = emitted.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("a user");
    expect(ctx).toContain("anonymous message");
  });
});
