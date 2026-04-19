import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TMUX_DEPROPAGATE_VARS,
  TMUX_PROPAGATED_VARS,
  check_required_binaries,
  propagate_tmux_env,
  resolve_binary,
} from "../env.js";

// Default no-op remover used by tests that only care about the propagate
// side. Reports success so the depropagate step is a silent passthrough.
const noop_remover = () => true;

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Remove any keys added during the test
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  // Restore any keys mutated or deleted during the test
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe("check_required_binaries", () => {
  let original_exit: typeof process.exit;
  let exit_code: number | undefined;

  beforeEach(() => {
    exit_code = undefined;
    original_exit = process.exit;

    // Mock process.exit to capture exit code without actually exiting
    process.exit = vi.fn((code?: number) => {
      exit_code = code ?? 0;
      throw new Error(`process.exit(${String(code)})`);
    }) as never;
  });

  afterEach(() => {
    process.exit = original_exit;
    vi.restoreAllMocks();
  });

  it("exits with code 1 when a required binary is missing", () => {
    // Checker that says "bun" is missing
    const checker = (name: string) => name !== "bun";

    expect(() => check_required_binaries(checker)).toThrow("process.exit(1)");
    expect(exit_code).toBe(1);
  });

  it("succeeds when all required binaries are found", () => {
    // All binaries found
    const checker = () => true;

    expect(() => check_required_binaries(checker)).not.toThrow();
    expect(exit_code).toBeUndefined();
  });

  it("warns but does not exit when only recommended binaries are missing", () => {
    const warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // `op` is recommended, not required — fail only op
    const checker = (name: string) => name !== "op";

    expect(() => check_required_binaries(checker)).not.toThrow();
    expect(exit_code).toBeUndefined();
    expect(warn_spy).toHaveBeenCalledWith(expect.stringContaining("op"));

    warn_spy.mockRestore();
  });

  it("logs the current PATH on failure for debugging", () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PATH = "/test/path:/usr/bin";

    // Fail "claude"
    const checker = (name: string) => name !== "claude";

    try {
      check_required_binaries(checker);
    } catch {
      // Expected — process.exit throws
    }

    expect(error_spy).toHaveBeenCalledWith(expect.stringContaining("/test/path:/usr/bin"));

    error_spy.mockRestore();
  });

  it("lists all missing required binaries in the error message", () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Both bun and claude missing
    const checker = (name: string) => name !== "bun" && name !== "claude";

    try {
      check_required_binaries(checker);
    } catch {
      // Expected
    }

    expect(error_spy).toHaveBeenCalledWith(expect.stringContaining("claude, bun"));

    error_spy.mockRestore();
  });
});

describe("TMUX_PROPAGATED_VARS", () => {
  it("does NOT include OP_SERVICE_ACCOUNT_TOKEN (injected per-session by pool.ts)", () => {
    // Platform token is scoped to the daemon process. Per-entity tokens are
    // injected by pool.ts::resolve_entity_op_token when a session is spawned.
    // Propagating here would leak the platform token into every entity session.
    expect(TMUX_PROPAGATED_VARS).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("does NOT include any OP_SERVICE_ACCOUNT_TOKEN_* variant", () => {
    for (const key of TMUX_PROPAGATED_VARS) {
      expect(key.startsWith("OP_SERVICE_ACCOUNT_TOKEN")).toBe(false);
    }
  });

  it("includes the core process-wide vars (PATH, HOME, BUN_INSTALL)", () => {
    expect(TMUX_PROPAGATED_VARS).toContain("PATH");
    expect(TMUX_PROPAGATED_VARS).toContain("HOME");
    expect(TMUX_PROPAGATED_VARS).toContain("BUN_INSTALL");
  });
});

describe("TMUX_DEPROPAGATE_VARS", () => {
  it("is an array containing OP_SERVICE_ACCOUNT_TOKEN", () => {
    expect(Array.isArray(TMUX_DEPROPAGATE_VARS)).toBe(true);
    expect(TMUX_DEPROPAGATE_VARS).toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("contains only string entries", () => {
    for (const entry of TMUX_DEPROPAGATE_VARS) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeGreaterThan(0);
    }
  });
});

describe("propagate_tmux_env", () => {
  it("calls tmux setter for each present env var", () => {
    const calls: Array<[string, string]> = [];
    const setter = (key: string, value: string) => {
      calls.push([key, value]);
      return true;
    };

    const env = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/test",
      BUN_INSTALL: "/Users/test/.bun",
    };

    propagate_tmux_env(env, setter, noop_remover);

    expect(calls).toHaveLength(3);
    expect(calls).toContainEqual(["PATH", "/usr/bin:/bin"]);
    expect(calls).toContainEqual(["HOME", "/Users/test"]);
    expect(calls).toContainEqual(["BUN_INSTALL", "/Users/test/.bun"]);
  });

  it("does NOT propagate OP_SERVICE_ACCOUNT_TOKEN even when present in env", () => {
    const calls: Array<[string, string]> = [];
    const setter = (key: string, value: string) => {
      calls.push([key, value]);
      return true;
    };

    // Token value is an opaque placeholder — we only assert its KEY doesn't
    // appear in the propagated calls. Never compare against the raw value.
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      OP_SERVICE_ACCOUNT_TOKEN: "placeholder-should-not-propagate",
    };

    propagate_tmux_env(env, setter, noop_remover);

    const propagated_keys = calls.map((c) => c[0]);
    expect(propagated_keys).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("skips env vars that are not set", () => {
    const calls: Array<[string, string]> = [];
    const setter = (key: string, value: string) => {
      calls.push([key, value]);
      return true;
    };

    // Only PATH and HOME are set
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
    };

    propagate_tmux_env(env, setter, noop_remover);

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[0])).toEqual(["PATH", "HOME"]);
  });

  it("does not throw when tmux server is not running", () => {
    // All tmux calls fail — both setter and remover return false.
    const setter = () => false;
    const remover = () => false;

    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
    };

    // Should not throw
    expect(() => propagate_tmux_env(env, setter, remover)).not.toThrow();
  });

  it("logs success message when at least one var propagated", () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    propagate_tmux_env({ PATH: "/usr/bin" }, () => true, noop_remover);

    expect(log_spy).toHaveBeenCalledWith("[env] Propagated environment to tmux server");

    log_spy.mockRestore();
  });

  it("logs fallback message when no vars could be propagated", () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    propagate_tmux_env({ PATH: "/usr/bin" }, () => false, noop_remover);

    expect(log_spy).toHaveBeenCalledWith("[env] tmux server not running, will inherit daemon env");

    log_spy.mockRestore();
  });

  it("calls the tmux remover for each var in TMUX_DEPROPAGATE_VARS, in order", () => {
    const removed: string[] = [];
    const remover = (key: string) => {
      removed.push(key);
      return true;
    };

    propagate_tmux_env({ PATH: "/usr/bin" }, noop_remover, remover);

    expect(removed).toEqual([...TMUX_DEPROPAGATE_VARS]);
  });

  it("runs depropagate BEFORE propagate (defensive ordering)", () => {
    // Single chronological log of all tmux calls, tagged by phase.
    const phases: string[] = [];
    const setter = (key: string, _value: string) => {
      phases.push(`set:${key}`);
      return true;
    };
    const remover = (key: string) => {
      phases.push(`remove:${key}`);
      return true;
    };

    propagate_tmux_env({ PATH: "/usr/bin", HOME: "/h" }, setter, remover);

    // Every remove:* call must precede every set:* call.
    const last_remove_idx = phases
      .map((p, i) => (p.startsWith("remove:") ? i : -1))
      .filter((i) => i >= 0)
      .reduce((a, b) => Math.max(a, b), -1);
    const first_set_idx = phases.findIndex((p) => p.startsWith("set:"));

    expect(last_remove_idx).toBeGreaterThanOrEqual(0);
    expect(first_set_idx).toBeGreaterThanOrEqual(0);
    expect(last_remove_idx).toBeLessThan(first_set_idx);
  });

  it("does not throw when the remover reports unknown-variable failure", () => {
    // Simulate tmux returning non-zero because the var wasn't set
    // (clean install, nothing to scrub). Remover returns false for every
    // call; propagate_tmux_env must swallow this and continue.
    const remover = () => false;
    const setter = () => true;

    expect(() => propagate_tmux_env({ PATH: "/usr/bin" }, setter, remover)).not.toThrow();
  });

  it("completes the full flow cleanly when all tmux calls succeed", () => {
    const removed: string[] = [];
    const set_keys: string[] = [];
    const remover = (key: string) => {
      removed.push(key);
      return true;
    };
    const setter = (key: string, _value: string) => {
      set_keys.push(key);
      return true;
    };

    expect(() =>
      propagate_tmux_env({ PATH: "/usr/bin", HOME: "/h", BUN_INSTALL: "/b" }, setter, remover),
    ).not.toThrow();

    expect(removed).toEqual([...TMUX_DEPROPAGATE_VARS]);
    expect(set_keys).toEqual(["PATH", "HOME", "BUN_INSTALL"]);
  });

  it("logs depropagate cleanup message with var names (names are not secrets)", () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    propagate_tmux_env(
      { PATH: "/usr/bin" },
      () => true,
      () => true,
    );

    // The log line should mention the count and the names of the scrubbed
    // vars — names are safe to log, values never are.
    const matched = log_spy.mock.calls.some(
      ([msg]) =>
        typeof msg === "string" &&
        msg.includes("tmux global cleanup") &&
        msg.includes("OP_SERVICE_ACCOUNT_TOKEN"),
    );
    expect(matched).toBe(true);

    log_spy.mockRestore();
  });

  it("scrubs legacy vars on the second call once tmux becomes live (issue #18)", () => {
    // Models the fresh-boot timing bug fixed by issue #18. At daemon startup
    // the tmux server does not yet exist, so the FIRST propagate_tmux_env
    // call's remover silently no-ops. Later, `tmux new-session` spawned by
    // pool bot resume creates the server, which inherits the daemon's env
    // (including the bare OP_SERVICE_ACCOUNT_TOKEN aliased from env.sh). A
    // SECOND propagate_tmux_env call, issued after the server is live, must
    // successfully reach it and remove the legacy var.
    //
    // The second call is wired in packages/daemon/src/index.ts right after
    // `await pool.resume_parked_bots()`. This test exercises the invariant
    // that propagate_tmux_env is safe to call twice and that the second
    // call is the one that actually scrubs.
    let tmux_alive = false;
    const removed: string[] = [];
    const set_calls: Array<[string, string]> = [];

    const setter = (key: string, value: string) => {
      if (!tmux_alive) return false;
      set_calls.push([key, value]);
      return true;
    };
    const remover = (key: string) => {
      if (!tmux_alive) return false; // server not running → no-op
      removed.push(key);
      return true;
    };

    // Token value is an opaque placeholder — the test only inspects keys,
    // never values. Never compare against a raw token here.
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    // First call: tmux server not running. Everything fails silently.
    propagate_tmux_env(env, setter, remover);
    expect(removed).toEqual([]);
    expect(set_calls).toEqual([]);

    // Simulate the first tmux new-session creating the server (e.g. pool
    // bot resume in resume_parked_bots).
    tmux_alive = true;

    // Second call: the fix path. Must now actually scrub the legacy var
    // AND propagate the whitelisted vars.
    propagate_tmux_env(env, setter, remover);
    expect(removed).toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(removed).toEqual([...TMUX_DEPROPAGATE_VARS]);
    expect(set_calls.map(([k]) => k)).toEqual(["PATH", "HOME"]);
    // Belt-and-suspenders: the token is NOT in the propagate set.
    expect(set_calls.map(([k]) => k)).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });
});

describe("resolve_binary", () => {
  it("returns an absolute path for a known binary", () => {
    // `node` is guaranteed to be present since tests are running under it
    const result = resolve_binary("node");
    expect(result).toMatch(/^\//);
    expect(result).toContain("node");
  });

  it("returns the bare name when the binary does not exist", () => {
    const result = resolve_binary("definitely-not-a-real-binary-xyz");
    expect(result).toBe("definitely-not-a-real-binary-xyz");
  });

  it("resolves gh to an absolute path", () => {
    // gh is a required binary for this daemon, so it should exist in CI/dev
    const result = resolve_binary("gh");
    expect(result).toMatch(/^\//);
    expect(result).toContain("gh");
  });
});
