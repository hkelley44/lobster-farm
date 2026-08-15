/**
 * End-to-end broker inbound delivery (the test that would have caught the
 * CLI channel-routing bugs).
 *
 * The existing broker tests stop at the queue boundary: they spy on
 * `broker.feed()` and assert the enqueue happened, mocking everything
 * downstream. That left the actual delivery contract unexercised — and the
 * contract is where the pilot died, TWICE, in the same shape (message
 * enqueued, delivered, silently discarded by the CLI, acked by the shim,
 * permanently deleted from the durable queue; cold-started session idles as a
 * 60s zombie while the empty queue file makes it look like nothing was ever
 * enqueued):
 *
 *   #112 — the shim server wasn't named in `--channels` at all
 *     ("Channel notifications skipped: … not in --channels list").
 *   #114 — a `server:` entry additionally needs the CLI's dev marker, which
 *     only `--dangerously-load-development-channels` confers
 *     ("… not on the approved channels allowlist"); AND even with both gates
 *     passed, a delivery during CLI boot lands before the client attaches its
 *     channel handler and is black-holed (the handler-attach race the shim's
 *     registration grace now avoids).
 *
 * This suite runs the real chain with NO delivery mocks:
 *
 *   inbound PendingMessage → pool.assign() → REAL start_tmux arg assembly
 *   → REAL DiscordBroker (durable queue + unix-socket server)
 *   → the REAL shim binary (built from src/shim/discord-shim.ts) spawned as a
 *     child process, exactly as the CLI would spawn it from broker-mcp.json
 *   → a fake Claude CLI: an MCP stdio client that replicates the real CLI's
 *     channel-routing gates and handler-attach timing (see the model notes
 *     at `parse_channel_registry` / `cli_routes_channel` below — a BEST-EFFORT
 *     model of closed-source behavior; the live pilot is the source of truth).
 *
 * Only tmux itself is faked (a tmux server can't run in CI); the command
 * string it would have executed is captured and drives the fake CLI, so the
 * transport args under test are the production ones, byte for byte.
 *
 * Against the pre-fix code the driven-first-turn test fails exactly like the
 * live zombie: the notification is dropped (by a gate or by the pre-attach
 * window), the shim acks, the queue drains to empty, and no first turn runs.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── child_process: fake ONLY tmux ──
//
// Everything else must stay real — the MCP StdioClientTransport spawns the
// shim through this module, and the test builds the shim with tsup through it.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const tmux_spawns: unknown[][] = [];
  const fake_tmux_proc = () => ({
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      if (ev === "close") setTimeout(() => cb(0), 0);
      return undefined;
    },
  });
  return {
    ...actual,
    __tmux_spawns: tmux_spawns,
    spawn: ((cmd: string, args?: unknown, opts?: unknown) => {
      if (cmd === "tmux") {
        tmux_spawns.push([cmd, args, opts]);
        return fake_tmux_proc();
      }
      return (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, opts);
    }) as typeof actual.spawn,
    execFileSync: ((cmd: string, ...rest: unknown[]) => {
      if (cmd === "tmux") return "";
      return (actual.execFileSync as (...a: unknown[]) => unknown)(cmd, ...rest);
    }) as typeof actual.execFileSync,
  };
});

import * as child_process from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DiscordBroker } from "../broker/index.js";
import { SHIM_MCP_SERVER_KEY } from "../broker/protocol.js";
import type { InboundMeta } from "../broker/protocol.js";
import { BotPool, type PendingMessage, type PoolBot } from "../pool.js";

const tmux_spawns = (child_process as unknown as { __tmux_spawns: unknown[][] }).__tmux_spawns;

// ── Shim build (once per suite) ──
//
// The shim ships as TS source; the daemon build bundles it to dist via tsup.
// Tests must not depend on a prior `pnpm build`, so we bundle the shim entry
// ourselves with the same tool. The output lives under the package's
// node_modules/.cache so `@modelcontextprotocol/sdk` resolves from the built
// file exactly as it does from dist/shim/.
const PKG_ROOT = join(import.meta.dirname, "..", "..");
const SHIM_OUT_DIR = join(PKG_ROOT, "node_modules", ".cache", "lf-shim-e2e");
const SHIM_PATH = join(SHIM_OUT_DIR, "discord-shim.js");

function build_shim(): void {
  const actual = child_process as unknown as typeof import("node:child_process");
  actual.execFileSync(
    join(PKG_ROOT, "node_modules", ".bin", "tsup"),
    [
      join(PKG_ROOT, "src", "shim", "discord-shim.ts"),
      "--no-config",
      "--format",
      "esm",
      "--out-dir",
      SHIM_OUT_DIR,
      "--silent",
    ],
    { cwd: PKG_ROOT, stdio: "pipe" },
  );
}

// ── Fake Claude CLI: the real CLI's channel-routing gates ──
//
// !! BEST-EFFORT MODEL OF CLOSED-SOURCE BEHAVIOR !!
// This models the routing logic observed in CLI v2.1.220 (extracted from the
// binary and confirmed against live MCP logs). The real CLI can change without
// notice, and this model has already missed a gate once (#114 shipped because
// the model knew gate 1 but not gate 2). Treat the LIVE broker pilot as the
// source of truth; when the pilot and this model disagree, the model is wrong
// and must be updated from the CLI's own logs
// (~/Library/Caches/claude-cli-nodejs/<proj>/mcp-logs-*/…).
//
// Modeled behavior (all observed in v2.1.220):
//
//   Parsing: `--channels <entries…>` and
//   `--dangerously-load-development-channels <entries…>` each take tagged
//   entries — `plugin:<name>@<marketplace>` or `server:<name>`; untagged
//   entries are rejected. The dev-flag entries are appended AFTER the
//   --channels entries (post startup-dialog acceptance) and are stamped
//   `dev: true`; --channels entries are not.
//
//   Gate 1 (#112): a notification from MCP server <key> must match an entry —
//   first-match-wins `.find()`: server-kind entries match on the exact key.
//   No match → "Channel notifications skipped: server <key> not in --channels
//   list for this session".
//
//   Gate 2 (#114): the MATCHED entry, if server-kind, must be `dev: true` —
//   i.e. it must have come from the dev flag. Otherwise → "Channel
//   notifications skipped: server <key> is not on the approved channels
//   allowlist (use --dangerously-load-development-channels for local dev)".
//   First-match-wins makes this order-sensitive: a non-dev `--channels
//   server:<key>` entry SHADOWS a dev entry for the same key and re-fails
//   gate 2, which is why pool.ts must pass the server entry via the dev flag
//   ONLY.
//
//   Handler-attach window (#114): the CLI attaches its channel-notification
//   handler shortly AFTER the MCP connection completes ("Channel
//   notifications registered" ~16ms after "Successfully connected"). A
//   notification arriving before the attach is silently dropped — modeled
//   here as a dead window after client.connect() during which channel
//   notifications are discarded, exactly the boot race that black-holed
//   msg#1 even with both gates passing.
interface ChannelEntry {
  kind: "server" | "plugin";
  name: string;
  marketplace?: string;
  /** True only for entries passed via --dangerously-load-development-channels. */
  dev: boolean;
}

/** Parse one flag's tagged entry list from the tokenized command. */
function parse_tagged_entries(tokens: string[], flag: string, dev: boolean): ChannelEntry[] {
  const entries: ChannelEntry[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== flag) continue;
    for (const v of tokens[i + 1]!.split(",")) {
      if (v.startsWith("plugin:")) {
        const rest = v.slice(7);
        const at = rest.indexOf("@");
        if (at > 0 && at < rest.length - 1) {
          entries.push({
            kind: "plugin",
            name: rest.slice(0, at),
            marketplace: rest.slice(at + 1),
            dev,
          });
        }
      } else if (v.startsWith("server:") && v.length > 7) {
        entries.push({ kind: "server", name: v.slice(7), dev });
      }
    }
  }
  return entries;
}

/** The session's channel-entry registry in CLI order: --channels entries
 * first, dev-flag entries appended after (the CLI appends them when the
 * startup dialog is accepted). */
function parse_channel_registry(tokens: string[]): ChannelEntry[] {
  return [
    ...parse_tagged_entries(tokens, "--channels", false),
    ...parse_tagged_entries(tokens, "--dangerously-load-development-channels", true),
  ];
}

/** Both gates, first-match-wins — mirrors the CLI's routing decision for a
 * notification from MCP server `server_key`. */
function cli_routes_channel(server_key: string, entries: ChannelEntry[]): boolean {
  const matched = entries.find((e) =>
    e.kind === "server" ? e.name === server_key : `plugin:${e.name}` === server_key,
  );
  if (!matched) return false; // gate 1: not in --channels list
  if (matched.kind === "server" && !matched.dev) return false; // gate 2: not on approved allowlist
  return true;
}

/** Tokenize the tmux command string, honoring sq()'s single-quoting. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let in_quote = false;
  let has_token = false;
  for (const c of cmd) {
    if (in_quote) {
      if (c === "'") in_quote = false;
      else cur += c;
    } else if (c === "'") {
      in_quote = true;
      has_token = true;
    } else if (c === " ") {
      if (has_token || cur.length > 0) tokens.push(cur);
      cur = "";
      has_token = false;
    } else {
      cur += c;
      has_token = true;
    }
  }
  if (has_token || cur.length > 0) tokens.push(cur);
  return tokens;
}

function flag_value(tokens: string[], flag: string): string | undefined {
  const i = tokens.indexOf(flag);
  return i >= 0 ? tokens[i + 1] : undefined;
}

/** The claude command string of the latest captured tmux new-session. */
function latest_tmux_command(): string {
  expect(tmux_spawns.length).toBeGreaterThan(0);
  const args = tmux_spawns[tmux_spawns.length - 1]![1] as string[];
  return args[args.length - 1]!;
}

// ── Pool test double: real assign()/start_tmux, stubbed environment I/O ──

function make_bot(id: number, state_dir: string, tmux_session: string): PoolBot {
  return {
    id,
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: false,
    tmux_session,
    last_active: null,
    assigned_at: null,
    state_dir,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
  };
}

class TestPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  protected override check_session_jsonl_exists_anywhere(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override check_session_jsonl_exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override watch_session_confirmation(bot: PoolBot): void {
    bot.session_confirmed = true;
  }
  protected override is_tmux_alive(): boolean {
    return true;
  }
  protected override async write_access_json(): Promise<void> {}
  protected override async set_bot_nickname(): Promise<void> {}
  protected override async set_bot_avatar(): Promise<void> {}
  protected override async ensure_entity_channels_allowlisted(): Promise<void> {}
  protected override kill_tmux(): void {}
  protected override async persist(): Promise<void> {}
  // Keep the shim's mcp-config free of this machine's real global servers so
  // the fake CLI only ever has to speak to the shim.
  protected override read_global_mcp_servers(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
}

// ── Fixtures ──

const PILOT_CHANNEL = "chan-broker-e2e";
const PLUGIN_CHANNEL = "chan-plugin-e2e";

const PENDING: PendingMessage = {
  user: "hunter",
  channel_id: PILOT_CHANNEL,
  message_id: "m-e2e-1",
  content: "hello broker pilot",
  ts: "2026-08-13T10:00:00.000Z",
};

let dir: string;
let run_id: string;

function make_config(broker_enabled: boolean): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: dir },
    discord: {
      server_id: "guild-1",
      broker: { enabled: broker_enabled, pilot_channels: [PILOT_CHANNEL] },
    },
  });
}

function make_broker(config: LobsterFarmConfig): DiscordBroker {
  return new DiscordBroker({
    config,
    // Unix socket paths are length-limited (~104 bytes on macOS) — keep it
    // short and unique rather than nesting under the (long) test dir.
    socket_path: join(tmpdir(), `lf-e2e-${run_id}.sock`),
    queue_path: join(dir, "broker-queue.json"),
    // Tight redelivery so a raced first delivery re-lands within the test
    // window instead of the production 30s.
    redeliver_after_ms: 500,
    sweep_interval_ms: 250,
  });
}

async function assign_pilot(pool: TestPool): Promise<{ state_dir: string }> {
  const state_dir = join(dir, "bot-state");
  await mkdir(state_dir, { recursive: true });
  pool.inject_bots([make_bot(9, state_dir, `lf-e2e-${run_id}`)]);
  const assignment = await pool.assign(
    PILOT_CHANNEL,
    "entity-1",
    "planner",
    undefined,
    undefined,
    undefined,
    PENDING,
  );
  expect(assignment).not.toBeNull();
  return { state_dir };
}

async function poll_until(
  cond: () => boolean,
  timeout_ms: number,
  label: string | (() => string),
): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${typeof label === "function" ? label() : label}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(() => {
  build_shim();
}, 120_000);

afterAll(async () => {
  await rm(SHIM_OUT_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  tmux_spawns.length = 0;
  run_id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  dir = join(tmpdir(), `broker-e2e-${run_id}`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await rm(`/tmp/lf-pending-lf-e2e-${run_id}.json`, { force: true }).catch(() => {});
});

describe("broker end-to-end inbound delivery (inbound → queue → shim → session first turn)", () => {
  it("delivers a broker channel's inbound as the cold-started session's driven first turn (no zombie)", async () => {
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = make_broker(config);
    await broker.start();
    pool.set_broker(broker);

    let client: Client | null = null;
    try {
      // ── Inbound arrives: handle_message's cold-start calls assign() with the
      // message as the driver (the #107 contract).
      await assign_pilot(pool);
      expect(pool.broker_owns(PILOT_CHANNEL)).toBe(true);

      // ── Assert 1: the message is enqueued in the durable broker queue BEFORE
      // any session exists to receive it.
      expect(broker.queue_depth(PILOT_CHANNEL)).toBe(1);

      // ── Assemble the fake CLI from the REAL command start_tmux built.
      const tokens = tokenize(latest_tmux_command());
      const mcp_config_path = flag_value(tokens, "--mcp-config");
      expect(mcp_config_path).toBeDefined();
      expect(tokens).toContain("--strict-mcp-config");

      const mcp_config = JSON.parse(await readFile(mcp_config_path!, "utf-8")) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      const server_def = mcp_config.mcpServers[SHIM_MCP_SERVER_KEY];
      expect(server_def).toBeDefined();

      // The real CLI's routing gates (1: entry match, 2: dev marker), driven by
      // the real --channels / --dangerously-load-development-channels args.
      const channel_entries = parse_channel_registry(tokens);
      const routed = cli_routes_channel(SHIM_MCP_SERVER_KEY, channel_entries);

      let driven_turn: { content: string; meta: InboundMeta } | null = null;
      let skipped = 0;
      let dropped_pre_attach = 0;
      // Models the CLI's handler-attach window (#114): the channel handler is
      // attached shortly AFTER the MCP connection completes; notifications
      // arriving before that are silently dropped. Real gap ≈ 16ms; we use
      // 150ms so the model is meaningfully stricter than the real CLI while
      // the shim's (test-shortened) registration grace stays well above it.
      let handler_attached = false;
      const HANDLER_ATTACH_DELAY_MS = 150;

      client = new Client({ name: "fake-claude-cli", version: "1.0.0" }, { capabilities: {} });
      client.fallbackNotificationHandler = (notification) => {
        if (notification.method === "notifications/claude/channel") {
          if (!handler_attached) {
            // The boot black hole: accepted by no handler, seen by nobody.
            dropped_pre_attach += 1;
          } else if (routed) {
            driven_turn = notification.params as unknown as { content: string; meta: InboundMeta };
          } else {
            // The real CLI: "Channel notifications skipped: …" (gate 1 or 2) —
            // the message is dropped here.
            skipped += 1;
          }
        }
        return Promise.resolve();
      };

      // Spawn the REAL shim the way the CLI would: the mcp-config server def's
      // env (LF_BROKER_SOCKET/CHANNEL/BOT_ID) against the built shim bundle.
      // LF_BROKER_REGISTER_GRACE_MS shortens the shim's post-initialize
      // registration grace (prod default 3s) to keep the suite fast while
      // preserving the invariant under test: grace > handler-attach gap.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SHIM_PATH],
        env: {
          ...(process.env as Record<string, string>),
          ...server_def!.env,
          LF_BROKER_REGISTER_GRACE_MS: "600",
        },
        stderr: "pipe",
      });
      await client.connect(transport);
      setTimeout(() => {
        handler_attached = true;
      }, HANDLER_ATTACH_DELAY_MS);

      // ── Assert 2: the queued message #1 drives the session's first turn.
      // Pre-fix this times out exactly like the live zombie, for either root
      // cause: a gate rejection (skipped > 0 — #112 gate 1 / #114 gate 2) or a
      // premature delivery swallowed by the handler-attach window
      // (dropped_pre_attach > 0 — #114 boot race). Either way the shim acks
      // and no turn ever runs.
      await poll_until(
        () => driven_turn !== null,
        10_000,
        () =>
          `driven first turn (CLI gates dropped ${String(skipped)}, pre-attach window swallowed ${String(dropped_pre_attach)} — idle-zombie)`,
      );
      expect(driven_turn!.content).toBe("hello broker pilot");
      expect(driven_turn!.meta).toMatchObject({
        chat_id: PILOT_CHANNEL,
        message_id: "m-e2e-1",
        user: "hunter",
      });
      expect(skipped).toBe(0);
      expect(dropped_pre_attach).toBe(0);

      // ── Assert 3: the shim's ack empties the durable queue — delivered
      // exactly once, nothing stranded for redelivery.
      await poll_until(() => broker.queue_depth(PILOT_CHANNEL) === 0, 5_000, "queue drain on ack");
    } finally {
      await client?.close().catch(() => {});
      await broker.stop().catch(() => {});
    }
  }, 30_000);

  it("malformed LF_BROKER_REGISTER_GRACE_MS falls back to the safe default (no graceless collapse)", async () => {
    // Regression for the parse guard: an unguarded parseInt("bogus") → NaN,
    // and setTimeout(fn, NaN) fires at ~1ms — silently reverting the shim to
    // immediate registration and the exact pre-attach boot race the grace
    // exists to prevent. With the guard, a bogus value falls back to the 3s
    // production default, so delivery still lands AFTER the fake CLI's
    // handler-attach window and the first turn runs (this test just takes ~3s
    // instead of ~600ms).
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = make_broker(config);
    await broker.start();
    pool.set_broker(broker);

    let client: Client | null = null;
    try {
      await assign_pilot(pool);
      const tokens = tokenize(latest_tmux_command());
      const mcp_config = JSON.parse(
        await readFile(flag_value(tokens, "--mcp-config")!, "utf-8"),
      ) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      const server_def = mcp_config.mcpServers[SHIM_MCP_SERVER_KEY];
      const routed = cli_routes_channel(SHIM_MCP_SERVER_KEY, parse_channel_registry(tokens));

      let driven_turn: { content: string } | null = null;
      let dropped_pre_attach = 0;
      let handler_attached = false;

      client = new Client({ name: "fake-claude-cli", version: "1.0.0" }, { capabilities: {} });
      client.fallbackNotificationHandler = (notification) => {
        if (notification.method === "notifications/claude/channel") {
          if (!handler_attached) dropped_pre_attach += 1;
          else if (routed) driven_turn = notification.params as unknown as { content: string };
        }
        return Promise.resolve();
      };

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SHIM_PATH],
        env: {
          ...(process.env as Record<string, string>),
          ...server_def!.env,
          LF_BROKER_REGISTER_GRACE_MS: "not-a-number",
        },
        stderr: "pipe",
      });
      await client.connect(transport);
      setTimeout(() => {
        handler_attached = true;
      }, 150);

      await poll_until(
        () => driven_turn !== null,
        10_000,
        () =>
          `driven first turn under bogus grace env (pre-attach window swallowed ${String(dropped_pre_attach)} — NaN collapsed the grace)`,
      );
      expect(driven_turn!.content).toBe("hello broker pilot");
      expect(dropped_pre_attach).toBe(0);
    } finally {
      await client?.close().catch(() => {});
      await broker.stop().catch(() => {});
    }
  }, 30_000);

  it("broker transport args clear BOTH CLI gates (dev-flagged server entry, no shadowing)", async () => {
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = make_broker(config);
    await broker.start();
    pool.set_broker(broker);
    try {
      await assign_pilot(pool);
      const tokens = tokenize(latest_tmux_command());
      const entries = parse_channel_registry(tokens);
      // The precise regressions:
      //   #112 (gate 1): no entry naming the shim's MCP server key at all →
      //     every inbound skipped ("not in --channels list").
      //   #114 (gate 2): entry present but via --channels (no dev marker) →
      //     every inbound skipped ("not on the approved channels allowlist").
      expect(cli_routes_channel(SHIM_MCP_SERVER_KEY, entries)).toBe(true);
      // Shadowing guard: the CLI matches first-wins, and --channels entries
      // precede dev-flag entries — a duplicate non-dev `--channels server:<key>`
      // would shadow the dev entry and re-fail gate 2. The server entry must
      // ride the dev flag ONLY.
      const channels_only = parse_tagged_entries(tokens, "--channels", false);
      expect(channels_only.some((e) => e.kind === "server" && e.name === SHIM_MCP_SERVER_KEY)).toBe(
        false,
      );
      const dev_only = parse_tagged_entries(
        tokens,
        "--dangerously-load-development-channels",
        true,
      );
      expect(dev_only).toEqual([{ kind: "server", name: SHIM_MCP_SERVER_KEY, dev: true }]);
    } finally {
      await broker.stop().catch(() => {});
    }
  });

  it("plugin channels keep the exact official-plugin transport args (parity)", async () => {
    const config = make_config(true); // broker ON, but this channel is not a pilot
    const pool = new TestPool(config);
    const broker = make_broker(config);
    await broker.start();
    pool.set_broker(broker);
    try {
      const state_dir = join(dir, "bot-state");
      await mkdir(state_dir, { recursive: true });
      pool.inject_bots([make_bot(9, state_dir, `lf-e2e-${run_id}`)]);
      const assignment = await pool.assign(
        PLUGIN_CHANNEL,
        "entity-1",
        "planner",
        undefined,
        undefined,
        undefined,
        { ...PENDING, channel_id: PLUGIN_CHANNEL },
      );
      expect(assignment).not.toBeNull();

      const tokens = tokenize(latest_tmux_command());
      expect(flag_value(tokens, "--channels")).toBe("plugin:discord@claude-plugins-official");
      expect(tokens).not.toContain("--strict-mcp-config");
      expect(tokens).not.toContain("--mcp-config");
      expect(tokens).not.toContain("--dangerously-load-development-channels");
    } finally {
      await broker.stop().catch(() => {});
    }
  });

  it("flag OFF: pilot channel ids get the unchanged plugin transport args (byte parity)", async () => {
    const config = make_config(false);
    const pool = new TestPool(config);
    // No broker wired — mirrors index.ts skipping construction when disabled.
    const state_dir = join(dir, "bot-state");
    await mkdir(state_dir, { recursive: true });
    pool.inject_bots([make_bot(9, state_dir, `lf-e2e-${run_id}`)]);
    const assignment = await pool.assign(
      PILOT_CHANNEL,
      "entity-1",
      "planner",
      undefined,
      undefined,
      undefined,
      PENDING,
    );
    expect(assignment).not.toBeNull();

    const tokens = tokenize(latest_tmux_command());
    expect(flag_value(tokens, "--channels")).toBe("plugin:discord@claude-plugins-official");
    expect(tokens).not.toContain("--strict-mcp-config");
    expect(tokens).not.toContain("--mcp-config");
    expect(tokens).not.toContain("--dangerously-load-development-channels");
  });
});
