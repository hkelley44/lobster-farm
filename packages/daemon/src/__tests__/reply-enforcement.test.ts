/**
 * Tests for reply-enforcement.ts (issues #39 + #79).
 *
 * Covers all acceptance-criteria checkboxes from the issue spec:
 *   - text + reply  → ok, no enforcement (Discord-bound + non-bound)
 *   - text + no-reply, bound + discord + text → daemon delivers, no block (#79 mode A)
 *   - text + no-reply, bound, no discord / empty text / send throws → block + reminder
 *   - text + no-reply, same turn twice → no re-send (idempotency, #79)
 *   - text + no-reply, NOT bound → ok pass-through
 *   - silent turn, bound → heartbeat posted
 *   - silent turn within cooldown → no second heartbeat
 *   - silent turn, NOT bound → no heartbeat, no error
 *   - subagent / sidechain → pass-through
 *   - JSONL flush race → retry loop tolerates a brief absence
 *   - Haiku timeout → graceful fail open
 *   - run_claude_print → resolves on exit 0, rejects on non-zero + timeout (#79 a)
 *   - parse_last_assistant_turn → reply_text = joined text blocks (#79 b)
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscordBot } from "../discord.js";
import { encode_project_slug } from "../pool.js";
import type { BotPool, PoolBot } from "../pool.js";
import {
  HEARTBEAT_COOLDOWN_MS,
  HEARTBEAT_PREFIX,
  MODE_A_MAX_KEYS,
  REPLY_REMINDER,
  _mode_a_size_for_tests,
  _reset_cooldown_for_tests,
  evaluate_stop,
  is_discord_bound,
  parse_last_assistant_turn,
  read_last_assistant_turn,
  resolve_bound_channel,
  run_claude_print,
} from "../reply-enforcement.js";
import type { TurnSummary } from "../reply-enforcement.js";

// ── Test helpers ──

function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

/** Minimal pool stub exposing only the surface evaluate_stop touches. */
function make_pool(bots: PoolBot[]): BotPool {
  return {
    get_assigned_bots(): readonly PoolBot[] {
      return bots.filter((b) => b.state === "assigned");
    },
  } as unknown as BotPool;
}

interface SendCall {
  channel_id: string;
  content: string;
}

function make_discord(): { discord: DiscordBot; sends: SendCall[] } {
  const sends: SendCall[] = [];
  const discord = {
    async send(channel_id: string, content: string) {
      sends.push({ channel_id, content });
    },
  } as unknown as DiscordBot;
  return { discord, sends };
}

/** Build a JSONL "assistant" event with the given content blocks. */
function assistant_line(opts: {
  text?: string;
  tools?: string[];
  is_sidechain?: boolean;
  uuid?: string;
}): string {
  const blocks: Array<Record<string, unknown>> = [];
  if (opts.text !== undefined) {
    blocks.push({ type: "text", text: opts.text });
  }
  for (const name of opts.tools ?? []) {
    blocks.push({ type: "tool_use", id: `t-${name}`, name, input: {} });
  }
  const entry: Record<string, unknown> = {
    type: "assistant",
    isSidechain: opts.is_sidechain === true,
    message: {
      role: "assistant",
      content: blocks,
    },
  };
  if (opts.uuid !== undefined) {
    entry.uuid = opts.uuid;
  }
  return JSON.stringify(entry);
}

function user_line(): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

beforeEach(() => {
  _reset_cooldown_for_tests();
});

// ── parse_last_assistant_turn ──

describe("parse_last_assistant_turn", () => {
  it("flags produced_text when last assistant turn has non-empty text", () => {
    const jsonl = `${user_line()}\n${assistant_line({ text: "Hello there." })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.found).toBe(true);
    expect(turn.produced_text).toBe(true);
    expect(turn.called_reply).toBe(false);
  });

  it("ignores whitespace-only text blocks", () => {
    const jsonl = `${assistant_line({ text: "   \n\t" })}\n`;
    expect(parse_last_assistant_turn(jsonl).produced_text).toBe(false);
  });

  it("flags called_reply when the canonical Discord reply tool is invoked", () => {
    const jsonl = `${assistant_line({
      text: "ok",
      tools: ["mcp__plugin_discord_discord__reply"],
    })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.called_reply).toBe(true);
    expect(turn.produced_text).toBe(true);
  });

  it("loose-matches future discord-reply-shaped tool names", () => {
    const jsonl = `${assistant_line({ tools: ["discord_v2_reply"] })}\n`;
    expect(parse_last_assistant_turn(jsonl).called_reply).toBe(true);
  });

  it("does not flag non-reply tools as reply", () => {
    const jsonl = `${assistant_line({ tools: ["Bash", "Read", "Edit"] })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.called_reply).toBe(false);
    expect(turn.tool_summary).toBe("Bash, Read, Edit");
  });

  it("walks backward to the *last* assistant turn, ignoring earlier ones", () => {
    const jsonl = [
      assistant_line({ text: "old reply", tools: ["mcp__plugin_discord_discord__reply"] }),
      user_line(),
      assistant_line({ tools: ["Bash"] }), // last assistant turn = silent
      "",
    ].join("\n");
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.produced_text).toBe(false);
    expect(turn.called_reply).toBe(false);
    expect(turn.tool_summary).toBe("Bash");
  });

  it("propagates isSidechain marker", () => {
    const jsonl = `${assistant_line({ text: "subagent text", is_sidechain: true })}\n`;
    expect(parse_last_assistant_turn(jsonl).is_sidechain).toBe(true);
  });

  it("returns found=false on empty / no-assistant transcripts", () => {
    expect(parse_last_assistant_turn("").found).toBe(false);
    expect(parse_last_assistant_turn(`${user_line()}\n`).found).toBe(false);
  });

  it("skips malformed lines without throwing", () => {
    const jsonl = `not json\n${assistant_line({ text: "ok" })}\n`;
    expect(parse_last_assistant_turn(jsonl).found).toBe(true);
  });

  // ── reply_text (issue #79 b) ──

  it("captures reply_text = the single text block", () => {
    const jsonl = `${assistant_line({ text: "Hello there." })}\n`;
    expect(parse_last_assistant_turn(jsonl).reply_text).toBe("Hello there.");
  });

  it("joins multiple text blocks with a blank line", () => {
    // Build an assistant entry with two separate text blocks.
    const jsonl = `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
          { type: "text", text: "Second paragraph." },
        ],
      },
    })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.reply_text).toBe("First paragraph.\n\nSecond paragraph.");
    expect(turn.produced_text).toBe(true);
  });

  it("returns empty reply_text for a tool-only turn", () => {
    const jsonl = `${assistant_line({ tools: ["Bash", "Read"] })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.reply_text).toBe("");
    expect(turn.produced_text).toBe(false);
  });

  it("returns empty reply_text for a whitespace-only text block", () => {
    const jsonl = `${assistant_line({ text: "   \n\t" })}\n`;
    expect(parse_last_assistant_turn(jsonl).reply_text).toBe("");
  });

  it("returns empty reply_text for a tool-only sidechain turn", () => {
    // Sidechain (subagent) turns are forced to pass-through downstream via the
    // is_sidechain marker; a tool-only sidechain turn harvests no text.
    const jsonl = `${assistant_line({ tools: ["Bash"], is_sidechain: true })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.is_sidechain).toBe(true);
    expect(turn.reply_text).toBe("");
  });

  it("returns empty reply_text for a not-found transcript", () => {
    expect(parse_last_assistant_turn("").reply_text).toBe("");
    expect(parse_last_assistant_turn(`${user_line()}\n`).reply_text).toBe("");
  });

  // ── uuid (issue #81 item 3 — per-turn idempotency key) ──

  it("captures the top-level uuid of the last assistant entry", () => {
    const jsonl = `${assistant_line({ text: "hi", uuid: "u-123" })}\n`;
    expect(parse_last_assistant_turn(jsonl).uuid).toBe("u-123");
  });

  it("returns empty uuid when the assistant entry has no uuid field", () => {
    const jsonl = `${assistant_line({ text: "hi" })}\n`;
    expect(parse_last_assistant_turn(jsonl).uuid).toBe("");
  });

  it("returns empty uuid for a not-found transcript", () => {
    expect(parse_last_assistant_turn("").uuid).toBe("");
  });

  it("captures the uuid of the LAST assistant turn, not an earlier one", () => {
    const jsonl = [
      assistant_line({ text: "old", uuid: "u-old" }),
      user_line(),
      assistant_line({ text: "new", uuid: "u-new" }),
      "",
    ].join("\n");
    expect(parse_last_assistant_turn(jsonl).uuid).toBe("u-new");
  });
});

// ── read_last_assistant_turn (filesystem + flush race) ──

describe("read_last_assistant_turn", () => {
  let original_home: string | undefined;
  let temp_home: string;
  let working_dir: string;
  let session_id: string;

  beforeEach(async () => {
    original_home = process.env.HOME;
    temp_home = await mkdtemp(join(tmpdir(), "lf-stop-hook-"));
    process.env.HOME = temp_home;

    working_dir = "/tmp/some-cwd";
    session_id = "11111111-1111-1111-1111-111111111111";

    const project_dir = join(temp_home, ".claude", "projects", encode_project_slug(working_dir));
    await mkdir(project_dir, { recursive: true });
  });

  afterEach(async () => {
    if (original_home !== undefined) {
      process.env.HOME = original_home;
    } else {
      delete process.env.HOME;
    }
    await rm(temp_home, { recursive: true, force: true });
  });

  it("returns found=false when the JSONL doesn't exist", async () => {
    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(false);
  });

  it("reads the last assistant turn from disk", async () => {
    const path = join(
      temp_home,
      ".claude",
      "projects",
      encode_project_slug(working_dir),
      `${session_id}.jsonl`,
    );
    await writeFile(path, `${assistant_line({ text: "hello" })}\n`, "utf-8");
    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(true);
    expect(turn.produced_text).toBe(true);
  });

  it("returns found=false on a zero-byte JSONL (empty-file edge case)", async () => {
    // Edge case: file exists but has zero bytes (a flush race window where
    // open() has created the file but no events have landed). The retry loop
    // settles when size stops growing, then the empty-content guard returns
    // found=false so the caller treats this as pass-through.
    const path = join(
      temp_home,
      ".claude",
      "projects",
      encode_project_slug(working_dir),
      `${session_id}.jsonl`,
    );
    await writeFile(path, "", "utf-8");
    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(false);
    expect(turn.produced_text).toBe(false);
    expect(turn.called_reply).toBe(false);
  });

  it("tolerates a brief flush delay (race mitigation)", async () => {
    const path = join(
      temp_home,
      ".claude",
      "projects",
      encode_project_slug(working_dir),
      `${session_id}.jsonl`,
    );

    // Materialize the file ~25ms after the call begins.
    setTimeout(() => {
      void writeFile(path, `${assistant_line({ text: "late flush" })}\n`, "utf-8");
    }, 25);

    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(true);
    expect(turn.produced_text).toBe(true);
  });
});

// ── Pool binding ──

describe("resolve_bound_channel / is_discord_bound", () => {
  it("returns the channel_id when an assigned bot owns the session", () => {
    const pool = make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id: "S1",
      }),
    ]);
    expect(resolve_bound_channel("S1", pool)).toBe("C123");
    expect(is_discord_bound("S1", pool)).toBe(true);
  });

  it("returns null when no assigned bot owns the session", () => {
    const pool = make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        session_id: "S2",
      }),
    ]);
    expect(resolve_bound_channel("S1", pool)).toBeNull();
    expect(is_discord_bound("S1", pool)).toBe(false);
  });

  it("ignores non-assigned bots even with matching session_id", () => {
    const pool = make_pool([
      make_bot({ id: 1, state: "free", session_id: "S1", channel_id: "C-stale" }),
      make_bot({ id: 2, state: "parked", session_id: "S1", channel_id: "C-also-stale" }),
    ]);
    expect(is_discord_bound("S1", pool)).toBe(false);
  });

  it("returns null when pool is null", () => {
    expect(resolve_bound_channel("S1", null)).toBeNull();
    expect(is_discord_bound("S1", null)).toBe(false);
  });

  it("returns null for subagent session_ids (subagent sessions are never in the pool assignment map)", () => {
    // Subagents inherit the parent's working dir but get their own session_id
    // from Claude Code. They are never assigned a pool bot, so they never
    // appear in the assignment map — pool binding is the primary defense
    // against subagent Stop events triggering enforcement.
    const parent_session_id = "parent-S";
    const subagent_session_id = "subagent-S";
    const pool = make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id: parent_session_id,
      }),
    ]);
    expect(resolve_bound_channel(subagent_session_id, pool)).toBeNull();
    expect(is_discord_bound(subagent_session_id, pool)).toBe(false);
    // Sanity: the parent still resolves.
    expect(is_discord_bound(parent_session_id, pool)).toBe(true);
  });
});

// ── evaluate_stop orchestrator ──

describe("evaluate_stop — acceptance criteria", () => {
  const session_id = "abc";
  const working_dir = "/tmp/wd";

  function bound_pool(): BotPool {
    return make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id,
      }),
    ]);
  }

  function unbound_pool(): BotPool {
    return make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id: "different-session",
      }),
    ]);
  }

  function make_turn_reader(turn: Partial<TurnSummary>) {
    return async (): Promise<TurnSummary> => ({
      produced_text: false,
      reply_text: "",
      called_reply: false,
      is_sidechain: false,
      tool_summary: "",
      // Default a stable uuid so mode-A dedup keys deterministically. Tests that
      // exercise the per-turn idempotency semantics override this explicitly.
      uuid: "turn-uuid-default",
      found: true,
      ...turn,
    });
  }

  it("text + reply → ok pass-through (Discord-bound)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: true, called_reply: true }),
        make_heartbeat: async () => "should not run",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("text + no-reply, Discord-bound, empty reply_text → block + reminder (fallback)", async () => {
    // produced_text is true but reply_text is empty (the parser flagged text
    // but there's nothing deliverable) → the daemon can't deliver, so we keep
    // the old block+reminder behavior.
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "",
        }),
      },
    );
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
    // Must NOT post anything on the blocked path.
    expect(sends.length).toBe(0);
  });

  // ── mode A: daemon delivers the harvested text (issue #79 b) ──

  it("mode A: text + no-reply, discord + non-empty text → daemon sends verbatim, no block", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "Here is your answer.",
        }),
      },
    );
    // Delivered — pass through, do NOT block.
    expect(result).toEqual({ ok: true });
    // Posted verbatim, NO heartbeat prefix.
    expect(sends).toEqual([{ channel_id: "C123", content: "Here is your answer." }]);
  });

  it("mode A: trims surrounding whitespace before sending", async () => {
    const { discord, sends } = make_discord();
    await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "  padded answer  \n",
        }),
      },
    );
    expect(sends).toEqual([{ channel_id: "C123", content: "padded answer" }]);
  });

  it("mode A fallback: discord=null → block + reminder", async () => {
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord: null,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "Undeliverable because no discord client.",
        }),
      },
    );
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
  });

  it("mode A fallback: empty reply_text → block + reminder", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "   ",
        }),
      },
    );
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
    expect(sends.length).toBe(0);
  });

  it("mode A fallback: discord.send throws → block + reminder", async () => {
    const throwing_discord = {
      async send() {
        throw new Error("discord 500");
      },
    } as unknown as DiscordBot;
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord: throwing_discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "This send will fail.",
        }),
      },
    );
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
  });

  it("mode A idempotency: same turn (same uuid) evaluated twice → second call does not re-send", async () => {
    // A true Stop-hook re-fire re-parses the SAME transcript tail entry, so it
    // carries the same top-level uuid. The guard keys on that uuid and
    // suppresses the second delivery — this is the double-post protection.
    const { discord, sends } = make_discord();
    const deps = {
      pool: bound_pool(),
      discord,
      read_turn: make_turn_reader({
        produced_text: true,
        called_reply: false,
        reply_text: "Deliver me exactly once.",
        uuid: "turn-A",
      }),
    };
    const first = await evaluate_stop({ session_id, working_dir }, deps);
    const second = await evaluate_stop({ session_id, working_dir }, deps);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    // Only one send — the idempotency guard suppressed the re-fire.
    expect(sends.length).toBe(1);
    expect(sends[0]).toEqual({ channel_id: "C123", content: "Deliver me exactly once." });
  });

  it("mode A idempotency: re-fire is suppressed even when whitespace varies (uuid, not content, is the key)", async () => {
    // On a Stop-hook re-fire, surrounding whitespace can vary between transcript
    // reads. Because the guard keys on the per-turn uuid (not the content), the
    // same turn is suppressed regardless of whitespace drift — exactly one send.
    const { discord, sends } = make_discord();
    const first = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "  answer  \n",
          uuid: "turn-A",
        }),
      },
    );
    const second = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "\n answer ",
          uuid: "turn-A",
        }),
      },
    );
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    // Exactly one send, and it's the trimmed form.
    expect(sends).toEqual([{ channel_id: "C123", content: "answer" }]);
  });

  it("mode A idempotency (issue #81): two DISTINCT turns with identical text BOTH deliver", async () => {
    // The bug this fixes: content-keying suppressed a legitimately-repeated
    // answer. Two separate tasks both ending in "Done." are distinct turns with
    // distinct uuids — both must reach the user. Under the old (session, text)
    // key the second was silently dropped (returned pass-through, neither
    // delivered nor blocked). Under uuid-keying both deliver.
    const { discord, sends } = make_discord();
    const first = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "Done.",
          uuid: "turn-1",
        }),
      },
    );
    const second = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "Done.",
          uuid: "turn-2",
        }),
      },
    );
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    // Both "Done." messages delivered — no silent drop.
    expect(sends).toEqual([
      { channel_id: "C123", content: "Done." },
      { channel_id: "C123", content: "Done." },
    ]);
  });

  it("mode A idempotency: missing uuid → deliver (never gate first delivery on an absent id)", async () => {
    // A transcript entry without a uuid can't safely identify a re-fire. We
    // deliver rather than risk silently dropping — double-post beats never-post.
    // Two reads with empty uuid both deliver (no dedup applied).
    const { discord, sends } = make_discord();
    const deps = {
      pool: bound_pool(),
      discord,
      read_turn: make_turn_reader({
        produced_text: true,
        called_reply: false,
        reply_text: "No uuid here.",
        uuid: "",
      }),
    };
    await evaluate_stop({ session_id, working_dir }, deps);
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(sends.length).toBe(2);
  });

  it("mode A idempotency: different uuid is NOT suppressed", async () => {
    const { discord, sends } = make_discord();
    await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "First answer.",
          uuid: "turn-1",
        }),
      },
    );
    await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          reply_text: "A genuinely different answer.",
          uuid: "turn-2",
        }),
      },
    );
    expect(sends.length).toBe(2);
  });

  it("mode A guard stays bounded under many distinct deliveries (issue #81 item 2)", async () => {
    // Prove the mode-A delivery guard never grows without limit. Deliver far
    // more distinct turns than the cap and assert the guard size holds at
    // MODE_A_MAX_KEYS via LRU eviction, rather than leaking one entry per
    // delivery on a long-lived daemon.
    const { discord } = make_discord();
    const overflow = MODE_A_MAX_KEYS + 500;
    for (let i = 0; i < overflow; i++) {
      await evaluate_stop(
        { session_id, working_dir },
        {
          pool: bound_pool(),
          discord,
          read_turn: make_turn_reader({
            produced_text: true,
            called_reply: false,
            reply_text: `answer ${String(i)}`,
            uuid: `turn-${String(i)}`,
          }),
        },
      );
    }
    expect(_mode_a_size_for_tests()).toBe(MODE_A_MAX_KEYS);
  });

  it("text + no-reply, NOT Discord-bound → pass-through (no enforcement)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: unbound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: true, called_reply: false }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("silent turn (tool-only), Discord-bound → posts heartbeat to channel", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: false,
          called_reply: false,
          tool_summary: "Bash, Edit",
        }),
        make_heartbeat: async () => "Refactoring the pool resume logic.",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends).toEqual([
      {
        channel_id: "C123",
        content: `${HEARTBEAT_PREFIX}Refactoring the pool resume logic.`,
      },
    ]);
  });

  it("silent turn within cooldown window → no second heartbeat", async () => {
    const { discord, sends } = make_discord();
    let now = 1_000_000;
    const deps = {
      pool: bound_pool(),
      discord,
      now: () => now,
      read_turn: make_turn_reader({
        produced_text: false,
        called_reply: false,
        tool_summary: "Bash",
      }),
      make_heartbeat: async () => "Working on something.",
    };

    await evaluate_stop({ session_id, working_dir }, deps);
    expect(sends.length).toBe(1);

    // Same channel, 30 seconds later — well inside the 60s cooldown.
    now += 30_000;
    expect(now - 1_000_000).toBeLessThan(HEARTBEAT_COOLDOWN_MS);
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(sends.length).toBe(1);

    // After cooldown expires, a new heartbeat may post.
    now += HEARTBEAT_COOLDOWN_MS + 1;
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(sends.length).toBe(2);
  });

  it("silent turn, NOT Discord-bound → no heartbeat, no error", async () => {
    const { discord, sends } = make_discord();
    let heartbeat_called = false;
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: unbound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: false, called_reply: false }),
        make_heartbeat: async () => {
          heartbeat_called = true;
          return "should not run";
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
    expect(heartbeat_called).toBe(false);
  });

  it("subagent / sidechain transcript → pass-through even on text+no-reply", async () => {
    // Defense-in-depth: even if a sidechain session were somehow bound
    // (it shouldn't be, but the pool check is the only other line of defense),
    // the sidechain marker forces pass-through.
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          is_sidechain: true,
        }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("transcript not found → pass-through (no false-positive block)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({ found: false }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("transcript reader throws → fail open (no block)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("Haiku heartbeat throws → swallow error, no send, no cooldown burn", async () => {
    const { discord, sends } = make_discord();
    let now = 0;
    const deps = {
      pool: bound_pool(),
      discord,
      now: () => now,
      read_turn: make_turn_reader({ produced_text: false, called_reply: false }),
      make_heartbeat: async () => {
        throw new Error("haiku timed out");
      },
    };
    const result = await evaluate_stop({ session_id, working_dir }, deps);
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);

    // Cooldown was NOT marked because the send never landed — next call
    // (with a working heartbeat) should be free to post.
    const second = {
      ...deps,
      make_heartbeat: async () => "Now working.",
    };
    now += 1_000;
    await evaluate_stop({ session_id, working_dir }, second);
    expect(sends.length).toBe(1);
  });

  it("mid-turn streaming reply (no text + reply called) → pass-through, no heartbeat", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: false, called_reply: true }),
        make_heartbeat: async () => "should not run",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("silent turn with bound channel but null discord → pass-through, no Haiku call", async () => {
    // Defends the null-discord short-circuit: if a channel is bound but the
    // discord client somehow isn't wired (partial-startup edge case), we must
    // not burn a Haiku round-trip just to discard it.
    let heartbeat_called = false;
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord: null,
        read_turn: make_turn_reader({ produced_text: false, called_reply: false }),
        make_heartbeat: async () => {
          heartbeat_called = true;
          return "should not run";
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(heartbeat_called).toBe(false);
  });

  it("null pool (daemon without Discord) → pass-through", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: null,
        discord,
        read_turn: make_turn_reader({ produced_text: true, called_reply: false }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });
});

// ── run_claude_print (issue #79 a — heartbeat stdin fix) ──

describe("run_claude_print", () => {
  let bin_dir: string;

  beforeEach(async () => {
    bin_dir = await mkdtemp(join(tmpdir(), "lf-claude-bin-"));
  });

  afterEach(async () => {
    await rm(bin_dir, { recursive: true, force: true });
  });

  /** Write an executable shell script and return its path. */
  async function make_script(name: string, body: string): Promise<string> {
    const path = join(bin_dir, name);
    await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, "utf-8");
    await chmod(path, 0o755);
    return path;
  }

  it("resolves with stdout when the child exits 0", async () => {
    // Echoes back whatever it reads on stdin, proving the prompt is fed there
    // and stdin is closed (otherwise `cat` would block forever).
    const bin = await make_script("ok", "cat");
    const out = await run_claude_print(bin, [], "hello over stdin", 5_000);
    expect(out).toBe("hello over stdin");
  });

  it("closes stdin so a stdin-reading child never hangs", async () => {
    // `cat` with no args reads until EOF. If stdin were left open this would
    // hang until the 1s timeout and reject. It must resolve fast instead.
    const bin = await make_script("cat-eof", "cat");
    const out = await run_claude_print(bin, [], "", 1_000);
    expect(out).toBe("");
  });

  it("rejects when the child exits non-zero, surfacing stderr", async () => {
    const bin = await make_script("fail", 'echo "boom" >&2\nexit 3');
    await expect(run_claude_print(bin, [], "x", 5_000)).rejects.toThrow(/claude exited 3/);
  });

  it("rejects and kills the child on timeout", async () => {
    // Sleeps well past the timeout; run_claude_print must SIGKILL it and reject.
    const bin = await make_script("slow", "sleep 5");
    const started = Date.now();
    // The rejection message is generic over `bin` — it names the binary and the
    // elapsed budget rather than a hardcoded "claude -p timeout" string.
    await expect(run_claude_print(bin, [], "x", 150)).rejects.toThrow(/timed out after 150ms/);
    // Should reject promptly at the timeout, not wait out the full 5s sleep.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects when the binary does not exist (spawn error)", async () => {
    await expect(
      run_claude_print(join(bin_dir, "does-not-exist"), [], "x", 1_000),
    ).rejects.toBeInstanceOf(Error);
  });

  // ── async stdin EPIPE (issue #81 item 1 — PRIORITY, daemon-crash vector) ──

  it("settles cleanly when the child exits before draining a large stdin payload (async EPIPE)", async () => {
    // Regression for the daemon-crash vector: a child that exits immediately
    // leaves its stdin pipe with no reader. Writing a payload LARGER than the OS
    // pipe buffer (~64 KiB on Darwin/Linux) can't complete synchronously — the
    // kernel raises EPIPE on the stdin stream ASYNCHRONOUSLY, as an 'error'
    // event. Without `child.stdin.on("error", ...)` Node escalates that to an
    // uncaught exception and kills the whole daemon. This test drives the REAL
    // spawn/stdin path (a real child process that exits at once) and asserts the
    // promise settles instead of throwing uncaught.
    const bin = await make_script("exit-fast", "exit 0");
    // 1 MiB — well past any pipe buffer, guaranteeing the write outlives the child.
    const big_payload = "x".repeat(1024 * 1024);

    // A rejection is a clean settle (the child exited non-zero or the write path
    // errored); a resolve is also clean. The ONLY unacceptable outcome is an
    // uncaught 'error' event crashing the process — which manifests here as the
    // test runner recording an unhandled error. Guard against that explicitly.
    let uncaught: unknown;
    const on_uncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", on_uncaught);
    try {
      await run_claude_print(bin, [], big_payload, 5_000).then(
        () => undefined,
        () => undefined, // reject is a valid clean settle
      );
      // Give any async EPIPE a tick to surface before we assert.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", on_uncaught);
    }
    expect(uncaught).toBeUndefined();
  });

  it("does not crash when the child dies mid-write on a large payload", async () => {
    // Complementary case: the child reads a little then exits, so the writer is
    // still pushing bytes when the read end closes — the classic broken-pipe
    // race the reviewer called out (SIGKILL-on-timeout / instant-exit). Must
    // settle without an uncaught throw.
    const bin = await make_script("read-then-die", "head -c 10 >/dev/null; exit 0");
    const big_payload = "y".repeat(1024 * 1024);
    let uncaught: unknown;
    const on_uncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", on_uncaught);
    try {
      await run_claude_print(bin, [], big_payload, 5_000).then(
        () => undefined,
        () => undefined,
      );
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", on_uncaught);
    }
    expect(uncaught).toBeUndefined();
  });
});
