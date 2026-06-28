/**
 * Per-PR review mutex (Layer 2, issue #60).
 *
 * Three independent paths spawn reviewer subagents for a PR:
 *   - the daemon cron (`pr-cron.ts`)
 *   - the GitHub webhook handler (`webhook-handler.ts`)
 *   - Tidus's manual review-merge SOP (the `pr-review-merge` SKILL)
 *
 * Before #60 they shared no state, so two reviewers could collide on the same
 * PR (observed on PR #41 and PR #54). This store is the single source of truth
 * they all acquire a lease from before spawning. One holder per PR at a time;
 * everyone else gets a conflict and backs off.
 *
 * Design (locked by Hunter):
 *   - In-memory only. No disk persistence, no co-location with pr-reviews.json.
 *     Leases are cheap to lose — TTL is 20 min and one extra review on a daemon
 *     restart is negligible (see #60 "Out of scope").
 *   - Lazy expiry. We evict expired leases on every acquire/get rather than
 *     running a background sweeper — there is no work to do between calls.
 *   - Single-writer. One daemon per machine, so no cross-process coordination.
 */

/** Who holds a review lease. The webhook spawn path is in-scope per #60. */
export type LeaseHolder = "daemon-cron" | "daemon-webhook" | "tidus-manual";

const LEASE_HOLDERS: readonly LeaseHolder[] = ["daemon-cron", "daemon-webhook", "tidus-manual"];

/** Narrowing guard for untrusted holder strings arriving over HTTP. */
export function is_lease_holder(value: unknown): value is LeaseHolder {
  return typeof value === "string" && (LEASE_HOLDERS as readonly string[]).includes(value);
}

/** Default lease lifetime. Tunable via `pr_cron.review_lease_ttl_ms`. */
export const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000; // 20 minutes

export interface ReviewLease {
  owner_repo: string; // "hkelley44/lobster-farm"
  pr_number: number;
  holder: LeaseHolder;
  acquired_at: string; // ISO
  expires_at: string; // ISO — acquired_at + ttl_ms
  /** Optional spawn session id, for debug correlation. */
  session_id?: string;
}

export interface AcquireOptions {
  ttl_ms?: number;
  session_id?: string;
}

export type AcquireResult =
  | { ok: true; lease: ReviewLease }
  | { ok: false; current_lease: ReviewLease };

export type ReleaseResult = "released" | "not_found" | "forbidden";

export class ReviewLeaseStore {
  // Key: `${owner_repo}#${pr_number}`. One lease per PR.
  private leases = new Map<string, ReviewLease>();
  private default_ttl_ms: number;

  constructor(default_ttl_ms: number = DEFAULT_LEASE_TTL_MS) {
    this.default_ttl_ms = default_ttl_ms;
  }

  private static key(owner_repo: string, pr_number: number): string {
    return `${owner_repo}#${String(pr_number)}`;
  }

  /**
   * Drop a lease if it's past its `expires_at`. Returns the live lease, or
   * null if it was expired (and evicted) or never existed. This is the only
   * place expiry happens — acquire/get both funnel through it.
   */
  private live_lease(key: string, now: number): ReviewLease | null {
    const lease = this.leases.get(key);
    if (!lease) return null;
    if (new Date(lease.expires_at).getTime() <= now) {
      this.leases.delete(key);
      return null;
    }
    return lease;
  }

  /**
   * Acquire the lease for a PR.
   *
   * - No live lease → grant a fresh one to `holder`.
   * - Live lease held by the SAME holder → idempotent: return the existing
   *   lease unchanged. We deliberately do NOT extend `expires_at` — re-acquiring
   *   must not let a holder hold the lease forever by re-asking.
   * - Live lease held by a DIFFERENT holder → conflict; return that lease.
   */
  acquire(
    owner_repo: string,
    pr_number: number,
    holder: LeaseHolder,
    opts: AcquireOptions = {},
  ): AcquireResult {
    const key = ReviewLeaseStore.key(owner_repo, pr_number);
    const now = Date.now();
    const existing = this.live_lease(key, now);

    if (existing) {
      // Same holder re-acquiring → idempotent, return as-is (no extension).
      if (existing.holder === holder) {
        return { ok: true, lease: existing };
      }
      // Different holder still holds it → conflict.
      return { ok: false, current_lease: existing };
    }

    const ttl_ms = opts.ttl_ms ?? this.default_ttl_ms;
    const lease: ReviewLease = {
      owner_repo,
      pr_number,
      holder,
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl_ms).toISOString(),
      ...(opts.session_id ? { session_id: opts.session_id } : {}),
    };
    this.leases.set(key, lease);
    return { ok: true, lease };
  }

  /**
   * Release a lease.
   *
   * - "released": the lease existed and `holder` owned it (now removed).
   * - "not_found": no live lease for this PR.
   * - "forbidden": a live lease exists but a different holder owns it — we do
   *   NOT release someone else's lease.
   */
  release(owner_repo: string, pr_number: number, holder: LeaseHolder): ReleaseResult {
    const key = ReviewLeaseStore.key(owner_repo, pr_number);
    const existing = this.live_lease(key, Date.now());
    if (!existing) return "not_found";
    if (existing.holder !== holder) return "forbidden";
    this.leases.delete(key);
    return "released";
  }

  /** Current live lease for a PR, or null. Evicts the lease if expired. */
  get(owner_repo: string, pr_number: number): ReviewLease | null {
    return this.live_lease(ReviewLeaseStore.key(owner_repo, pr_number), Date.now());
  }
}
