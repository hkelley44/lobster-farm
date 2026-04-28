import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock discord.js so DiscordBot can be instantiated without a live websocket.
vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn(),
      destroy: vi.fn(),
      user: null,
      channels: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
      application: null,
    })),
  };
});

import { CommanderProcess } from "../commander-process.js";
import { DiscordBot } from "../discord.js";
import { EntityRegistry } from "../registry.js";

/**
 * The CommanderProcess writes to `<lobsterfarm_dir>/channels/pat/access.json`.
 * Tests redirect lobsterfarm_dir to a fresh tmp dir so the real
 * `~/.lobsterfarm/channels/pat/access.json` is never touched.
 */
function make_config(args: { user_id?: string; lobsterfarm_dir: string }): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    discord: args.user_id
      ? { server_id: "111222333", user_id: args.user_id }
      : { server_id: "111222333" },
    paths: { lobsterfarm_dir: args.lobsterfarm_dir },
  });
}

describe("CommanderProcess.ensure_channel_allowlisted", () => {
  let tmp_dir: string;
  let pat_dir: string;
  let access_path: string;

  beforeEach(async () => {
    tmp_dir = join(tmpdir(), `commander-allowlist-test-${randomUUID()}`);
    pat_dir = join(tmp_dir, "channels", "pat");
    access_path = join(pat_dir, "access.json");
    await mkdir(pat_dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true }).catch(() => {});
  });

  it("seeds a full default access.json when the file is missing", async () => {
    const commander = new CommanderProcess(
      make_config({ user_id: "owner-1", lobsterfarm_dir: tmp_dir }),
    );

    await commander.ensure_channel_allowlisted("chan-A");

    const content = JSON.parse(await readFile(access_path, "utf-8"));
    expect(content.dmPolicy).toBe("allowlist");
    expect(content.allowFrom).toEqual([]);
    expect(content.pending).toEqual({});
    expect(content.groups["chan-A"]).toEqual({
      requireMention: true,
      allowFrom: ["owner-1"],
    });
  });

  it("writes the new entry shape with requireMention=true and allowFrom=[owner_id]", async () => {
    const commander = new CommanderProcess(
      make_config({ user_id: "owner-2", lobsterfarm_dir: tmp_dir }),
    );

    // Seed an existing access.json to verify additive behavior on a real file.
    await writeFile(
      access_path,
      JSON.stringify({
        dmPolicy: "allowlist",
        allowFrom: ["owner-2"],
        groups: {
          "canonical-channel": { requireMention: false, allowFrom: [] },
        },
        pending: {},
        ackReaction: "👀",
        replyToMode: "first",
        textChunkLimit: 2000,
        chunkMode: "newline",
      }),
    );

    await commander.ensure_channel_allowlisted("new-channel");

    const content = JSON.parse(await readFile(access_path, "utf-8"));
    // Existing entry preserved
    expect(content.groups["canonical-channel"]).toEqual({
      requireMention: false,
      allowFrom: [],
    });
    // New entry has the spec'd shape
    expect(content.groups["new-channel"]).toEqual({
      requireMention: true,
      allowFrom: ["owner-2"],
    });
    // Optional fields preserved verbatim
    expect(content.ackReaction).toBe("👀");
    expect(content.replyToMode).toBe("first");
    expect(content.textChunkLimit).toBe(2000);
    expect(content.chunkMode).toBe("newline");
    expect(content.allowFrom).toEqual(["owner-2"]);
  });

  it("is a no-op when the channel is already in groups (no file mutation)", async () => {
    const commander = new CommanderProcess(
      make_config({ user_id: "owner-3", lobsterfarm_dir: tmp_dir }),
    );

    const initial = {
      dmPolicy: "allowlist",
      allowFrom: ["owner-3"],
      groups: {
        "already-here": { requireMention: false, allowFrom: [] },
      },
      pending: {},
    };
    const initial_json = JSON.stringify(initial, null, 2);
    await writeFile(access_path, initial_json);
    const stat_before = (await readFile(access_path, "utf-8")).length;

    await commander.ensure_channel_allowlisted("already-here");

    // Byte-equivalent — no rewrite happened. (If we had rewritten, the file
    // would end with a trailing newline and use our normalized shape.)
    const after = await readFile(access_path, "utf-8");
    expect(after).toBe(initial_json);
    expect(after.length).toBe(stat_before);
    // And the existing entry is unchanged — requireMention NOT silently
    // upgraded to true on an already-present channel.
    const parsed = JSON.parse(after);
    expect(parsed.groups["already-here"]).toEqual({
      requireMention: false,
      allowFrom: [],
    });
  });

  it("moves a corrupt access.json aside and writes a fresh one", async () => {
    const commander = new CommanderProcess(
      make_config({ user_id: "owner-4", lobsterfarm_dir: tmp_dir }),
    );

    await writeFile(access_path, "{ this is not json");

    await commander.ensure_channel_allowlisted("chan-X");

    const fresh = JSON.parse(await readFile(access_path, "utf-8"));
    expect(fresh.groups["chan-X"]).toEqual({
      requireMention: true,
      allowFrom: ["owner-4"],
    });
    expect(fresh.dmPolicy).toBe("allowlist");

    // The corrupt file should still exist with the .corrupt-<ts> suffix.
    const entries = await readdir(pat_dir);
    const corrupt_files = entries.filter((e) => e.startsWith("access.json.corrupt-"));
    expect(corrupt_files.length).toBe(1);
  });

  it("writes atomically via tmp + rename (no leftover tmp files)", async () => {
    const commander = new CommanderProcess(
      make_config({ user_id: "owner-5", lobsterfarm_dir: tmp_dir }),
    );

    await commander.ensure_channel_allowlisted("chan-1");
    const entries = await readdir(pat_dir);
    expect(entries).toContain("access.json");
    // The tmp file uses a random suffix to avoid concurrent-write collisions;
    // verify no stragglers landed in the dir.
    expect(entries.filter((e) => e.startsWith("access.json.tmp")).length).toBe(0);
  });

  it("does not corrupt the file under concurrent calls (atomic rename)", async () => {
    const commander = new CommanderProcess(
      make_config({ user_id: "owner-6", lobsterfarm_dir: tmp_dir }),
    );

    // Fire 10 concurrent writes for distinct channels. The tmp+rename pattern
    // means whichever goes last wins, but the file must always be valid JSON
    // (no torn writes) and contain at least one of the channels.
    const channels = Array.from({ length: 10 }, (_, i) => `chan-concurrent-${String(i)}`);
    await Promise.all(channels.map((c) => commander.ensure_channel_allowlisted(c)));

    const content = JSON.parse(await readFile(access_path, "utf-8"));
    expect(content.dmPolicy).toBe("allowlist");
    // At least one channel landed. We don't assert all 10 because read-modify-
    // write under concurrency is last-write-wins; the goal of this test is
    // "no corruption" not "no lost updates" — that's a documented caveat of
    // the additive-allowlist design.
    const present = channels.filter((c) => content.groups[c]);
    expect(present.length).toBeGreaterThanOrEqual(1);
    for (const c of present) {
      expect(content.groups[c]).toEqual({
        requireMention: true,
        allowFrom: ["owner-6"],
      });
    }
  });

  it("is a no-op when no owner_id is configured (does not create access.json)", async () => {
    const commander = new CommanderProcess(
      make_config({ lobsterfarm_dir: tmp_dir }), // no user_id
    );

    await commander.ensure_channel_allowlisted("chan-Z");

    const entries = await readdir(pat_dir);
    expect(entries).not.toContain("access.json");
  });

  it("does not mutate already-allowlisted channels even if owner_id changed", async () => {
    // Defense check: ensure_channel_allowlisted must NOT update allowFrom on
    // an already-present entry. Pruning stays a manual operation.
    const commander = new CommanderProcess(
      make_config({ user_id: "new-owner", lobsterfarm_dir: tmp_dir }),
    );
    await writeFile(
      access_path,
      JSON.stringify({
        dmPolicy: "allowlist",
        allowFrom: ["new-owner"],
        groups: {
          "old-channel": { requireMention: true, allowFrom: ["old-owner"] },
        },
        pending: {},
      }),
    );

    await commander.ensure_channel_allowlisted("old-channel");

    const content = JSON.parse(await readFile(access_path, "utf-8"));
    expect(content.groups["old-channel"]).toEqual({
      requireMention: true,
      allowFrom: ["old-owner"],
    });
  });

  it("preserves all pre-existing groups across a write (additive only)", async () => {
    const commander = new CommanderProcess(
      make_config({ user_id: "owner-7", lobsterfarm_dir: tmp_dir }),
    );
    await writeFile(
      access_path,
      JSON.stringify({
        dmPolicy: "allowlist",
        allowFrom: ["owner-7"],
        groups: {
          "canonical-1": { requireMention: false, allowFrom: [] },
          "canonical-2": { requireMention: true, allowFrom: ["someone-else"] },
        },
        pending: {},
      }),
    );

    await commander.ensure_channel_allowlisted("third-channel");

    const content = JSON.parse(await readFile(access_path, "utf-8"));
    expect(Object.keys(content.groups).sort()).toEqual([
      "canonical-1",
      "canonical-2",
      "third-channel",
    ]);
    expect(content.groups["canonical-1"]).toEqual({ requireMention: false, allowFrom: [] });
    expect(content.groups["canonical-2"]).toEqual({
      requireMention: true,
      allowFrom: ["someone-else"],
    });
  });
});

// ── handle_message integration ──
//
// These tests verify the trigger gating in DiscordBot.handle_message:
// only owner-authored messages in non-pool, non-command-center channels
// reach ensure_channel_allowlisted.

/** Minimal Discord Message stand-in. handle_message reads only these fields. */
interface FakeMessage {
  author: { bot: boolean; id: string; displayName: string };
  channelId: string;
  id: string;
  content: string;
  createdTimestamp: number;
}

function fake_message(opts: {
  author_id: string;
  channel_id: string;
  bot?: boolean;
  content?: string;
}): FakeMessage {
  return {
    author: {
      bot: opts.bot ?? false,
      id: opts.author_id,
      displayName: "tester",
    },
    channelId: opts.channel_id,
    id: "msg-1",
    content: opts.content ?? "hi",
    createdTimestamp: Date.now(),
  };
}

/**
 * Test subclass that exposes handle_message and stubs the side effects we
 * don't care about (typing loop, status embeds, command center lookup).
 */
class TestDiscordBot extends DiscordBot {
  command_center_id: string | null = null;

  async invoke_handle_message(msg: FakeMessage): Promise<void> {
    await (this as unknown as { handle_message: (m: FakeMessage) => Promise<void> }).handle_message(
      msg,
    );
  }

  // No-op the side effects so handle_message can run headless.
  override start_commander_typing_loop(): void {}
  override async find_command_center_channel(): Promise<string | null> {
    return this.command_center_id;
  }
  protected async send_status_embed(): Promise<void> {
    // private in the real class — silence it with a structural override.
  }
}

describe("DiscordBot.handle_message — Pat allowlist trigger", () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = join(tmpdir(), `discord-allowlist-test-${randomUUID()}`);
    await mkdir(tmp_dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true }).catch(() => {});
  });

  function make_bot(user_id: string | undefined): TestDiscordBot {
    const config = make_config({ user_id, lobsterfarm_dir: tmp_dir });
    const registry = new EntityRegistry(config);
    return new TestDiscordBot(config, registry);
  }

  it("calls ensure_channel_allowlisted for owner messages in unmapped channels", async () => {
    const bot = make_bot("owner-id");
    const ensure = vi.fn().mockResolvedValue(undefined);
    bot.set_commander({
      ensure_channel_allowlisted: ensure,
    } as unknown as CommanderProcess);

    await bot.invoke_handle_message(
      fake_message({ author_id: "owner-id", channel_id: "stray-channel" }),
    );

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith("stray-channel");
  });

  it("does not call ensure_channel_allowlisted for non-owner messages", async () => {
    const bot = make_bot("owner-id");
    const ensure = vi.fn().mockResolvedValue(undefined);
    bot.set_commander({
      ensure_channel_allowlisted: ensure,
    } as unknown as CommanderProcess);

    await bot.invoke_handle_message(
      fake_message({ author_id: "someone-else", channel_id: "stray-channel" }),
    );

    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not call ensure_channel_allowlisted in the command-center channel", async () => {
    const bot = make_bot("owner-id");
    bot.command_center_id = "cc-1";
    const ensure = vi.fn().mockResolvedValue(undefined);
    bot.set_commander({
      ensure_channel_allowlisted: ensure,
    } as unknown as CommanderProcess);

    await bot.invoke_handle_message(fake_message({ author_id: "owner-id", channel_id: "cc-1" }));

    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not call ensure_channel_allowlisted when commander is not wired", async () => {
    const bot = make_bot("owner-id");
    // No set_commander call — _commander stays null.

    // No throw expected. The call simply no-ops.
    await bot.invoke_handle_message(
      fake_message({ author_id: "owner-id", channel_id: "stray-channel" }),
    );
    // Nothing to assert on the mock — the absence of a crash is the test.
  });

  it("does not call ensure_channel_allowlisted when owner_id is not configured", async () => {
    const bot = make_bot(undefined);
    const ensure = vi.fn().mockResolvedValue(undefined);
    bot.set_commander({
      ensure_channel_allowlisted: ensure,
    } as unknown as CommanderProcess);

    await bot.invoke_handle_message(
      fake_message({ author_id: "anyone", channel_id: "stray-channel" }),
    );

    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not call ensure_channel_allowlisted for bot-authored messages", async () => {
    const bot = make_bot("owner-id");
    const ensure = vi.fn().mockResolvedValue(undefined);
    bot.set_commander({
      ensure_channel_allowlisted: ensure,
    } as unknown as CommanderProcess);

    await bot.invoke_handle_message(
      fake_message({ author_id: "owner-id", channel_id: "stray-channel", bot: true }),
    );

    expect(ensure).not.toHaveBeenCalled();
  });

  it("swallows ensure_channel_allowlisted failures without throwing", async () => {
    const bot = make_bot("owner-id");
    const ensure = vi.fn().mockRejectedValue(new Error("disk full"));
    bot.set_commander({
      ensure_channel_allowlisted: ensure,
    } as unknown as CommanderProcess);

    await expect(
      bot.invoke_handle_message(
        fake_message({ author_id: "owner-id", channel_id: "stray-channel" }),
      ),
    ).resolves.toBeUndefined();
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
