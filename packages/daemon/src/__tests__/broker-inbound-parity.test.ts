import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";
import { build_broker_inbound } from "../discord.js";

/**
 * The broker-delivered inbound must be byte-identical to the official Discord
 * plugin's `notifications/claude/channel` payload (server.ts:824-879). These
 * tests pin the `content` + `meta` construction against that contract — any
 * drift would change the agent-facing surface and break reply-enforcement
 * harvest (#80) and prompt context.
 */

/** Minimal discord.js Message stand-in — only the fields build_broker_inbound reads. */
function fake_message(overrides: {
  content?: string;
  attachments?: Array<{
    id: string;
    name: string | null;
    size: number;
    contentType: string | null;
  }>;
}): Message {
  const attachments = new Map((overrides.attachments ?? []).map((a, i) => [String(i), a]));
  return {
    channelId: "chan-77",
    id: "msg-88",
    content: overrides.content ?? "",
    author: { username: "hunter", id: "user-1" },
    createdAt: new Date("2026-07-03T12:34:56.000Z"),
    attachments,
  } as unknown as Message;
}

describe("build_broker_inbound parity", () => {
  it("plain text message produces content + core meta, no attachment fields", () => {
    const out = build_broker_inbound(fake_message({ content: "ship it" }));
    expect(out).toEqual({
      channel_id: "chan-77",
      content: "ship it",
      meta: {
        chat_id: "chan-77",
        message_id: "msg-88",
        user: "hunter",
        user_id: "user-1",
        ts: "2026-07-03T12:34:56.000Z",
      },
    });
  });

  it("empty content with an attachment falls back to '(attachment)' like the plugin", () => {
    const out = build_broker_inbound(
      fake_message({
        content: "",
        attachments: [{ id: "a1", name: "diagram.png", size: 4096, contentType: "image/png" }],
      }),
    );
    expect(out.content).toBe("(attachment)");
    expect(out.meta.attachment_count).toBe("1");
    // "name (type, sizeKB)" — 4096 bytes → "4KB".
    expect(out.meta.attachments).toBe("diagram.png (image/png, 4KB)");
  });

  it("multiple attachments join with '; ' and use safe names + unknown type fallback", () => {
    const out = build_broker_inbound(
      fake_message({
        content: "look",
        attachments: [
          { id: "a1", name: "a;b\n[c].txt", size: 1024, contentType: null },
          { id: "a2", name: null, size: 2048, contentType: "application/pdf" },
        ],
      }),
    );
    expect(out.meta.attachment_count).toBe("2");
    // First name is sanitized: ';', newline, '[' and ']' each → '_'. Null
    // contentType → "unknown". "a;b\n[c].txt" → "a_b__c_.txt" (the newline and
    // the '[' are two separate replacements). Second name is null → falls back
    // to the attachment id.
    expect(out.meta.attachments).toBe("a_b__c_.txt (unknown, 1KB); a2 (application/pdf, 2KB)");
  });

  it("keeps real content even when attachments are present (no forgeable annotation)", () => {
    const out = build_broker_inbound(
      fake_message({
        content: "here is the file",
        attachments: [{ id: "a1", name: "x.png", size: 512, contentType: "image/png" }],
      }),
    );
    expect(out.content).toBe("here is the file");
  });
});
