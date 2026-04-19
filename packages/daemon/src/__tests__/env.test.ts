import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TMUX_PROPAGATED_VARS,
  check_required_binaries,
  propagate_tmux_env,
  resolve_binary,
} from "../env.js";

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

    propagate_tmux_env(env, setter);

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

    propagate_tmux_env(env, setter);

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

    propagate_tmux_env(env, setter);

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[0])).toEqual(["PATH", "HOME"]);
  });

  it("does not throw when tmux server is not running", () => {
    // All tmux calls fail
    const setter = () => false;

    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
    };

    // Should not throw
    expect(() => propagate_tmux_env(env, setter)).not.toThrow();
  });

  it("logs success message when at least one var propagated", () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    propagate_tmux_env({ PATH: "/usr/bin" }, () => true);

    expect(log_spy).toHaveBeenCalledWith("[env] Propagated environment to tmux server");

    log_spy.mockRestore();
  });

  it("logs fallback message when no vars could be propagated", () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    propagate_tmux_env({ PATH: "/usr/bin" }, () => false);

    expect(log_spy).toHaveBeenCalledWith("[env] tmux server not running, will inherit daemon env");

    log_spy.mockRestore();
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
