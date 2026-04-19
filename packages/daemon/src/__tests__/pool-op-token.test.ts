/**
 * Tests for per-entity OP_SERVICE_ACCOUNT_TOKEN resolution.
 *
 * Covers:
 * - entity_id_to_env_suffix: kebab-case, underscores, mixed case, numerics,
 *   and invalid shapes that can't produce a valid env var name
 * - resolve_entity_op_token: entity-scoped hit, platform fallback with warning
 *   + Sentry breadcrumb, and null when neither is available
 *
 * Security posture: tests only reason about whether tokens are present /
 * absent / selected. Raw token values in these tests are opaque placeholders;
 * we never assert against a real secret and never include one in the
 * warning-message regex.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entity_id_to_env_suffix, resolve_entity_op_token } from "../pool.js";
import * as sentry from "../sentry.js";

describe("entity_id_to_env_suffix", () => {
  it("upper-cases a lowercase id", () => {
    expect(entity_id_to_env_suffix("healthydogs")).toBe("HEALTHYDOGS");
  });

  it("converts kebab-case to underscore (lobster-farm → LOBSTER_FARM)", () => {
    expect(entity_id_to_env_suffix("lobster-farm")).toBe("LOBSTER_FARM");
  });

  it("preserves already-underscored ids", () => {
    expect(entity_id_to_env_suffix("my_entity")).toBe("MY_ENTITY");
  });

  it("handles mixed case", () => {
    expect(entity_id_to_env_suffix("MixedCase")).toBe("MIXEDCASE");
  });

  it("allows embedded digits", () => {
    expect(entity_id_to_env_suffix("client99")).toBe("CLIENT99");
  });

  it("replaces non-alphanumeric characters with underscore", () => {
    expect(entity_id_to_env_suffix("client.99")).toBe("CLIENT_99");
    expect(entity_id_to_env_suffix("a/b")).toBe("A_B");
    expect(entity_id_to_env_suffix("foo bar")).toBe("FOO_BAR");
  });

  it("rejects ids that would produce a digit-leading env var name", () => {
    // POSIX: env var names must start with a letter or underscore.
    expect(entity_id_to_env_suffix("99badstart")).toBeNull();
    expect(entity_id_to_env_suffix("1")).toBeNull();
  });

  it("rejects empty or non-string input", () => {
    expect(entity_id_to_env_suffix("")).toBeNull();
    // Simulate bad data coming off the wire
    expect(entity_id_to_env_suffix(undefined as unknown as string)).toBeNull();
    expect(entity_id_to_env_suffix(null as unknown as string)).toBeNull();
  });

  it("handles a leading underscore id", () => {
    expect(entity_id_to_env_suffix("_internal")).toBe("_INTERNAL");
  });
});

describe("resolve_entity_op_token", () => {
  let warn_spy: ReturnType<typeof vi.spyOn>;
  let breadcrumb_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    breadcrumb_spy = vi.spyOn(sentry, "addBreadcrumb").mockImplementation(() => {});
  });

  afterEach(() => {
    warn_spy.mockRestore();
    breadcrumb_spy.mockRestore();
  });

  it("returns the entity-scoped token when set", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN_HEALTHYDOGS: "entity-token-placeholder",
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    const result = resolve_entity_op_token("healthydogs", env);

    expect(result).toBe("entity-token-placeholder");
    // No warning, no breadcrumb — this is the happy path
    expect(warn_spy).not.toHaveBeenCalled();
    expect(breadcrumb_spy).not.toHaveBeenCalled();
  });

  it("normalizes kebab-case entity ids before lookup", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN_LOBSTER_FARM: "lf-token-placeholder",
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    expect(resolve_entity_op_token("lobster-farm", env)).toBe("lf-token-placeholder");
    expect(warn_spy).not.toHaveBeenCalled();
  });

  it("falls back to the platform token with a warning when entity token is missing", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    const result = resolve_entity_op_token("healthydogs", env);

    expect(result).toBe("platform-token-placeholder");

    // Warning must mention the entity id — and must NOT include any token value.
    // We match on the message format, not on the secret.
    expect(warn_spy).toHaveBeenCalledTimes(1);
    const warn_message = warn_spy.mock.calls[0]?.[0] as string;
    expect(warn_message).toContain("[pool] WARN");
    expect(warn_message).toContain("no entity-scoped OP token");
    expect(warn_message).toContain("healthydogs");
    expect(warn_message).toContain("falling back to platform token");
    expect(warn_message).not.toContain("platform-token-placeholder");
  });

  it("adds a Sentry breadcrumb on the fallback path (no token values)", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    resolve_entity_op_token("healthydogs", env);

    expect(breadcrumb_spy).toHaveBeenCalledTimes(1);
    const crumb = breadcrumb_spy.mock.calls[0]?.[0] as {
      category: string;
      message: string;
      level?: string;
      data?: Record<string, unknown>;
    };
    expect(crumb.category).toBe("pool.op-token");
    expect(crumb.level).toBe("warning");
    expect(crumb.data).toEqual({ entity_id: "healthydogs", suffix: "HEALTHYDOGS" });
    // The breadcrumb must not carry the token itself.
    const serialized = JSON.stringify(crumb);
    expect(serialized).not.toContain("platform-token-placeholder");
  });

  it("does not crash when Sentry throws (e.g., misconfigured)", () => {
    breadcrumb_spy.mockImplementation(() => {
      throw new Error("sentry not initialized");
    });
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    // Fallback path must still surface the platform token even if Sentry throws.
    expect(() => resolve_entity_op_token("healthydogs", env)).not.toThrow();
    expect(resolve_entity_op_token("healthydogs", env)).toBe("platform-token-placeholder");
  });

  it("returns null when neither entity-scoped nor platform token is available", () => {
    const env = {};

    const result = resolve_entity_op_token("healthydogs", env);

    expect(result).toBeNull();
    // No platform token to fall back to → no warning emitted. Sessions simply
    // start without op access; warning would be noise.
    expect(warn_spy).not.toHaveBeenCalled();
    expect(breadcrumb_spy).not.toHaveBeenCalled();
  });

  it("returns null for an invalid entity id when only entity-scoped lookup would apply", () => {
    // Invalid suffix → entity-scoped lookup is skipped. No platform token → null.
    const env = {};
    expect(resolve_entity_op_token("99badstart", env)).toBeNull();
  });

  it("falls back to platform token for an invalid entity id if platform token is present", () => {
    // Belt-and-suspenders: even if the id is malformed, we still prefer keeping
    // the session alive on the platform token rather than dying silently.
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    expect(resolve_entity_op_token("99badstart", env)).toBe("platform-token-placeholder");
    expect(warn_spy).toHaveBeenCalledTimes(1);
  });

  it("defaults to process.env when env is not passed", () => {
    // Ensure the default parameter actually reads process.env.
    const key = "OP_SERVICE_ACCOUNT_TOKEN_TEST_DEFAULT_ENV";
    process.env[key] = "default-env-placeholder";
    try {
      expect(resolve_entity_op_token("test-default-env")).toBe("default-env-placeholder");
    } finally {
      delete process.env[key];
    }
  });
});
