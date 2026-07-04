import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type OutboundContext,
  OutboundExecutor,
  bot_user_id_from_token,
  chunk_text,
} from "../broker/outbound.js";

/**
 * A synthetic bot token whose first "." segment base64-decodes to a snowflake
 * (so fetch_messages can identify "me"). "12345" → base64 "MTIzNDU=".
 */
const BOT_USER_ID = "12345";
const TOKEN = `${Buffer.from(BOT_USER_ID, "utf-8").toString("base64")}.sig.part`;

function json_response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("broker outbound executor", () => {
  let dir: string;
  let ctx: OutboundContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "broker-outbound-test-"));
    await writeFile(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`, "utf-8");
    ctx = {
      state_dir: dir,
      inbox_dir: join(dir, "inbox"),
      chunk_config: {},
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reply sends via the per-bot token and returns the plugin's single-part string", async () => {
    const fetch_impl = vi.fn(async () => json_response({ id: "999" }));
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);

    const result = await exec.execute("reply", { chat_id: "c1", text: "hello" }, ctx);

    expect(result).toEqual({ text: "sent (id: 999)", is_error: false });
    // Identity: the Authorization header carries THIS bot's token.
    const [, init] = fetch_impl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bot ${TOKEN}`,
    });
  });

  it("reply chunks long text and returns the multi-part string with all ids", async () => {
    let n = 0;
    const fetch_impl = vi.fn(async () => json_response({ id: `id${++n}` }));
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);

    // 2500 chars > 2000 limit → two chunks.
    const long = "x".repeat(2500);
    const result = await exec.execute("reply", { chat_id: "c1", text: long }, ctx);

    expect(fetch_impl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ text: "sent 2 parts (ids: id1, id2)", is_error: false });
  });

  it("react returns 'reacted'", async () => {
    const fetch_impl = vi.fn(async () => new Response(null, { status: 204 }));
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);
    const result = await exec.execute(
      "react",
      { chat_id: "c1", message_id: "m1", emoji: "👀" },
      ctx,
    );
    expect(result).toEqual({ text: "reacted", is_error: false });
  });

  it("edit_message returns 'edited (id: X)'", async () => {
    const fetch_impl = vi.fn(async () => json_response({ id: "m1" }));
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);
    const result = await exec.execute(
      "edit_message",
      { chat_id: "c1", message_id: "m1", text: "updated" },
      ctx,
    );
    expect(result).toEqual({ text: "edited (id: m1)", is_error: false });
  });

  it("fetch_messages renders the plugin's line format, oldest-first, marking 'me'", async () => {
    const fetch_impl = vi.fn(async () =>
      // Discord returns newest-first.
      json_response([
        {
          id: "m2",
          content: "second",
          author: { id: BOT_USER_ID, username: "lf-pool-3" },
          timestamp: "2026-07-03T00:00:02.000Z",
          attachments: [],
        },
        {
          id: "m1",
          content: "first",
          author: { id: "u1", username: "hunter" },
          timestamp: "2026-07-03T00:00:01.000Z",
          attachments: [{ id: "a", filename: "x.png", size: 10, url: "http://x" }],
        },
      ]),
    );
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);
    const result = await exec.execute("fetch_messages", { channel: "c1" }, ctx);

    expect(result.is_error).toBe(false);
    // Oldest first: m1 (with +1att) then m2 (from "me").
    expect(result.text).toBe(
      "[2026-07-03T00:00:01.000Z] hunter: first  (id: m1 +1att)\n" +
        "[2026-07-03T00:00:02.000Z] me: second  (id: m2)",
    );
  });

  it("download_attachment writes files to the inbox and lists them", async () => {
    const fetch_impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages/")) {
        return json_response({
          id: "m1",
          content: "",
          author: { id: "u1", username: "hunter" },
          timestamp: "2026-07-03T00:00:00.000Z",
          attachments: [
            {
              id: "att1",
              filename: "photo.png",
              size: 2048,
              url: "http://cdn/photo.png",
              content_type: "image/png",
            },
          ],
        });
      }
      // CDN download.
      return new Response(Buffer.from("PNGDATA"));
    });
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch, () => 1_700_000_000);
    const result = await exec.execute(
      "download_attachment",
      { chat_id: "c1", message_id: "m1" },
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.text).toContain("downloaded 1 attachment(s):");
    expect(result.text).toContain("(photo.png, image/png, 2KB)");
  });

  it("reply REFUSES to send the bot's own state (.env token exfil guard)", async () => {
    // The .env holding DISCORD_BOT_TOKEN is written by the test setup at
    // <state_dir>/.env. A session must never be able to upload it.
    const fetch_impl = vi.fn(async () => json_response({ id: "999" }));
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);

    const result = await exec.execute(
      "reply",
      { chat_id: "c1", text: "here", files: [join(dir, ".env")] },
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.text).toContain("refusing to send channel state");
    // Guard fires BEFORE any Discord call — nothing left the machine.
    expect(fetch_impl).not.toHaveBeenCalled();
  });

  it("reply ALLOWS sending a file from the inbox (downloaded attachment)", async () => {
    // inbox/ is the one subtree under state_dir the agent may re-send from.
    await mkdir(ctx.inbox_dir, { recursive: true });
    const inbox_file = join(ctx.inbox_dir, "x.png");
    await writeFile(inbox_file, "PNGDATA", "utf-8");

    const fetch_impl = vi.fn(async () => json_response({ id: "777" }));
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);

    const result = await exec.execute(
      "reply",
      { chat_id: "c1", text: "here", files: [inbox_file] },
      ctx,
    );

    expect(result).toEqual({ text: "sent (id: 777)", is_error: false });
    expect(fetch_impl).toHaveBeenCalledTimes(1);
  });

  it("a REST failure becomes a fail-open error result, never a throw", async () => {
    const fetch_impl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);
    const result = await exec.execute("reply", { chat_id: "c1", text: "hi" }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.text).toContain("reply failed");
  });

  it("a missing .env token becomes an error result", async () => {
    await rm(join(dir, ".env"));
    const fetch_impl = vi.fn();
    const exec = new OutboundExecutor(fetch_impl as unknown as typeof fetch);
    const result = await exec.execute("react", { chat_id: "c", message_id: "m", emoji: "x" }, ctx);
    expect(result.is_error).toBe(true);
    expect(fetch_impl).not.toHaveBeenCalled();
  });

  it("bot_user_id_from_token decodes the snowflake from the first segment", () => {
    expect(bot_user_id_from_token(TOKEN)).toBe(BOT_USER_ID);
    expect(bot_user_id_from_token("not-a-token")).toBeNull();
  });

  it("chunk_text matches the plugin split behavior", () => {
    expect(chunk_text("short", 2000, "length")).toEqual(["short"]);
    const two = chunk_text("a".repeat(3000), 2000, "length");
    expect(two).toHaveLength(2);
    expect(two[0]!.length).toBe(2000);
    expect(two[1]!.length).toBe(1000);
  });
});
