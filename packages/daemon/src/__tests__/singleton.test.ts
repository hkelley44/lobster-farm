import { describe, expect, it } from "vitest";
import { classify_listen_error } from "../singleton.js";

/**
 * Tests for the singleton port guard's error classification (#97).
 *
 * The live socket paths (acquire_port / start_server) call process.exit and
 * bind real ports, so we test the pure decision function that drives them:
 * EADDRINUSE must map to a clean exit 0 (stand aside for the incumbent), any
 * other errno to exit 1 (real fault).
 */

function err(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("classify_listen_error", () => {
  it("treats EADDRINUSE as a clean stand-aside (exit 0)", () => {
    const verdict = classify_listen_error(err("EADDRINUSE"), 7749, 79644);
    expect(verdict.exit_code).toBe(0);
    expect(verdict.message).toContain("already listening on :7749");
    expect(verdict.message).toContain("pid 79644");
  });

  it("omits the pid when the incumbent is unknown", () => {
    const verdict = classify_listen_error(err("EADDRINUSE"), 7749, null);
    expect(verdict.exit_code).toBe(0);
    expect(verdict.message).toContain("already listening on :7749");
    expect(verdict.message).not.toContain("pid");
  });

  it("treats any other errno as a real fault (exit 1)", () => {
    const verdict = classify_listen_error(err("EACCES", "permission denied"), 7749, null);
    expect(verdict.exit_code).toBe(1);
    expect(verdict.message).toContain("fatal listen error on :7749");
    expect(verdict.message).toContain("permission denied");
  });
});
