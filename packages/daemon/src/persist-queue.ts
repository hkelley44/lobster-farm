/**
 * Queue-based persistence with retry and deduplication.
 *
 * Mutations remain non-blocking — callers call enqueue() and move on.
 * The queue processes one write at a time, deduplicating if multiple
 * mutations stack up before the first write completes (since we always
 * persist the full current state, not individual mutations).
 */

/** Default exponential backoff delays for retries (ms). */
const DEFAULT_RETRY_DELAYS: readonly number[] = [100, 400, 1600];

export interface PersistQueueOptions {
  /** Override retry backoff delays (ms). Defaults to [100, 400, 1600]. */
  retry_delays?: readonly number[];
}

export class PersistQueue {
  private writing = false;
  private pending = false;
  private consecutive_failures = 0;
  private retry_delays: readonly number[];

  /**
   * Resolvers for drain() callers waiting on the queue to finish.
   * Collected while writes are in progress, resolved when the queue empties.
   */
  private drain_resolvers: Array<() => void> = [];

  constructor(
    private persist_fn: () => Promise<void>,
    opts?: PersistQueueOptions,
  ) {
    this.retry_delays = opts?.retry_delays ?? DEFAULT_RETRY_DELAYS;
  }

  /**
   * Schedule a persist. Returns immediately — the write happens asynchronously.
   * If a write is already in progress, the request is coalesced into a single
   * follow-up write (since we persist full state, not deltas).
   */
  enqueue(): void {
    if (this.writing) {
      // A write is in progress — mark that we need another one after it finishes.
      this.pending = true;
      return;
    }

    void this.process();
  }

  /**
   * Wait for all pending writes to complete. Resolves immediately if the
   * queue is idle. Use during graceful shutdown to ensure no data is lost.
   */
  drain(): Promise<void> {
    if (!this.writing && !this.pending) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.drain_resolvers.push(resolve);
    });
  }

  /** Number of consecutive persist failures (for monitoring). */
  get failure_count(): number {
    return this.consecutive_failures;
  }

  // ── Internal ──

  private async process(): Promise<void> {
    this.writing = true;
    this.pending = false;

    try {
      await this.write_with_retry();
      this.consecutive_failures = 0;
    } catch {
      // Retries exhausted — already logged in write_with_retry.
      // consecutive_failures is incremented there.
    }

    this.writing = false;

    // If enqueue() was called while we were writing, process the coalesced write.
    if (this.pending) {
      void this.process();
      return;
    }

    // Queue is empty — resolve any drain() waiters.
    this.flush_drain_resolvers();
  }

  private async write_with_retry(): Promise<void> {
    const max_retries = this.retry_delays.length;

    for (let attempt = 0; attempt <= max_retries; attempt++) {
      try {
        await this.persist_fn();
        return;
      } catch (err) {
        if (attempt < max_retries) {
          const delay = this.retry_delays[attempt]!;
          await sleep(delay);
        } else {
          // All retries exhausted.
          this.consecutive_failures++;
          const msg = err instanceof Error ? err.message : String(err);

          if (this.consecutive_failures >= 3) {
            console.error(
              `[persist-queue] CRITICAL: ${String(this.consecutive_failures)} consecutive persist failures. ` +
                `Latest: ${msg}`,
            );
          } else {
            console.error(
              `[persist-queue] Persist failed after ${String(max_retries)} retries: ${msg}`,
            );
          }

          throw err;
        }
      }
    }
  }

  private flush_drain_resolvers(): void {
    const resolvers = this.drain_resolvers;
    this.drain_resolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
