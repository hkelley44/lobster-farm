#!/usr/bin/env node
/**
 * Broker CLI testbed — the REAL `claude` CLI, the REAL shim, a stand-in broker.
 * No daemon, no Discord, no restart. (MEMORY's recipe, mechanised.)
 *
 * WHY THIS EXISTS
 * ---------------
 * The offline vitest harness (`src/__tests__/broker-cold-path-harness.test.ts`)
 * proves the daemon side: queue accounting, ordering, redelivery. It cannot
 * prove the one leg that has actually broken in production four times — whether
 * the closed-source CLI ROUTES a `notifications/claude/channel` that the shim
 * successfully wrote into the agent's turn, or silently discards it with
 * "Channel notifications skipped: …". #112, #113, #114 and #115 all lived
 * there, and every one was missed by a mock, because the shim acks its own
 * successful write and cannot see the CLI drop the message.
 *
 * This script closes that leg without a daemon and without Discord:
 *
 *   NDJSON broker stand-in  ⇄  REAL dist/shim/discord-shim.js  ⇄  REAL claude CLI
 *          (this file)              (unix socket, real protocol)      (in tmux)
 *
 * It uses the production transport args verbatim (pool.ts:4198-4207) and the
 * production MCP server key, so a CLI-version regression in either routing gate
 * shows up here as a FAIL rather than in a live pilot.
 *
 * WHAT IT PROVES / DOES NOT PROVE
 * -------------------------------
 * PROVES  the CLI accepts the shim as a channel source, routes the inbound into
 *         a turn, the agent gets the <channel …> block, and the agent's reply
 *         comes back out as a real `outbound_request` envelope on the socket —
 *         i.e. V1's "post → turn → reply" leg and V4's ordering leg, for the
 *         installed CLI version.
 * DOES NOT prove a daemon restart, pool assign/cold-recreate, that one tmux
 *         session exists rather than two, that a reply reached Discord, or that
 *         the session JSONL persisted. Those stay live-only.
 *
 * SAFETY
 * ------
 *   - Binds a unix socket under its own mkdtemp dir. Never port 7749, never
 *     ~/.lobsterfarm/state/broker.sock.
 *   - tmux session name is `lf-broker-testbed-<pid>`. It never touches `pat` or
 *     any `pool-N` session, and it kills only the session it created.
 *   - No Discord token is read and no REST call is made: the stand-in answers
 *     every outbound itself with the plugin's success string.
 *   - Reads nothing from ~/.lobsterfarm.
 *
 * COST: spawns a real `claude` session and runs 1-2 turns.
 *
 * USAGE
 *   node packages/daemon/scripts/broker-cli-testbed.mjs            # V1 leg: 1 message
 *   node packages/daemon/scripts/broker-cli-testbed.mjs --messages 2   # V4 leg: 2 rapid
 *   node packages/daemon/scripts/broker-cli-testbed.mjs --keep     # leave tmux up
 *
 * Exit 0 = every expectation met. Exit 1 = a real failure. Exit 2 = setup error
 * (CLI missing, shim not built, tmux missing) — NOT a verdict on the transport.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Production constants, mirrored. Keep in sync with broker/protocol.ts. ──
const SHIM_MCP_SERVER_KEY = "plugin_discord_discord";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = resolve(HERE, "..");
const SHIM_ENTRY = join(DAEMON_ROOT, "dist", "shim", "discord-shim.js");

// ── Args ──
const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
const MESSAGE_COUNT = Number.parseInt(opt("messages", "1"), 10);
const KEEP = flag("keep");
/** Reproduce production's two blind fixed-timer Enters instead of polling. */
const BLIND_DIALOG = flag("blind-dialog");
let dialog_timer = null;
const TURN_TIMEOUT_MS = Number.parseInt(opt("timeout", "180000"), 10);
const DIALOG_DELAY_MS = Number.parseInt(opt("dialog-delay", "6000"), 10);
const MODEL = opt("model", "claude-sonnet-4-5");
// A channel id that is NOT the real pilot channel — nothing here contacts
// Discord, and using a fake id makes that impossible to get wrong by accident.
const CHANNEL_ID = opt("channel", "999000000000000001");
const BOT_ID = opt("bot-id", "3");

const log = (...a) => console.log(`[testbed]`, ...a);
const fail_setup = (msg) => {
  console.error(`[testbed] SETUP ERROR: ${msg}`);
  process.exit(2);
};

// ── Pre-flight ──
if (!existsSync(SHIM_ENTRY)) {
  fail_setup(`shim bundle missing at ${SHIM_ENTRY} — run: pnpm --filter @lobster-farm/daemon build`);
}
const claude_bin = spawnSync("which", ["claude"], { encoding: "utf-8" }).stdout.trim();
if (!claude_bin) fail_setup("`claude` not on PATH");
if (!spawnSync("which", ["tmux"], { encoding: "utf-8" }).stdout.trim()) {
  fail_setup("`tmux` not on PATH");
}
const cli_version = spawnSync(claude_bin, ["--version"], { encoding: "utf-8" }).stdout.trim();

const dir = mkdtempSync(join(tmpdir(), "lf-broker-testbed-"));
const socket_path = join(dir, "testbed.sock");
const mcp_config_path = join(dir, "broker-mcp.json");
const workdir = join(dir, "work");
const tmux_session = `lf-broker-testbed-${String(process.pid)}`;

log(`CLI            ${cli_version}`);
log(`shim           ${SHIM_ENTRY}`);
log(`socket         ${socket_path}`);
log(`tmux session   ${tmux_session}`);
log(`messages       ${String(MESSAGE_COUNT)}`);

// ── The NDJSON broker stand-in ──
// Speaks the real protocol.ts envelope shapes. Intentionally hand-rolled rather
// than importing the daemon's BrokerServer: the point of this testbed is the
// CLI/shim leg, so the daemon side is kept trivially inspectable.

const observed = {
  registers: [],
  /** Inbound ids the shim acked, in order. */
  acks: [],
  /** Outbound tool calls the agent made, in order. */
  outbound: [],
};
let fed = [];
let shim_socket = null;

function encode(env) {
  return `${JSON.stringify(env)}\n`;
}

function feed_messages() {
  const now = new Date().toISOString();
  fed = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
    id: randomUUID(),
    ordinal: i + 1,
    content:
      MESSAGE_COUNT === 1
        ? "Testbed check. Reply with exactly: ACK-1"
        : `Testbed check ${String(i + 1)} of ${String(MESSAGE_COUNT)}. Reply with exactly: ACK-${String(i + 1)}`,
  }));
  for (const m of fed) {
    const env = {
      type: "inbound",
      payload: {
        id: m.id,
        content: m.content,
        meta: {
          chat_id: CHANNEL_ID,
          message_id: `tb-${String(m.ordinal)}`,
          user: "hunter",
          user_id: "999000000000000002",
          ts: now,
        },
      },
    };
    shim_socket.write(encode(env));
    log(`→ inbound #${String(m.ordinal)} id=${m.id.slice(0, 8)}`);
  }
}

const server = createServer((socket) => {
  socket.setEncoding("utf-8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let env;
      try {
        env = JSON.parse(line);
      } catch {
        log(`! malformed frame from shim: ${line.slice(0, 120)}`);
        continue;
      }
      handle(socket, env);
    }
  });
  socket.on("error", () => {});
});

function handle(socket, env) {
  switch (env.type) {
    case "register":
      shim_socket = socket;
      observed.registers.push({ at: Date.now(), channel_id: env.channel_id, bot_id: env.bot_id });
      log(`← register channel=${env.channel_id} bot=${String(env.bot_id)}`);
      // The shim registers only after the CLI's `initialized` + grace, which is
      // the signal that the client is past its MCP handshake. Feeding here is
      // exactly what the daemon's backlog flush does on register.
      feed_messages();
      break;
    case "ack":
      observed.acks.push(env.id);
      log(`← ack ${env.id.slice(0, 8)} (${String(observed.acks.length)}/${String(MESSAGE_COUNT)})`);
      break;
    case "outbound_request": {
      observed.outbound.push({ at: Date.now(), tool: env.tool, args: env.args });
      const text = typeof env.args?.text === "string" ? env.args.text : "";
      log(`← outbound ${env.tool}: ${JSON.stringify(text).slice(0, 120)}`);
      // Answer with the official plugin's success string shape, verbatim-ish, so
      // the agent sees a normal success and does not retry.
      socket.write(
        encode({
          type: "outbound_response",
          request_id: env.request_id,
          text: env.tool === "reply" ? "Message sent" : "ok",
          is_error: false,
        }),
      );
      break;
    }
    default:
      log(`← (ignored) ${String(env.type)}`);
  }
}

// ── MCP config: byte-for-byte the shape prepare_broker_session writes ──
writeFileSync(
  mcp_config_path,
  JSON.stringify(
    {
      mcpServers: {
        [SHIM_MCP_SERVER_KEY]: {
          command: process.execPath,
          args: [SHIM_ENTRY],
          env: {
            LF_BROKER_SOCKET: socket_path,
            LF_BROKER_CHANNEL: CHANNEL_ID,
            LF_BROKER_BOT_ID: BOT_ID,
          },
        },
      },
    },
    null,
    2,
  ),
  "utf-8",
);

function tmux(...args) {
  return spawnSync("tmux", args, { encoding: "utf-8" });
}

function capture_pane() {
  const r = tmux("capture-pane", "-p", "-t", tmux_session, "-S", "-200");
  return r.stdout ?? "";
}

/**
 * Poll the pane and press Enter whenever a confirm dialog is actually on
 * screen. This is #84 §3 P5's proposed fix, implemented here so the testbed's
 * verdict isn't contaminated by the blind-timer race. Bounded in both presses
 * and wall time so a wedged CLI can't loop forever.
 */
function answer_dialogs_by_polling() {
  let presses = 0;
  const deadline = Date.now() + 45_000;
  const timer = setInterval(() => {
    if (Date.now() > deadline || presses >= 4) {
      clearInterval(timer);
      if (presses === 0) log(`! no confirm dialog ever appeared on the pane`);
      return;
    }
    const pane = capture_pane();
    if (/Enter to confirm/.test(pane)) {
      presses += 1;
      const which = /development channels/i.test(pane) ? "dev-channels" : "trust";
      log(`polled Enter #${String(presses)} for the ${which} dialog`);
      const r = tmux("send-keys", "-t", tmux_session, "Enter");
      if (r.status !== 0) log(`! send-keys failed: ${r.stderr}`);
      return;
    }
    // Dialogs cleared and the prompt is up — nothing left to answer.
    if (/bypass permissions on/.test(pane)) {
      clearInterval(timer);
      log(`CLI reached its prompt after ${String(presses)} press(es)`);
    }
  }, 500);
  dialog_timer = timer;
}

function cleanup() {
  if (dialog_timer) clearInterval(dialog_timer);
  if (!KEEP) tmux("kill-session", "-t", tmux_session);
  try {
    server.close();
  } catch {}
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
}

/**
 * The CLI's own per-project MCP logs are the only place the two routing gates
 * announce themselves ("Channel notifications skipped: …"). Surfacing them is
 * the difference between "the turn didn't run" and "the turn didn't run BECAUSE
 * gate N rejected the server".
 */
function grep_cli_mcp_logs() {
  const cache = join(homedir(), "Library", "Caches", "claude-cli-nodejs");
  if (!existsSync(cache)) return [];
  const found = spawnSync(
    "bash",
    [
      "-lc",
      `find ${JSON.stringify(cache)} -type d -name 'mcp-logs-*' -newermt '-10 minutes' -print0 2>/dev/null | xargs -0 -I{} sh -c 'grep -lh "Channel notifications" {}/*.txt 2>/dev/null' | head -5`,
    ],
    { encoding: "utf-8" },
  );
  const files = (found.stdout ?? "").split("\n").filter(Boolean);
  const lines = [];
  for (const f of files) {
    const g = spawnSync("grep", ["-h", "Channel notifications", f], { encoding: "utf-8" });
    for (const l of (g.stdout ?? "").split("\n").filter(Boolean)) lines.push(`${f}: ${l.trim()}`);
  }
  return lines;
}

// ── Run ──
server.listen(socket_path, () => {
  log(`broker stand-in listening`);
  spawnSync("mkdir", ["-p", workdir]);

  // Production transport args, verbatim from pool.ts:4198-4207. The server entry
  // rides the dev flag ONLY — a duplicate `--channels server:<key>` would shadow
  // it and re-fail gate 2 (#114).
  const args = [
    "--mcp-config",
    mcp_config_path,
    "--strict-mcp-config",
    "--dangerously-load-development-channels",
    `server:${SHIM_MCP_SERVER_KEY}`,
    "--model",
    MODEL,
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    workdir,
  ];

  const cmd = [claude_bin, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const r = tmux("new-session", "-d", "-s", tmux_session, "-c", workdir, cmd);
  if (r.status !== 0) {
    fail_setup(`tmux new-session failed: ${r.stderr}`);
  }
  log(`claude launched in tmux`);

  // Answering the startup dialogs.
  //
  // Production (pool.ts:4301-4330) fires two BLIND Enters on fixed timers —
  // 3000ms for the workspace-trust dialog, 6000ms for the dev-channels dialog
  // — with `catch {}` and no verification. #84 §3 P5 / R3 call that a timing
  // guess against a closed-source UI, and an unanswered dev-channels dialog is
  // a permanently dark channel: it blocks the whole CLI startup, so the MCP
  // servers (and therefore the shim) never spawn at all.
  //
  // `--blind-dialog` reproduces production exactly. The default instead does
  // what P5 proposes — poll the pane for the dialog text and press Enter when
  // it is actually on screen, bounded — so that a testbed FAIL means "the
  // transport is broken", not "the keypress timer lost a race".
  if (BLIND_DIALOG) {
    for (const [at, what] of [
      [3000, "trust"],
      [DIALOG_DELAY_MS, "dev-channels"],
    ]) {
      setTimeout(() => {
        const visible = /Enter to confirm/.test(capture_pane());
        log(`blind Enter for ${what} at t+${String(at)}ms (dialog on screen: ${String(visible)})`);
        const r = tmux("send-keys", "-t", tmux_session, "Enter");
        if (r.status !== 0) log(`! send-keys failed: ${r.stderr}`);
      }, at);
    }
  } else {
    answer_dialogs_by_polling();
  }

  const started = Date.now();
  const poll = setInterval(() => {
    const elapsed = Date.now() - started;
    const done = observed.outbound.filter((o) => o.tool === "reply").length >= MESSAGE_COUNT;
    if (!done && elapsed < TURN_TIMEOUT_MS) return;
    clearInterval(poll);
    verdict(done, elapsed);
  }, 1000);
});

function verdict(done, elapsed) {
  const replies = observed.outbound.filter((o) => o.tool === "reply");
  const pane = capture_pane();
  const skips = grep_cli_mcp_logs();

  console.log("\n================ TESTBED RESULT ================");
  console.log(`CLI version              ${cli_version}`);
  console.log(`elapsed                  ${String(Math.round(elapsed / 1000))}s`);
  console.log(`shim registered          ${observed.registers.length > 0 ? "YES" : "NO"}`);
  console.log(`inbound fed              ${String(fed.length)}`);
  console.log(`acked by shim            ${String(observed.acks.length)}`);
  console.log(`reply tool calls         ${String(replies.length)}`);

  // The CLI echoes an accepted channel message into the pane as
  //   "← <serverKey> · <user>: <content>"
  // That echo is the routing receipt the shim can never see: it means the
  // notification cleared BOTH allowlist gates and was injected into the
  // session. It is a strictly stronger signal than the ack, and strictly
  // weaker than a reply — it says nothing about whether the turn ran.
  // The pane hard-wraps at the terminal width, so a message's text is split
  // across lines. Collapse all whitespace in both the pane and the expected
  // content before matching, or every echo check fails for a cosmetic reason.
  const flat = pane.replace(/\s+/g, " ");
  const flat_of = (s) => s.replace(/\s+/g, " ").trim();
  const echoed = fed.filter((m) => flat.includes(`${SHIM_MCP_SERVER_KEY} · hunter: ${flat_of(m.content)}`));
  const echo_order = fed
    .filter((m) => flat.includes(flat_of(m.content)))
    .map((m) => ({ ordinal: m.ordinal, at: flat.indexOf(flat_of(m.content)) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.ordinal);

  // An unauthenticated CLI reaches its prompt and routes channel messages but
  // cannot run a turn. Distinguishing that from a transport fault is the whole
  // reason the routing receipt is checked separately.
  const auth_blocked = /Login expired|Not logged in|Please run \/login/.test(pane);

  console.log(`channel echoes in pane     ${String(echoed.length)}/${String(fed.length)}`);
  console.log(`CLI auth usable            ${auth_blocked ? "NO — Login expired" : "yes"}`);

  const checks = [];
  checks.push(["C1 shim registered with the stand-in", observed.registers.length === 1]);
  checks.push(["C2 shim acked every inbound", observed.acks.length === fed.length]);
  // C3 is the gate the three live-only bugs broke. Pane echo, not ack.
  checks.push([
    `C3 CLI ROUTED every inbound into the session (cleared both allowlist gates)`,
    echoed.length === fed.length && fed.length > 0,
  ]);
  checks.push([
    "C4 no 'Channel notifications skipped' in the CLI's MCP logs",
    skips.filter((l) => /skipped/i.test(l)).length === 0,
  ]);
  if (MESSAGE_COUNT > 1) {
    const expected = fed.map((m) => m.ordinal);
    checks.push([
      `C5 inbound injected into the session in order (${expected.join(",")})`,
      JSON.stringify(echo_order) === JSON.stringify(expected),
    ]);
    if (JSON.stringify(echo_order) !== JSON.stringify(expected)) {
      console.log(`  echo order observed: ${JSON.stringify(echo_order)}`);
    }
  }

  // Reply-leg checks are reported but EXCLUDED from the verdict when the CLI
  // cannot authenticate — a FAIL there would say nothing about the broker.
  const reply_checks = [];
  reply_checks.push([
    `C6 agent emitted >= ${String(MESSAGE_COUNT)} reply tool call(s)`,
    replies.length >= MESSAGE_COUNT,
  ]);
  if (MESSAGE_COUNT > 1) {
    const texts = replies.map((r) => String(r.args?.text ?? ""));
    reply_checks.push([
      `C7 replies in order (ACK-1 … ACK-${String(MESSAGE_COUNT)})`,
      texts.length === MESSAGE_COUNT && texts.every((t, i) => t.includes(`ACK-${String(i + 1)}`)),
    ]);
    reply_checks.push(["C8 no duplicate reply", replies.length === MESSAGE_COUNT]);
    if (texts.length > 0) console.log(`  reply texts: ${JSON.stringify(texts)}`);
  }

  console.log("");
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }
  console.log(auth_blocked ? "\n  -- reply leg (NOT COUNTED: CLI auth broken) --" : "");
  for (const [name, pass] of reply_checks) {
    console.log(`  ${auth_blocked ? "SKIP" : pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass && !auth_blocked) ok = false;
  }
  if (auth_blocked) {
    console.log(
      "\n  BLOCKER: this CLI install cannot run a turn (`Login expired`). The\n" +
        "  transport routed the message correctly, but no agent reply is possible\n" +
        "  on ANY path — broker or plugin — until the login is restored. A live\n" +
        "  G0.2 run in this state would produce four FAILs for a non-broker reason.",
    );
  }

  if (skips.length > 0) {
    console.log("\n-- CLI MCP log channel lines --");
    for (const l of skips) console.log(`  ${l}`);
  }
  if (!ok) {
    console.log("\n-- tmux pane (last 200 lines) --");
    console.log(pane);
    console.log(`\n-- mcp config --\n${readFileSync(mcp_config_path, "utf-8")}`);
  }
  console.log(`\nVERDICT: ${ok ? "PASS" : "FAIL"}`);
  console.log("NOTE: this covers the CLI/shim leg only. A daemon restart, pool");
  console.log("cold assign, and a real Discord round-trip are NOT covered here.");
  console.log("================================================");

  if (KEEP) console.log(`\nkept: tmux attach -t ${tmux_session}   dir: ${dir}`);
  cleanup();
  process.exit(ok ? 0 : 1);
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
