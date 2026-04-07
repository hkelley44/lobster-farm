import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersistQueue } from "../persist-queue.js";

/** Zero-delay retries for tests that exercise retry logic. */
const FAST_RETRIES = { retry_delays: [0, 0, 0] as const };

describe("PersistQueue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueue triggers persist", async () => {
    const persist_fn = vi.fn().mockResolvedValue(undefined);
    const queue = new PersistQueue(persist_fn);

    queue.enqueue();
    await queue.drain();

    expect(persist_fn).toHaveBeenCalledTimes(1);
  });

  it("multiple rapid enqueues collapse into fewer writes", async () => {
    // persist_fn takes time so we can stack up enqueues while it's writing.
    let resolve_write: (() => void) | null = null;
    const persist_fn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolve_write = resolve;
        }),
    );

    const queue = new PersistQueue(persist_fn);

    // First enqueue starts the write immediately.
    queue.enqueue();

    // These three enqueues happen while the first write is in progress.
    // They should collapse into a single follow-up write.
    queue.enqueue();
    queue.enqueue();
    queue.enqueue();

    // Complete the first write.
    resolve_write!();
    // Yield so the queue can start the next write.
    await tick();

    // Should have started the coalesced second write.
    expect(persist_fn).toHaveBeenCalledTimes(2);

    // Complete the second write.
    resolve_write!();
    await queue.drain();

    // Still only 2 writes total — all the rapid enqueues collapsed.
    expect(persist_fn).toHaveBeenCalledTimes(2);
  });

  it("retries on failure then succeeds", async () => {
    const persist_fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);

    const queue = new PersistQueue(persist_fn, FAST_RETRIES);

    queue.enqueue();
    await queue.drain();

    // Initial attempt + 2 retries + 1 success = 3 calls
    // (first attempt fails, retry 1 fails, retry 2 succeeds)
    expect(persist_fn).toHaveBeenCalledTimes(3);
    expect(queue.failure_count).toBe(0);
  });

  it("logs CRITICAL after 3 consecutive total failures", async () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Always fails — 1 initial + 3 retries = 4 calls per enqueue, all fail.
    const persist_fn = vi.fn().mockRejectedValue(new Error("disk full"));
    const queue = new PersistQueue(persist_fn, FAST_RETRIES);

    // Each enqueue will exhaust retries and increment consecutive_failures.
    // We need 3 consecutive top-level failures (not retries) for CRITICAL.
    queue.enqueue();
    await queue.drain();
    expect(queue.failure_count).toBe(1);

    queue.enqueue();
    await queue.drain();
    expect(queue.failure_count).toBe(2);

    queue.enqueue();
    await queue.drain();
    expect(queue.failure_count).toBe(3);

    // The third failure should have logged CRITICAL
    const critical_calls = error_spy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("CRITICAL"),
    );
    expect(critical_calls.length).toBe(1);
    expect(critical_calls[0]![0]).toContain("3 consecutive persist failures");
  });

  it("resets consecutive failures on success", async () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // First enqueue: all retries fail (4 calls).
    // Second enqueue: succeeds on first try.
    const persist_fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue(undefined);

    const queue = new PersistQueue(persist_fn, FAST_RETRIES);

    queue.enqueue();
    await queue.drain();
    expect(queue.failure_count).toBe(1);

    queue.enqueue();
    await queue.drain();
    expect(queue.failure_count).toBe(0);

    error_spy.mockRestore();
  });

  it("drain resolves after pending writes complete", async () => {
    let resolve_write: (() => void) | null = null;
    const persist_fn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolve_write = resolve;
        }),
    );

    const queue = new PersistQueue(persist_fn);

    queue.enqueue();

    let drained = false;
    const drain_promise = queue.drain().then(() => {
      drained = true;
    });

    // drain should not have resolved yet — write is in progress.
    await tick();
    expect(drained).toBe(false);

    // Complete the write.
    resolve_write!();
    await drain_promise;

    expect(drained).toBe(true);
  });

  it("drain resolves immediately when queue is empty", async () => {
    const persist_fn = vi.fn().mockResolvedValue(undefined);
    const queue = new PersistQueue(persist_fn);

    // No enqueue — drain should resolve immediately.
    await queue.drain();

    expect(persist_fn).not.toHaveBeenCalled();
  });

  it("drain waits for coalesced write too", async () => {
    let resolve_write: (() => void) | null = null;
    const persist_fn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolve_write = resolve;
        }),
    );

    const queue = new PersistQueue(persist_fn);

    queue.enqueue();
    queue.enqueue(); // coalesced

    let drained = false;
    const drain_promise = queue.drain().then(() => {
      drained = true;
    });

    // Complete the first write — coalesced write should start.
    resolve_write!();
    await tick();
    expect(drained).toBe(false);
    expect(persist_fn).toHaveBeenCalledTimes(2);

    // Complete the coalesced write.
    resolve_write!();
    await drain_promise;
    expect(drained).toBe(true);
  });
});

/** Yield to the microtask queue so pending promises resolve. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
