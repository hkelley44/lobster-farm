import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate_env_sh, generate_plist, generate_wrapper_sh } from "../lib/launchd.js";

/**
 * Build an env with every OP_SERVICE_ACCOUNT_TOKEN* and related host-leak
 * variable stripped. Prevents the developer's real tokens from contaminating
 * the subshell under test.
 */
function scrubbed_env(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OP_SERVICE_ACCOUNT_TOKEN")) delete env[key];
  }
  return env;
}

/**
 * Source a snippet of the generated env.sh under a synthetic $HOME that we
 * fully control, then dump the resulting environment as NUL-delimited
 * KEY=VALUE pairs. Returns a map of env vars visible after sourcing.
 *
 * We run under /bin/sh (not zsh) to exercise the most conservative shell —
 * if it works in sh, it works in zsh.
 */
function source_and_dump_env(generated: string, fake_home: string): Record<string, string> {
  // Replace the shebang (zsh-specific) — /bin/sh evaluation only needs POSIX.
  const script = generated.replace(/^#!\/bin\/zsh\n/, "");
  const runner = `HOME='${fake_home}'\n${script}\nenv -0`;
  const out = execFileSync("/bin/sh", ["-c", runner], {
    encoding: "utf-8",
    env: scrubbed_env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const map: Record<string, string> = {};
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    map[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return map;
}

// --- generate_env_sh ---

describe("generate_env_sh", () => {
  const mock_resolver = (paths: Record<string, string>) => (name: string) => paths[name] ?? null;

  it("includes PATH with directories for detected binaries", () => {
    const resolver = mock_resolver({
      bun: "/Users/test/.bun/bin/bun",
      node: "/opt/homebrew/bin/node",
      git: "/usr/bin/git",
    });

    const result = generate_env_sh({}, resolver);

    // All three binary directories should appear in PATH
    expect(result).toContain("/Users/test/.bun/bin");
    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/usr/bin");
    // Should have a PATH export
    expect(result).toMatch(/^export PATH="/m);
  });

  it("deduplicates PATH entries", () => {
    // node and git both in /usr/bin — should only appear once
    const resolver = mock_resolver({
      node: "/usr/bin/node",
      git: "/usr/bin/git",
    });

    const result = generate_env_sh({}, resolver);
    const path_line = result.split("\n").find((l) => l.startsWith("export PATH="))!;
    const path_value = path_line.replace('export PATH="', "").replace('"', "");
    const dirs = path_value.split(":");

    // /usr/bin should appear exactly once
    expect(dirs.filter((d) => d === "/usr/bin")).toHaveLength(1);
  });

  it("includes base PATH dirs even when no binaries found", () => {
    const resolver = mock_resolver({});

    const result = generate_env_sh({}, resolver);

    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/usr/local/bin");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("puts detected dirs before base dirs in PATH", () => {
    const resolver = mock_resolver({
      bun: "/Users/test/.bun/bin/bun",
    });

    const result = generate_env_sh({}, resolver);
    const path_line = result.split("\n").find((l) => l.startsWith("export PATH="))!;
    const path_value = path_line.replace('export PATH="', "").replace('"', "");

    const bun_idx = path_value.indexOf("/Users/test/.bun/bin");
    const homebrew_idx = path_value.indexOf("/opt/homebrew/bin");
    expect(bun_idx).toBeLessThan(homebrew_idx);
  });

  it("captures BUN_INSTALL from env when present", () => {
    const resolver = mock_resolver({});
    const env = { BUN_INSTALL: "/Users/test/.bun" };

    const result = generate_env_sh(env, resolver);

    expect(result).toContain('export BUN_INSTALL="/Users/test/.bun"');
  });

  it("does NOT capture OP_SERVICE_ACCOUNT_TOKEN from host env", () => {
    // Host-captured value would shadow the op-tokens.env alias and break
    // idempotent regeneration. Must be resolved via op-tokens.env at source-time.
    const resolver = mock_resolver({});
    const env = { OP_SERVICE_ACCOUNT_TOKEN: "ops_should_not_leak_into_template" };

    const result = generate_env_sh(env, resolver);

    expect(result).not.toContain("ops_should_not_leak_into_template");
    expect(result).not.toContain('export OP_SERVICE_ACCOUNT_TOKEN="ops_');
  });

  it("escapes shell-special characters in env var values", () => {
    const resolver = mock_resolver({});
    const env = { BUN_INSTALL: 'path"with$pecial`chars\\here' };

    const result = generate_env_sh(env, resolver);

    // The value should be escaped so it's safe inside double quotes
    expect(result).toContain('export BUN_INSTALL="path\\"with\\$pecial\\`chars\\\\here"');
  });

  it("omits captured env vars when not present in process.env", () => {
    const resolver = mock_resolver({});

    const result = generate_env_sh({}, resolver);

    expect(result).not.toContain("BUN_INSTALL");
    // Should not have the env section header either
    expect(result).not.toContain("Environment variables (captured at generation time)");
  });

  it("marks not-found binaries in comments", () => {
    const resolver = mock_resolver({
      node: "/opt/homebrew/bin/node",
    });

    const result = generate_env_sh({}, resolver);

    expect(result).toContain("# node: /opt/homebrew/bin/node");
    expect(result).toContain("# bun: not found");
    expect(result).toContain("# claude: not found");
  });

  it("starts with a shebang line", () => {
    const resolver = mock_resolver({});
    const result = generate_env_sh({}, resolver);
    expect(result).toMatch(/^#!\/bin\/zsh\n/);
  });
});

// --- generate_env_sh: op-tokens.env block ---

describe("generate_env_sh op-tokens block", () => {
  const mock_resolver = () => (_name: string) => null;
  let fake_home: string;

  beforeEach(() => {
    fake_home = mkdtempSync(join(tmpdir(), "lf-env-sh-"));
  });

  afterEach(() => {
    rmSync(fake_home, { recursive: true, force: true });
  });

  it("emits a guarded source block for op-tokens.env", () => {
    const result = generate_env_sh({}, mock_resolver());

    expect(result).toContain('if [ -f "$HOME/.lobsterfarm/secrets/op-tokens.env" ]; then');
    expect(result).toContain("set -a");
    expect(result).toContain('. "$HOME/.lobsterfarm/secrets/op-tokens.env"');
    expect(result).toContain("set +a");
    expect(result).toContain("fi");
  });

  it("aliases OP_SERVICE_ACCOUNT_TOKEN with a default-empty fallback", () => {
    const result = generate_env_sh({}, mock_resolver());

    // The `:-` default guards against `set -u` crashing when the platform
    // token is absent (e.g. fresh install).
    expect(result).toContain(
      'export OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM:-}"',
    );
  });

  it("does NOT unset per-entity OP_SERVICE_ACCOUNT_TOKEN_* vars", () => {
    // The daemon's pool.ts needs these at runtime to inject the right token
    // per entity tmux session.
    const result = generate_env_sh({}, mock_resolver());

    expect(result).not.toMatch(/unset\s+OP_SERVICE_ACCOUNT_TOKEN/);
  });

  it("exports every token in op-tokens.env when the file is present", () => {
    // Write a fake tokens file with multiple per-entity tokens.
    const secrets_dir = join(fake_home, ".lobsterfarm", "secrets");
    mkdirSync(secrets_dir, { recursive: true });
    const tokens = [
      "OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM=fake_platform_token",
      "OP_SERVICE_ACCOUNT_TOKEN_ACME=fake_acme_token",
      "OP_SERVICE_ACCOUNT_TOKEN_WIDGETS=fake_widgets_token",
      "",
    ].join("\n");
    writeFileSync(join(secrets_dir, "op-tokens.env"), tokens, { mode: 0o600 });

    const result = generate_env_sh({}, mock_resolver());
    const env = source_and_dump_env(result, fake_home);

    expect(env.OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM).toBe("fake_platform_token");
    expect(env.OP_SERVICE_ACCOUNT_TOKEN_ACME).toBe("fake_acme_token");
    expect(env.OP_SERVICE_ACCOUNT_TOKEN_WIDGETS).toBe("fake_widgets_token");
    // Alias resolves to the platform token.
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBe("fake_platform_token");
  });

  it("sources silently when op-tokens.env is absent (fresh install)", () => {
    // No secrets dir at all — fresh install path.
    const result = generate_env_sh({}, mock_resolver());

    // Sourcing must succeed with no error output.
    const script = result.replace(/^#!\/bin\/zsh\n/, "");
    const runner = `HOME='${fake_home}'\n${script}\necho "__OK__"`;
    const stdout = execFileSync("/bin/sh", ["-ceu", runner], {
      encoding: "utf-8",
      env: scrubbed_env(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(stdout).toContain("__OK__");

    // And the alias is not exported (the whole block is guarded).
    const env = source_and_dump_env(result, fake_home);
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
  });

  it("does not crash under `set -u` when OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM is unset", () => {
    // Tokens file exists but does NOT set the platform token — alias must
    // fall back to empty string instead of nounset-crashing.
    const secrets_dir = join(fake_home, ".lobsterfarm", "secrets");
    mkdirSync(secrets_dir, { recursive: true });
    writeFileSync(
      join(secrets_dir, "op-tokens.env"),
      "OP_SERVICE_ACCOUNT_TOKEN_ACME=fake_acme_token\n",
      { mode: 0o600 },
    );

    const result = generate_env_sh({}, mock_resolver());
    const script = result.replace(/^#!\/bin\/zsh\n/, "");
    const runner = `HOME='${fake_home}'\nset -u\n${script}\necho "__OK__"`;
    const stdout = execFileSync("/bin/sh", ["-c", runner], {
      encoding: "utf-8",
      env: scrubbed_env(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(stdout).toContain("__OK__");
  });

  it("is byte-identical across regenerations (idempotent)", () => {
    const resolver = (paths: Record<string, string>) => (name: string) => paths[name] ?? null;
    const inputs = {
      bun: "/Users/test/.bun/bin/bun",
      node: "/opt/homebrew/bin/node",
      git: "/usr/bin/git",
    };
    const env = { BUN_INSTALL: "/Users/test/.bun" };

    const first = generate_env_sh(env, resolver(inputs));
    const second = generate_env_sh(env, resolver(inputs));
    const third = generate_env_sh(env, resolver(inputs));

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("matches the expected template shape (snapshot)", () => {
    const resolver = (name: string) =>
      name === "node" ? "/opt/homebrew/bin/node" : name === "op" ? "/opt/homebrew/bin/op" : null;

    const result = generate_env_sh({}, resolver);

    // Assert structural landmarks in the exact expected order. Any drift in
    // the emitted template trips this test.
    const expected_markers = [
      "#!/bin/zsh",
      "# LobsterFarm daemon environment",
      "# Detected binaries:",
      "# node: /opt/homebrew/bin/node",
      "# op: /opt/homebrew/bin/op",
      'export PATH="',
      "# 1Password service account tokens.",
      'if [ -f "$HOME/.lobsterfarm/secrets/op-tokens.env" ]; then',
      "  set -a",
      '  . "$HOME/.lobsterfarm/secrets/op-tokens.env"',
      "  set +a",
      '  export OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN_LOBSTERFARM:-}"',
      "fi",
    ];
    let cursor = 0;
    for (const marker of expected_markers) {
      const idx = result.indexOf(marker, cursor);
      expect({ marker, idx }).toEqual({ marker, idx: expect.any(Number) });
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx + marker.length;
    }
  });
});

// --- generate_wrapper_sh ---

describe("generate_wrapper_sh", () => {
  it("produces a valid shell script with env.sh guard", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    expect(result).toMatch(/^#!\/bin\/zsh\n/);
    expect(result).toContain('source "$ENV_FILE"');
    expect(result).toContain("exit 1");
    expect(result).toContain("FATAL");
    expect(result).toContain("not found");
  });

  it("includes correct node and daemon paths in exec", () => {
    const result = generate_wrapper_sh(
      "/opt/homebrew/bin/node",
      "/Users/farm/.lobsterfarm/src/packages/daemon/dist/index.js",
    );

    // Both the op-run path and the fallback should include the correct node/daemon paths
    expect(result).toContain(
      '"/opt/homebrew/bin/node" --max-old-space-size=8192 "/Users/farm/.lobsterfarm/src/packages/daemon/dist/index.js"',
    );
  });

  it("uses op run to inject secrets from .env.op when available", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    expect(result).toContain("op run --env-file");
    expect(result).toContain(".env.op");
    // Should have a fallback when op or .env.op is not available
    expect(result).toContain("WARNING");
  });

  it("references env.sh in the standard location", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    expect(result).toContain(".lobsterfarm/env.sh");
  });
});

// --- generate_plist ---

describe("generate_plist", () => {
  it("uses wrapper path as sole ProgramArguments entry", () => {
    const result = generate_plist(
      "/Users/farm/.lobsterfarm/bin/start-daemon.sh",
      "/Users/farm/.lobsterfarm/logs/daemon.log",
      "/Users/farm/.lobsterfarm",
    );

    expect(result).toContain("<string>/Users/farm/.lobsterfarm/bin/start-daemon.sh</string>");
    // Should be the only entry in the array — no node path, no daemon path
    const array_match = result.match(/<array>([\s\S]*?)<\/array>/);
    expect(array_match).toBeTruthy();
    const strings_in_array = array_match![1]!.match(/<string>/g);
    expect(strings_in_array).toHaveLength(1);
  });

  it("has no EnvironmentVariables section", () => {
    const result = generate_plist(
      "/Users/farm/.lobsterfarm/bin/start-daemon.sh",
      "/Users/farm/.lobsterfarm/logs/daemon.log",
      "/Users/farm/.lobsterfarm",
    );

    expect(result).not.toContain("EnvironmentVariables");
  });

  it("includes correct log paths", () => {
    const result = generate_plist("/wrapper.sh", "/logs/daemon.log", "/working");

    expect(result).toContain("<string>/logs/daemon.log</string>");
    // Both stdout and stderr should use the same log
    const log_matches = result.match(/<string>\/logs\/daemon\.log<\/string>/g);
    expect(log_matches).toHaveLength(2);
  });

  it("includes working directory", () => {
    const result = generate_plist("/wrapper.sh", "/logs/daemon.log", "/Users/farm/.lobsterfarm");

    expect(result).toContain("<key>WorkingDirectory</key>");
    expect(result).toContain("<string>/Users/farm/.lobsterfarm</string>");
  });

  it("includes KeepAlive and RunAtLoad", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    expect(result).toContain("<key>KeepAlive</key>");
    expect(result).toContain("<true/>");
    expect(result).toContain("<key>RunAtLoad</key>");
  });

  it("includes the correct launchd label", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    expect(result).toContain("com.lobsterfarm.daemon");
  });

  it("includes ExitTimeout of 300 for graceful drain", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");
    expect(result).toContain("<key>ExitTimeout</key>");
    expect(result).toContain("<integer>300</integer>");
  });

  it("is synchronous (returns string, not Promise)", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    // If it were async, result would be a Promise object, not a string
    expect(typeof result).toBe("string");
    expect(result).toContain("<?xml");
  });

  it("produces valid XML structure", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    expect(result).toContain('<?xml version="1.0"');
    expect(result).toContain("<!DOCTYPE plist");
    expect(result).toContain('<plist version="1.0">');
    expect(result).toContain("</plist>");
  });
});
