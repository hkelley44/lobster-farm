/**
 * End-to-end broker inbound delivery (the test that would have caught the
 * --channels routing bug).
 *
 * The existing broker tests stop at the queue boundary: they spy on
 * `broker.feed()` and assert the enqueue happened, mocking everything
 * downstream. That left the actual delivery contract unexercised — and the
 * contract is where the pilot died: the Claude CLI only routes a server's
 * `notifications/claude/channel` notifications into the session when that
 * server is named in its `--channels` list (tagged `server:<key>` for
 * mcp-config servers). A broker session launched without
 * `--channels server:plugin_discord_discord` had every inbound received and
 * then dropped by the CLI ("Channel notifications skipped: server
 * plugin_discord_discord not in --channels list for this session"), acked by
 * the shim (its notification write succeeded), and permanently deleted from
 * the durable queue — cold-started sessions idled as 60s zombies while the
 * queue file sat empty, looking as if nothing was ever enqueued.
 *
 * This suite runs the real chain with NO delivery mocks:
 *
 *   inbound PendingMessage → pool.assign() → REAL start_tmux arg assembly
 *   → REAL DiscordBroker (durable queue + unix-socket server)
 *   → the REAL shim binary (built from src/shim/discord-shim.ts) spawned as a
 *     child process, exactly as the CLI would spawn it from broker-mcp.json
 *   → a fake Claude CLI: an MCP stdio client that replicates the real CLI's
 *     channel-routing gate — it only accepts `notifications/claude/channel`
 *     from servers tagged `server:<key>` / `plugin:<name>@<marketplace>` in
 *     the assembled command's --channels list.
 *
 * Only tmux itself is faked (a tmux server can't run in CI); the command
 * string it would have executed is captured and drives the fake CLI, so the
 * `--channels` args under test are the production ones, byte for byte.
 *
 * Against the pre-fix code the driven-first-turn test fails exactly like the
 * live zombie: the notification arrives at the CLI gate, is dropped, the shim
 * acks, the queue drains to empty, and no first turn ever runs.
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

// ── Fake Claude CLI: the real CLI's channel-routing gate ──
//
// Replicates the CLI's tagged --channels parser and matcher (observed in
// v2.1.220): entries must be `plugin:<name>@<marketplace>` or `server:<name>`;
// a channel notification from MCP server <key> is routed IFF a server-kind
// entry's name equals <key>. Untagged entries are rejected by the real CLI.
interface ChannelEntry {
  kind: "server" | "plugin";
  name: string;
  marketplace?: string;
}

function parse_channels_entries(tokens: string[]): ChannelEntry[] {
  const entries: ChannelEntry[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== "--channels") continue;
    for (const v of tokens[i + 1]!.split(",")) {
      if (v.startsWith("plugin:")) {
        const rest = v.slice(7);
        const at = rest.indexOf("@");
        if (at > 0 && at < rest.length - 1) {
          entries.push({
            kind: "plugin",
            name: rest.slice(0, at),
            marketplace: rest.slice(at + 1),
          });
        }
      } else if (v.startsWith("server:") && v.length > 7) {
        entries.push({ kind: "server", name: v.slice(7) });
      }
    }
  }
  return entries;
}

function cli_routes_channel(server_key: string, entries: ChannelEntry[]): boolean {
  // Server-kind entries match on the exact MCP server key. Plugin-kind entries
  // match `plugin:<name>` server ids, which an mcp-config key never is.
  return entries.some((e) => e.kind === "server" && e.name === server_key);
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

      // The real CLI's routing gate, driven by the real --channels args.
      const channel_entries = parse_channels_entries(tokens);
      const routed = cli_routes_channel(SHIM_MCP_SERVER_KEY, channel_entries);

      let driven_turn: { content: string; meta: InboundMeta } | null = null;
      let skipped = 0;

      client = new Client({ name: "fake-claude-cli", version: "1.0.0" }, { capabilities: {} });
      client.fallbackNotificationHandler = (notification) => {
        if (notification.method === "notifications/claude/channel") {
          if (routed) {
            driven_turn = notification.params as unknown as { content: string; meta: InboundMeta };
          } else {
            // The real CLI: "Channel notifications skipped: server <key> not in
            // --channels list for this session" — the message is dropped here.
            skipped += 1;
          }
        }
        return Promise.resolve();
      };

      // Spawn the REAL shim the way the CLI would: the mcp-config server def's
      // env (LF_BROKER_SOCKET/CHANNEL/BOT_ID) against the built shim bundle.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SHIM_PATH],
        env: { ...(process.env as Record<string, string>), ...server_def!.env },
        stderr: "pipe",
      });
      await client.connect(transport);

      // ── Assert 2: the queued message #1 drives the session's first turn.
      // Pre-fix this times out exactly like the live zombie: the shim delivers,
      // the CLI gate drops it (skipped > 0), the shim acks, and no turn runs.
      await poll_until(
        () => driven_turn !== null,
        10_000,
        () =>
          `driven first turn (CLI gate dropped ${String(skipped)} notification(s) — idle-zombie)`,
      );
      expect(driven_turn!.content).toBe("hello broker pilot");
      expect(driven_turn!.meta).toMatchObject({
        chat_id: PILOT_CHANNEL,
        message_id: "m-e2e-1",
        user: "hunter",
      });
      expect(skipped).toBe(0);

      // ── Assert 3: the shim's ack empties the durable queue — delivered
      // exactly once, nothing stranded for redelivery.
      await poll_until(() => broker.queue_depth(PILOT_CHANNEL) === 0, 5_000, "queue drain on ack");
    } finally {
      await client?.close().catch(() => {});
      await broker.stop().catch(() => {});
    }
  }, 30_000);

  it("broker transport args register the shim for channel routing (--channels server:<key>)", async () => {
    const config = make_config(true);
    const pool = new TestPool(config);
    const broker = make_broker(config);
    await broker.start();
    pool.set_broker(broker);
    try {
      await assign_pilot(pool);
      const tokens = tokenize(latest_tmux_command());
      const entries = parse_channels_entries(tokens);
      // The precise regression: without a server-kind entry naming the shim's
      // MCP server key, the CLI skips every inbound channel notification.
      expect(cli_routes_channel(SHIM_MCP_SERVER_KEY, entries)).toBe(true);
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
  });
});
