import { BotPool } from "../../pool.js";
import type { PoolBot } from "../../pool.js";

/**
 * Shared TestBotPool base for tests that don't need JSONL control.
 *
 * Treats all sessions as present on disk and disables the background watcher.
 * Test files that need custom JSONL behavior (e.g. pool-session-confirmation)
 * should extend BotPool directly and provide their own overrides.
 */
export class BotPoolTestBase extends BotPool {
  /** Default to "JSONL present" so existing pre-#256 expectations hold. */
  protected override check_session_jsonl_exists_anywhere(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override check_session_jsonl_exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  /** Disable the background JSONL confirmation watcher — its deferred
   * persist() can race with afterEach teardown and cause ENOTEMPTY on rmdir. */
  protected override watch_session_confirmation(bot: PoolBot): void {
    bot.session_confirmed = true;
  }

  /** No-op session-end extraction by default. It's fire-and-forget async work
   * (reads the JSONL transcript off disk, then shells to Haiku) that lifecycle
   * tests don't care about — and its in-flight promise races afterEach's rm,
   * causing ENOTEMPTY on teardown. Tests that actually exercise extraction
   * (pool-session-end-extraction) opt back into the real implementation via
   * BotPool.prototype.extract_on_session_end. */
  protected override extract_on_session_end(): Promise<void> {
    return Promise.resolve();
  }
}
