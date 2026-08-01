import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate_env_sh, generate_plist, generate_wrapper_sh } from "../lib/launchd.js";

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

  it("captures OP_SERVICE_ACCOUNT_TOKEN from env when present", () => {
    const resolver = mock_resolver({});
    const env = { OP_SERVICE_ACCOUNT_TOKEN: "ops_abc123" };

    const result = generate_env_sh(env, resolver);

    expect(result).toContain('export OP_SERVICE_ACCOUNT_TOKEN="ops_abc123"');
  });

  it("escapes shell-special characters in env var values", () => {
    const resolver = mock_resolver({});
    const env = { OP_SERVICE_ACCOUNT_TOKEN: 'token"with$pecial`chars\\here' };

    const result = generate_env_sh(env, resolver);

    // The value should be escaped so it's safe inside double quotes
    expect(result).toContain(
      'export OP_SERVICE_ACCOUNT_TOKEN="token\\"with\\$pecial\\`chars\\\\here"',
    );
  });

  it("omits env vars not present in process.env", () => {
    const resolver = mock_resolver({});

    const result = generate_env_sh({}, resolver);

    expect(result).not.toContain("BUN_INSTALL");
    expect(result).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
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

    // node is exec'd directly with the daemon entry point.
    expect(result).toContain(
      'exec "/opt/homebrew/bin/node" --max-old-space-size=8192 "/Users/farm/.lobsterfarm/src/packages/daemon/dist/index.js"',
    );
  });

  it("uses op inject (not op run) to load secrets from .env.op", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    // Secrets are resolved via `op inject` and exported into the env.
    expect(result).toContain("op inject -i");
    expect(result).toContain(".env.op");
    // Should warn when op/.env.op are unavailable or injection fails.
    expect(result).toContain("WARNING");
  });

  // Non-comment executable lines of the wrapper — the comments deliberately
  // discuss the `op run` / `eval` anti-patterns, so the invariant checks below
  // must look only at what the shell actually runs.
  const executable_lines = (script: string): string[] =>
    script.split("\n").filter((l) => {
      const t = l.trimStart();
      return t.length > 0 && !t.startsWith("#");
    });

  it("never wraps node as an `op run` child (no-orphan invariant, #97)", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    // `op run -- node` is exactly the pattern that orphaned node behind a dead
    // supervisor while it kept holding :7749. No executable line may invoke it.
    for (const line of executable_lines(result)) {
      expect(line).not.toContain("op run");
    }
    // node must be the exec'd leaf — exactly one exec, and it's node.
    const exec_lines = executable_lines(result).filter((l) => l.trimStart().startsWith("exec "));
    expect(exec_lines).toHaveLength(1);
    expect(exec_lines[0]).toContain('"/opt/homebrew/bin/node"');
  });

  it("exports injected secrets without eval (safe for shell metacharacters)", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    // Literal export of the buffered assignment, and no `eval` of secret values.
    expect(result).toContain('export "$op_key=$op_value"');
    for (const line of executable_lines(result)) {
      expect(line).not.toMatch(/\beval\b/);
    }
  });

  it("documents the multi-line quoting contract in the wrapper itself", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    // Whoever debugs a secret-injection failure reads the wrapper, not this repo.
    expect(result).toMatch(/MULTI-LINE SECRETS MUST BE QUOTED/);
    expect(result).toContain("multi-line secrets must be quoted in .env.op");
  });

  it("references env.sh in the standard location", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    expect(result).toContain(".lobsterfarm/env.sh");
  });
});

// --- generate_wrapper_sh: functional secret-injection behaviour ---
//
// These run the generated wrapper under a real zsh with a stub `op` (prints a
// canned `op inject` result) and a stub "node" (dumps the environment it was
// exec'd with). That end-to-end path is the only way to prove the dotenv parser
// actually round-trips a multi-line PEM — the #98 review finding.

const ZSH = "/bin/zsh";
const zsh_available = (() => {
  try {
    execFileSync(ZSH, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const temp_roots: string[] = [];

afterAll(() => {
  for (const dir of temp_roots) rmSync(dir, { recursive: true, force: true });
});

/** Vars the stub "node" reports back, base64-encoded so newlines survive. */
const REPORTED_KEYS = [
  "DISCORD_TOKEN",
  "QUOTED_DOUBLE",
  "QUOTED_SINGLE",
  "EMPTY_QUOTED",
  "WITH_EQUALS",
  "SPECIAL",
  "GITHUB_APP_PRIVATE_KEY",
  "TRAILING",
] as const;

interface WrapperRun {
  env: Record<string, string>;
  stderr: string;
  status: number | null;
}

/**
 * Run the generated wrapper against a canned `op inject` output.
 * Returns the environment the exec'd leaf actually received.
 *
 * `declared` is the key set `.env.op` declares. The wrapper reads it before
 * injection and uses it to tell an assignment from a continuation line, so it
 * is load-bearing, not scaffolding — tests that vary it are testing real
 * behaviour. Defaults to every key the stub node reports.
 */
function run_wrapper(injected: string, declared: readonly string[] = REPORTED_KEYS): WrapperRun {
  const root = mkdtempSync(join(tmpdir(), "lf-wrapper-"));
  temp_roots.push(root);

  const bin = join(root, "bin");
  const lf = join(root, ".lobsterfarm");
  mkdirSync(bin);
  mkdirSync(lf);

  // Stub `op`: ignores its args and prints the canned injection result.
  const injected_path = join(root, "injected.txt");
  writeFileSync(injected_path, injected);
  const op_stub = join(bin, "op");
  writeFileSync(op_stub, `#!/bin/zsh\ncat ${JSON.stringify(injected_path)}\n`);
  chmodSync(op_stub, 0o755);

  // Stub "node": reports the vars it was exec'd with, base64 so newlines survive.
  const node_stub = join(bin, "fake-node");
  writeFileSync(
    node_stub,
    [
      "#!/bin/zsh",
      `for k in ${REPORTED_KEYS.join(" ")}; do`,
      `  printf '%s %s\\n' "$k" "$(printf '%s' "\${(P)k}" | base64 | tr -d '\\n')"`,
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(node_stub, 0o755);

  // env.sh only has to put the stub `op` on PATH.
  writeFileSync(join(lf, "env.sh"), `export PATH=${JSON.stringify(bin)}:$PATH\n`);
  // The real template: op:// references, never values. The wrapper parses this
  // for its declared-key set. The stub `op` ignores it and prints `injected`.
  writeFileSync(
    join(lf, ".env.op"),
    `${declared.map((k) => `${k}=op://vault/item/${k.toLowerCase()}`).join("\n")}\n`,
  );

  const wrapper = join(root, "start-daemon.sh");
  writeFileSync(wrapper, generate_wrapper_sh(node_stub, join(root, "index.js"), root));
  chmodSync(wrapper, 0o755);

  const proc = spawnSync(ZSH, [wrapper], { encoding: "utf-8" });
  const env: Record<string, string> = {};
  for (const line of (proc.stdout ?? "").split("\n")) {
    const [key, b64] = line.split(" ");
    if (key) env[key] = Buffer.from(b64 ?? "", "base64").toString("utf-8");
  }
  return { env, stderr: proc.stderr ?? "", status: proc.status };
}

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAtest+line/with=padding",
  "AbCdEf==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe.skipIf(!zsh_available)("generate_wrapper_sh secret injection (zsh)", () => {
  const well_formed = [
    "# a comment line",
    "",
    "DISCORD_TOKEN=plain-token-value",
    'QUOTED_DOUBLE="double quoted"',
    "QUOTED_SINGLE='single quoted'",
    'EMPTY_QUOTED=""',
    "WITH_EQUALS=a=b=c",
    // Would execute under `eval`, and would be mangled by naive quote handling.
    'SPECIAL=$(echo pwned)`whoami`"stray',
    `GITHUB_APP_PRIVATE_KEY="${PEM}"`,
    "TRAILING=after-the-pem",
    "",
  ].join("\n");

  it("round-trips a quoted multi-line PEM byte-for-byte (#98 review finding)", () => {
    const { env, stderr } = run_wrapper(well_formed);

    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
    // And it must not swallow the assignment that follows the PEM.
    expect(env.TRAILING).toBe("after-the-pem");
    expect(stderr).not.toContain("WARNING");
  });

  it("strips surrounding quotes and preserves values verbatim", () => {
    const { env } = run_wrapper(well_formed);

    expect(env.DISCORD_TOKEN).toBe("plain-token-value");
    expect(env.QUOTED_DOUBLE).toBe("double quoted");
    expect(env.QUOTED_SINGLE).toBe("single quoted");
    expect(env.EMPTY_QUOTED).toBe("");
    // Only the first `=` separates key from value.
    expect(env.WITH_EQUALS).toBe("a=b=c");
  });

  it("never expands or executes shell metacharacters in a secret value", () => {
    const { env } = run_wrapper(well_formed);

    expect(env.SPECIAL).toBe('$(echo pwned)`whoami`"stray');
    expect(env.SPECIAL).not.toContain("pwned\n");
  });

  it("drops (not truncates) an unquoted multi-line value and warns", () => {
    // The exact shape `op inject` emits when .env.op forgets the quotes.
    const unquoted = ["DISCORD_TOKEN=still-fine", `GITHUB_APP_PRIVATE_KEY=${PEM}`, ""].join("\n");

    const { env, stderr } = run_wrapper(unquoted);

    // A truncated PEM is worse than an absent one: it fails deep inside GitHub
    // App auth instead of at startup. Absent + loud is the contract.
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe("");
    expect(stderr).toContain("WARNING");
    expect(stderr).toContain("multi-line secrets must be quoted in .env.op");
    // Unrelated keys still load.
    expect(env.DISCORD_TOKEN).toBe("still-fine");
  });

  it("warns on an unterminated quote without exporting a partial value", () => {
    const truncated = [
      'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
      "MIIEow",
      "",
    ].join("\n");

    const { env, stderr } = run_wrapper(truncated);

    expect(env.GITHUB_APP_PRIVATE_KEY).toBe("");
    expect(stderr).toContain("unterminated quote");
  });

  it("never echoes secret material in its warnings", () => {
    const unquoted = [`GITHUB_APP_PRIVATE_KEY=${PEM}`, ""].join("\n");

    const { stderr } = run_wrapper(unquoted);

    // daemon.log is world-readable-ish and long-lived — key names only.
    expect(stderr).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(stderr).not.toContain("MIIEow");
    expect(stderr).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("still exec's node as the leaf after injection", () => {
    const { status } = run_wrapper("DISCORD_TOKEN=plain-token-value\n");

    expect(status).toBe(0);
  });

  // PR #98 review round 2. The earlier parser decided "is this a new key?" from
  // line shape alone, so a PEM body line that happens to be identifier-shaped
  // (`AbCdEf==` → key `AbCdEf`) was accepted as an assignment and flushed the
  // buffered value — exporting a TRUNCATED GITHUB_APP_PRIVATE_KEY, the exact
  // failure the drop-and-warn path exists to prevent. The original PEM fixture
  // missed it only because its `=` line also contained `+` and `/`, which fail
  // the identifier regex. These pin the shapes that actually bite.
  describe("identifier-shaped PEM body lines (review round 2)", () => {
    it("does not export a truncated key when the PEM body looks like an assignment", () => {
      const unquoted = [
        "GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----",
        "AbCdEf==", // <- identifier-shaped: the whole bug
        "-----END RSA PRIVATE KEY-----",
        "DISCORD_TOKEN=still-fine",
        "",
      ].join("\n");

      const { env, stderr } = run_wrapper(unquoted);

      expect(env.GITHUB_APP_PRIVATE_KEY).toBe("");
      // And it must not invent a key from the base64 line either.
      expect(stderr).toContain("GITHUB_APP_PRIVATE_KEY");
      expect(stderr).not.toContain("AbCdEf");
      expect(env.DISCORD_TOKEN).toBe("still-fine");
    });

    it("treats an undeclared identifier-shaped line as a continuation, not a key", () => {
      // `SPECIAL` is declared; `NOT_DECLARED` is not. Only the declared one may
      // open an assignment — this is the property that removes the ambiguity.
      const injected = ["SPECIAL=first", "NOT_DECLARED=second", ""].join("\n");

      const { env, stderr } = run_wrapper(injected, ["SPECIAL"]);

      expect(env.SPECIAL).toBe("");
      expect(stderr).toContain("SPECIAL");
    });

    it("still exports a declared key whose value contains = padding", () => {
      // The guard must not over-correct: a legitimate single-line base64-ish
      // value is still a value.
      const { env, stderr } = run_wrapper("DISCORD_TOKEN=AbCdEf==\n");

      expect(env.DISCORD_TOKEN).toBe("AbCdEf==");
      expect(stderr).not.toContain("WARNING");
    });

    it("round-trips a quoted PEM whose body is identifier-shaped", () => {
      const pem = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "AbCdEf==",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");
      const { env, stderr } = run_wrapper(
        [`GITHUB_APP_PRIVATE_KEY="${pem}"`, "TRAILING=after", ""].join("\n"),
      );

      expect(env.GITHUB_APP_PRIVATE_KEY).toBe(pem);
      expect(env.TRAILING).toBe("after");
      expect(stderr).not.toContain("WARNING");
    });
  });

  it("tolerates a CRLF-saved .env.op without baking \\r into values", () => {
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEow", "-----END RSA PRIVATE KEY-----"].join(
      "\r\n",
    );
    const injected = [
      "DISCORD_TOKEN=plain-token-value",
      `GITHUB_APP_PRIVATE_KEY="${pem}"`,
      "",
    ].join("\r\n");

    const { env, stderr } = run_wrapper(injected);

    // A trailing \r used to ride silently into every value.
    expect(env.DISCORD_TOKEN).toBe("plain-token-value");
    expect(env.GITHUB_APP_PRIVATE_KEY).not.toContain("\r");
    expect(env.GITHUB_APP_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");
    expect(env.GITHUB_APP_PRIVATE_KEY).toContain("END RSA PRIVATE KEY");
    expect(stderr).not.toContain("WARNING");
  });

  it("skips injection with a warning when .env.op declares no keys", () => {
    const { env, stderr } = run_wrapper("DISCORD_TOKEN=ignored\n", []);

    expect(env.DISCORD_TOKEN).toBe("");
    expect(stderr).toContain("declares no KEY=value entries");
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
