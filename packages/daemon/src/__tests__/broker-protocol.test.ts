import { describe, expect, it } from "vitest";
import { type BrokerEnvelope, NdjsonDecoder, encode_envelope } from "../broker/protocol.js";

/**
 * The NDJSON framing is the shim↔daemon wire contract. These tests lock down
 * the two properties the transport relies on: round-trip fidelity and
 * fail-open decoding (a corrupt frame is skipped, never thrown).
 */
describe("broker NDJSON protocol", () => {
  it("encode_envelope produces a single newline-terminated JSON line", () => {
    const env: BrokerEnvelope = { type: "ack", id: "abc" };
    const line = encode_envelope(env);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1); // exactly one newline, at the end
    expect(JSON.parse(line.trimEnd())).toEqual(env);
  });

  it("round-trips a register envelope", () => {
    const decoder = new NdjsonDecoder();
    const env: BrokerEnvelope = { type: "register", channel_id: "123", bot_id: 7 };
    const { envelopes, errors } = decoder.push(encode_envelope(env));
    expect(errors).toHaveLength(0);
    expect(envelopes).toEqual([env]);
  });

  it("buffers a partial line until its newline arrives", () => {
    const decoder = new NdjsonDecoder();
    const env: BrokerEnvelope = { type: "ack", id: "partial" };
    const full = encode_envelope(env);
    const mid = Math.floor(full.length / 2);

    const first = decoder.push(full.slice(0, mid));
    expect(first.envelopes).toHaveLength(0); // not complete yet
    expect(first.errors).toHaveLength(0);

    const second = decoder.push(full.slice(mid));
    expect(second.envelopes).toEqual([env]);
  });

  it("parses multiple envelopes from one chunk", () => {
    const decoder = new NdjsonDecoder();
    const a: BrokerEnvelope = { type: "ack", id: "1" };
    const b: BrokerEnvelope = { type: "ack", id: "2" };
    const { envelopes } = decoder.push(encode_envelope(a) + encode_envelope(b));
    expect(envelopes).toEqual([a, b]);
  });

  it("skips a malformed frame into errors, keeps parsing valid ones", () => {
    const decoder = new NdjsonDecoder();
    const good: BrokerEnvelope = { type: "ack", id: "ok" };
    const chunk = `not-json{{{\n${encode_envelope(good)}`;
    const { envelopes, errors } = decoder.push(chunk);
    expect(errors).toHaveLength(1);
    expect(envelopes).toEqual([good]); // the valid frame still comes through
  });

  it("ignores blank lines without producing errors", () => {
    const decoder = new NdjsonDecoder();
    const { envelopes, errors } = decoder.push("\n\n   \n");
    expect(envelopes).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
