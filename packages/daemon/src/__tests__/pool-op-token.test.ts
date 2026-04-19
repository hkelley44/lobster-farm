/**
 * Tests for per-entity OP_SERVICE_ACCOUNT_TOKEN resolution.
 *
 * Covers:
 * - entity_id_to_env_suffix: kebab-case, underscores, mixed case, numerics,
 *   and invalid shapes that can't produce a valid env var name. Returns an
 *   ordered, deduped list of candidate suffixes (underscore form first,
 *   stripped form second) — see issue #13.
 * - resolve_entity_op_token: entity-scoped hit (either candidate), platform
 *   fallback with warning + Sentry breadcrumb, and null when neither is
 *   available.
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
  it("returns a single candidate for a lowercase id with no hyphens", () => {
    expect(entity_id_to_env_suffix("healthydogs")).toEqual(["HEALTHYDOGS"]);
  });

  it("returns [underscore, stripped] for kebab-case (lobster-farm)", () => {
    // Underscore form is first so it wins when both tokens exist.
    expect(entity_id_to_env_suffix("lobster-farm")).toEqual(["LOBSTER_FARM", "LOBSTERFARM"]);
  });

  it("returns both candidates for multi-hyphen ids, deduped order preserved", () => {
    expect(entity_id_to_env_suffix("a-b-c")).toEqual(["A_B_C", "ABC"]);
  });

  it("dedupes when underscore and stripped forms are identical", () => {
    expect(entity_id_to_env_suffix("my_entity")).toEqual(["MY_ENTITY"]);
    expect(entity_id_to_env_suffix("MixedCase")).toEqual(["MIXEDCASE"]);
    expect(entity_id_to_env_suffix("client99")).toEqual(["CLIENT99"]);
  });

  it("replaces non-alphanumeric, non-hyphen characters with underscore in both forms", () => {
    // Dots / slashes / spaces are not hyphens — they become underscores in
    // both the explicit and compact candidates, which dedupes to one entry.
    expect(entity_id_to_env_suffix("client.99")).toEqual(["CLIENT_99"]);
    expect(entity_id_to_env_suffix("a/b")).toEqual(["A_B"]);
    expect(entity_id_to_env_suffix("foo bar")).toEqual(["FOO_BAR"]);
  });

  it("rejects ids that would produce a digit-leading env var name", () => {
    // POSIX: env var names must start with a letter or underscore. Both
    // candidates fail validation → empty list.
    expect(entity_id_to_env_suffix("99badstart")).toEqual([]);
    expect(entity_id_to_env_suffix("1")).toEqual([]);
  });

  it("rejects empty or non-string input", () => {
    expect(entity_id_to_env_suffix("")).toEqual([]);
    // Simulate bad data coming off the wire
    expect(entity_id_to_env_suffix(undefined as unknown as string)).toEqual([]);
    expect(entity_id_to_env_suffix(null as unknown as string)).toEqual([]);
  });

  it("handles a leading underscore id", () => {
    expect(entity_id_to_env_suffix("_internal")).toEqual(["_INTERNAL"]);
  });

  it("drops a stripped candidate that becomes digit-leading", () => {
    // "12-foo" → underscore form "12_FOO" is invalid; stripped "12FOO" also
    // invalid. Both filtered → empty.
    expect(entity_id_to_env_suffix("12-foo")).toEqual([]);
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

  it("returns the entity-scoped token when set (no-hyphen id)", () => {
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

  it("resolves the underscore form when only the underscore token is set", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN_LOBSTER_FARM: "lf-underscore-placeholder",
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    expect(resolve_entity_op_token("lobster-farm", env)).toBe("lf-underscore-placeholder");
    expect(warn_spy).not.toHaveBeenCalled();
    expect(breadcrumb_spy).not.toHaveBeenCalled();
  });

  it("resolves the stripped form when only the stripped token is set (issue #13)", () => {
    // This is the live bug: lobster-farm's token is stored as LOBSTERFARM.
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM: "lf-stripped-placeholder",
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    expect(resolve_entity_op_token("lobster-farm", env)).toBe("lf-stripped-placeholder");
    expect(warn_spy).not.toHaveBeenCalled();
    expect(breadcrumb_spy).not.toHaveBeenCalled();
  });

  it("prefers the underscore form when both are set (explicit wins)", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN_LOBSTER_FARM: "lf-underscore-placeholder",
      OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM: "lf-stripped-placeholder",
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    expect(resolve_entity_op_token("lobster-farm", env)).toBe("lf-underscore-placeholder");
    expect(warn_spy).not.toHaveBeenCalled();
  });

  it("falls back to platform token when neither candidate form is set", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    const result = resolve_entity_op_token("lobster-farm", env);

    expect(result).toBe("platform-token-placeholder");
    expect(warn_spy).toHaveBeenCalledTimes(1);
    const warn_message = warn_spy.mock.calls[0]?.[0] as string;
    expect(warn_message).toContain("[pool] WARN");
    expect(warn_message).toContain("no entity-scoped OP token");
    expect(warn_message).toContain("lobster-farm");
    expect(warn_message).toContain("falling back to platform token");
    expect(warn_message).not.toContain("platform-token-placeholder");
  });

  it("collision: lobster-farm and lobsterfarm both resolve to LOBSTERFARM when that's the only token", () => {
    // Documents the known Option-A collision (see issue #13): a machine with
    // only OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM set serves both entity ids
    // from the same token because "lobsterfarm" → ["LOBSTERFARM"] and
    // "lobster-farm" → ["LOBSTER_FARM", "LOBSTERFARM"].
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM: "shared-token-placeholder",
    };

    expect(resolve_entity_op_token("lobsterfarm", env)).toBe("shared-token-placeholder");
    expect(resolve_entity_op_token("lobster-farm", env)).toBe("shared-token-placeholder");
  });

  it("collision: if a LOBSTER_FARM-specific token exists, it wins for lobster-farm only", () => {
    // The inverse: hyphenated id gets its explicit token; compact id still
    // falls back since LOBSTERFARM isn't set.
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN_LOBSTER_FARM: "hyphen-specific-placeholder",
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    expect(resolve_entity_op_token("lobster-farm", env)).toBe("hyphen-specific-placeholder");
    // lobsterfarm has no LOBSTERFARM token → fallback.
    expect(resolve_entity_op_token("lobsterfarm", env)).toBe("platform-token-placeholder");
  });

  it("falls back to the platform token with a warning when entity token is missing (no-hyphen)", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    const result = resolve_entity_op_token("healthydogs", env);

    expect(result).toBe("platform-token-placeholder");

    expect(warn_spy).toHaveBeenCalledTimes(1);
    const warn_message = warn_spy.mock.calls[0]?.[0] as string;
    expect(warn_message).toContain("[pool] WARN");
    expect(warn_message).toContain("no entity-scoped OP token");
    expect(warn_message).toContain("healthydogs");
    expect(warn_message).toContain("falling back to platform token");
    expect(warn_message).not.toContain("platform-token-placeholder");
  });

  it("adds a Sentry breadcrumb on the fallback path listing all tried suffixes", () => {
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

    resolve_entity_op_token("lobster-farm", env);

    expect(breadcrumb_spy).toHaveBeenCalledTimes(1);
    const crumb = breadcrumb_spy.mock.calls[0]?.[0] as {
      category: string;
      message: string;
      level?: string;
      data?: Record<string, unknown>;
    };
    expect(crumb.category).toBe("pool.op-token");
    expect(crumb.level).toBe("warning");
    expect(crumb.data).toEqual({
      entity_id: "lobster-farm",
      suffixes_tried: ["LOBSTER_FARM", "LOBSTERFARM"],
    });
    // The breadcrumb must not carry the token itself.
    const serialized = JSON.stringify(crumb);
    expect(serialized).not.toContain("platform-token-placeholder");
  });

  it("breadcrumb for a no-hyphen id lists a single suffix", () => {
    const env = { OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder" };
    resolve_entity_op_token("healthydogs", env);

    const crumb = breadcrumb_spy.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>;
    };
    expect(crumb.data).toEqual({
      entity_id: "healthydogs",
      suffixes_tried: ["HEALTHYDOGS"],
    });
  });

  it("does not crash when Sentry throws (e.g., misconfigured)", () => {
    breadcrumb_spy.mockImplementation(() => {
      throw new Error("sentry not initialized");
    });
    const env = {
      OP_SERVICE_ACCOUNT_TOKEN: "platform-token-placeholder",
    };

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
    // Invalid suffix list (empty) → entity-scoped lookup is skipped. No platform token → null.
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
