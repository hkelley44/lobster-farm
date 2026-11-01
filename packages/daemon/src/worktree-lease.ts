/**
 * Per-worktree single-owner mutex (issue #105).
 *
 * A linked git worktree is a *mutable, branch-specific* workspace: uncommitted
 * edits live in it and whoever commits next sweeps up whatever is in the tree.
 * Two agents editing one worktree concurrently is therefore history loss waiting
 * to happen — which is exactly what happened on PR #103: a human-directed
 * builder was addressing review feedback in `worktrees/102-merge-gate-hardening`
 * when the autonomous pr-cron auto-fix loop spawned its own builder into the
 * same tree. The auto-fix builder swept the other agent's uncommitted work into
 * its own commit and pushed the combined tree.
 *
 * This store is the single source of truth for "who owns this worktree". It is
 * the same leasing idiom as `review-lease.ts` (#60/#102) — deliberately so;
 * there is one mutex pattern in this codebase and this is it.
 *
 * ── Two kinds of lease ──
 *
 *   - **Explicit** (`daemon-cron`): taken by a daemon spawn path BEFORE it
 *     spawns, released when the session ends. This is a true mutex: two
 *     concurrent acquire attempts for one worktree cannot both succeed, so two
 *     auto-fix builders can never both be launched into the same tree.
 *
 *   - **Observed** (`agent-observed`): inferred from the Stop hook. Every Claude
 *     Code session on this machine POSTs `{session_id, working_dir}` to
 *     `/hooks/stop` once per completed assistant turn (the hook is installed in
 *     the *global* `~/.claude/settings.json`), and `working_dir` is the agent's
 *     live `$(pwd)`. That makes it the daemon's only inbound signal about agents
 *     it did not spawn — pool bots, a human's CLI session, a commander-dispatched
 *     builder. An observed lease is created on first sighting and renewed on
 *     every subsequent turn, so it stays live exactly as long as the agent keeps
 *     working there.
 *
 * Observed leases are *why* this store catches the #103 incident at all: the
 * colliding agent was not daemon-spawned, so no explicit lease would ever have
 * covered it. See the limitation note on `touch_observed` for what this still
 * cannot see.
 *
 * ── Why a lease here can never become a permanent outage (#105 gate) ──
 *
 * Four independent release mechanisms, each sufficient on its own:
 *
 *   1. **Explicit release.** The holder releases at session end. The auto-fix
 *      loop releases on `session:completed`, on `session:failed`, and in the
 *      `catch` around the spawn itself — the same three-way discipline
 *      `review_pr` uses for the review lease.
 *   2. **Crash reaping via pid.** Once `bind_session` records the worker's pid,
 *      `live_lease` evicts the lease the moment that pid is gone. A holder that
 *      is SIGKILLed — so no handler of ours ever runs — frees its worktree on
 *      the very next lookup, not after a TTL.
 *   3. **TTL.** Every lease expires, unconditionally. Explicit leases default
 *      to 60 min (long enough for a real fix pass); observed leases to 15 min,
 *      rolling forward on each turn. `live_lease` evaluates expiry *after* the
 *      pid check and independently of it, so a live pid only ever reaps a lease
 *      *early* — it never extends one. A lease with a live holder is therefore
 *      no safer from expiry than any other: the holder renews by doing visible
 *      work (`touch_observed` on each completed turn), not by being alive.
 *      Consequence worth knowing: a builder stuck inside a *single* turn longer
 *      than its TTL loses its hold while still working, because the Stop hook
 *      only fires between turns.
 *   4. **Daemon restart.** The store is in-memory only. A restart drops every
 *      lease, so a hold cannot survive the process that created it. (Inherited
 *      from #60's locked design: leases are cheap to lose.)
 *
 * The converse — restart *losing* a live hold and re-opening the race — is a
 * real residual, identical to the one the review lease accepts. It is bounded:
 * an agent still working in the tree re-establishes an observed lease on its
 * very next completed turn.
 *
 * Single-writer: one daemon per machine, so no cross-process coordination. All
 * expiry is lazy (evaluated on lookup) rather than swept by a timer — there is
 * no work to do between calls.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type LobsterFarmConfig, expand_home } from "@lobster-farm/shared";

/** Who owns a worktree lease. */
export type WorktreeLeaseHolder = "daemon-cron" | "agent-observed";

/**
 * Default lifetime of an explicit hold. Tunable via
 * `pr_cron.worktree_lease_ttl_ms`. Generous because a review-fix builder
 * legitimately runs for a long time, and the pid reaper (not the TTL) is the
 * mechanism that handles a crashed holder promptly.
 */
export const DEFAULT_WORKTREE_LEASE_TTL_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Default lifetime of an observed hold, measured from the holder's last
 * completed turn. Tunable via `pr_cron.worktree_observed_ttl_ms`.
 *
 * This is the one genuinely heuristic number in the module. Too short and we
 * stop seeing an agent that is deep inside a single long turn (the Stop hook
 * only fires *between* turns); too long and a worktree stays blocked after its
 * agent has quietly exited. 15 min errs toward blocking, because the cost of
 * over-blocking is a deferred auto-fix that retries on the next cron tick,
 * while the cost of under-blocking is clobbered history.
 */
export const DEFAULT_WORKTREE_OBSERVED_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Cap on tracked leases before a full expiry sweep runs. Observed leases are
 * created for whatever directory any session happens to be in, so the key space
 * is unbounded over a long daemon uptime; lazy expiry alone would never reclaim
 * a path that is never looked up again. The sweep keeps the map proportional to
 * *active* directories rather than to every directory ever seen.
 */
const MAX_TRACKED_LEASES = 256;

export interface WorktreeLease {
  /** Canonical absolute path — see `canonical_worktree_path`. */
  worktree_path: string;
  holder: WorktreeLeaseHolder;
  /**
   * Id of the logical operation that owns this lease. For an explicit hold this
   * is a per-attempt uuid minted *before* the worker session exists (the lease
   * has to be taken before the spawn to be a mutex at all). For an observed
   * hold it is the Claude session id whose turn revealed the occupancy.
   */
  owner_id: string;
  /**
   * Claude session id of the process doing the work, once known. Set by
   * `bind_session` after a spawn returns. Lets later Stop-hook turns from that
   * session be attributed to the lease that already covers them, instead of
   * looking like a second occupant.
   */
  session_id?: string;
  /** OS pid of the worker, once known. Drives crash reaping in `live_lease`. */
  pid?: number;
  acquired_at: string; // ISO
  expires_at: string; // ISO
  /** The TTL this lease renews with. Kept so `touch_observed` can roll it. */
  ttl_ms: number;
}

export type WorktreeAcquireResult =
  | { ok: true; lease: WorktreeLease }
  | { ok: false; current_lease: WorktreeLease };

export type WorktreeReleaseResult = "released" | "not_found" | "forbidden";

/** Outcome of recording a completed turn against a directory. */
export type ObservedResult =
  /** No lease covered this path — an observed lease was created. */
  | "created"
  /** The existing lease belongs to this session — its expiry rolled forward. */
  | "renewed"
  /** A different owner holds this path. Nothing was changed. */
  | "blocked";

/**
 * Normalize a path into the form used as the lease key.
 *
 * Resolves `~`, relative segments and trailing slashes, then collapses symlinks.
 * The symlink step is load-bearing in this repo: `~/.lobsterfarm/src` is also
 * reachable as `~/.lobsterfarm/entities/lobster-farm/repos/lobster-farm`, and
 * without collapsing, two acquires — one via each alias — would both succeed on
 * what is physically one tree.
 *
 * Falls back to the lexical resolution when the path cannot be read (it may not
 * exist yet). That loses only symlink collapsing, never correctness of the
 * lexical normalization.
 */
export function canonical_worktree_path(path: string): string {
  const expanded = resolve(expand_home(path));
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

/** Does `id` identify the owner of this lease (by operation id or session id)? */
function owns(lease: WorktreeLease, id: string): boolean {
  return lease.owner_id === id || lease.session_id === id;
}

export class WorktreeLeaseStore {
  /** Key: canonical worktree path. One lease per worktree. */
  private leases = new Map<string, WorktreeLease>();
  private readonly lease_ttl_ms: number;
  private readonly observed_ttl_ms: number;

  constructor(
    lease_ttl_ms: number = DEFAULT_WORKTREE_LEASE_TTL_MS,
    observed_ttl_ms: number = DEFAULT_WORKTREE_OBSERVED_TTL_MS,
  ) {
    this.lease_ttl_ms = lease_ttl_ms;
    this.observed_ttl_ms = observed_ttl_ms;
  }

  /**
   * Is this pid still running?
   *
   * `process.kill(pid, 0)` sends no signal — it only probes. ESRCH means the
   * process is gone; EPERM means it exists but belongs to another user, which
   * still counts as alive.
   *
   * Pid reuse is the known imprecision: if the OS has recycled the number onto
   * an unrelated process we report "alive" and keep the lease until its TTL.
   * That is the safe direction — a recycled pid can only ever make us hold a
   * worktree slightly too long, never release one that is genuinely in use.
   *
   * `protected` so tests can drive liveness deterministically.
   */
  protected is_pid_alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * The live lease for a key, or null — evicting it if the holder has died or
   * the lease has expired. This is the only place a lease is reaped; every
   * public reader funnels through it, so no caller can observe a dead lease.
   */
  private live_lease(key: string, now: number): WorktreeLease | null {
    const lease = this.leases.get(key);
    if (!lease) return null;

    // Crash reaping first: a dead holder frees the tree immediately, without
    // waiting out the TTL.
    if (lease.pid !== undefined && !this.is_pid_alive(lease.pid)) {
      this.leases.delete(key);
      return null;
    }

    if (new Date(lease.expires_at).getTime() <= now) {
      this.leases.delete(key);
      return null;
    }

    return lease;
  }

  /** Re-evaluate every lease, dropping the dead ones. See MAX_TRACKED_LEASES. */
  private sweep_if_crowded(now: number): void {
    if (this.leases.size <= MAX_TRACKED_LEASES) return;
    for (const key of [...this.leases.keys()]) {
      this.live_lease(key, now);
    }
  }

  /**
   * Take the lease for a worktree.
   *
   * - No live lease → granted.
   * - Live lease owned by `owner_id` → idempotent; returned unchanged. The
   *   expiry is deliberately NOT extended, so re-asking is not a way to hold a
   *   worktree forever (use `touch_observed`, which renews only on evidence of
   *   real work).
   * - Live lease owned by anyone else → conflict, with the current holder
   *   returned so the caller can say *who* blocked it.
   */
  acquire(
    worktree_path: string,
    holder: WorktreeLeaseHolder,
    owner_id: string,
    opts: { ttl_ms?: number } = {},
  ): WorktreeAcquireResult {
    const key = canonical_worktree_path(worktree_path);
    const now = Date.now();
    this.sweep_if_crowded(now);

    const existing = this.live_lease(key, now);
    if (existing) {
      if (owns(existing, owner_id)) return { ok: true, lease: existing };
      return { ok: false, current_lease: existing };
    }

    const ttl_ms = opts.ttl_ms ?? this.lease_ttl_ms;
    const lease: WorktreeLease = {
      worktree_path: key,
      holder,
      owner_id,
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl_ms).toISOString(),
      ttl_ms,
    };
    this.leases.set(key, lease);
    return { ok: true, lease };
  }

  /**
   * Attach the worker's identity to a lease once it exists.
   *
   * Two things become possible only after this call: the pid reaper can free
   * the worktree if the worker dies, and the worker's own Stop-hook turns are
   * recognized as the lease holder rather than as a second occupant.
   *
   * Returns false when no live lease owned by `owner_id` is there to bind —
   * callers treat that as "nothing to do", never as an error.
   */
  bind_session(
    worktree_path: string,
    owner_id: string,
    session_id: string,
    pid?: number | null,
  ): boolean {
    const key = canonical_worktree_path(worktree_path);
    const lease = this.live_lease(key, Date.now());
    if (!lease || lease.owner_id !== owner_id) return false;

    lease.session_id = session_id;
    if (pid != null) lease.pid = pid;
    return true;
  }

  /**
   * Release a lease.
   *
   * - "released": a live lease existed and `owner_id` owned it.
   * - "not_found": no live lease for this worktree.
   * - "forbidden": a live lease exists but someone else owns it — we never
   *   release another owner's hold.
   */
  release(worktree_path: string, owner_id: string): WorktreeReleaseResult {
    return this.release_key(canonical_worktree_path(worktree_path), owner_id);
  }

  /**
   * Release a lease by the exact key it was stored under (#105, review 🟡-7).
   *
   * `canonical_worktree_path` collapses symlinks only when the path still
   * exists, falling back to lexical resolution when it does not. So acquiring
   * and releasing by *path* are not guaranteed to produce the same key if the
   * worktree is deleted mid-hold — which happens on this platform, where
   * `cleanup_after_merge` removes the tree while the fixer session may still be
   * winding down. A diverged key means `release` finds nothing, returns
   * "not_found", and leaves a phantom entry behind.
   *
   * A holder that kept its `WorktreeLease` releases through here instead, using
   * `lease.worktree_path` — the key the store actually chose at acquire time —
   * so the two operations cannot disagree by construction rather than by the
   * caller happening to pass a pre-canonicalized string.
   */
  release_held(lease: WorktreeLease, owner_id: string): WorktreeReleaseResult {
    return this.release_key(lease.worktree_path, owner_id);
  }

  private release_key(key: string, owner_id: string): WorktreeReleaseResult {
    const existing = this.live_lease(key, Date.now());
    if (!existing) return "not_found";
    if (!owns(existing, owner_id)) return "forbidden";
    this.leases.delete(key);
    return "released";
  }

  /** The live lease for a worktree, or null. Reaps dead/expired leases. */
  get(worktree_path: string): WorktreeLease | null {
    return this.live_lease(canonical_worktree_path(worktree_path), Date.now());
  }

  /** Does `owner_id` currently hold the live lease for this worktree? */
  holds(worktree_path: string, owner_id: string): boolean {
    const lease = this.get(worktree_path);
    return lease != null && owns(lease, owner_id);
  }

  /**
   * Record that `session_id` completed a turn in `working_dir`.
   *
   * Called from the Stop hook for every Claude session on the machine, which is
   * how the daemon learns about occupants it did not spawn. In-memory upsert,
   * because this runs once per turn per session inside a hook with a tight time
   * budget.
   *
   * The one non-memory cost is `canonical_worktree_path`, which does a
   * *synchronous* `realpathSync` on the daemon's single event loop. That is a
   * deliberate tradeoff and not free: the right call today (a few stat()s on a
   * warm dentry cache, versus making the whole hook path async for a gate that
   * must not slow an agent's turn), but it is a scaling tripwire. If the daemon
   * ever fields turns from many sessions at a high rate, or the repo root moves
   * onto a network filesystem, this is the line to make async first.
   *
   * Never steals or modifies another owner's lease; it only creates a lease
   * where none is live, or rolls its own forward.
   *
   * **Limitation.** The global hook set installs `Stop`, not `SubagentStop`, so
   * this sees *main-agent* turns only. A subagent working in a different
   * directory from its parent is invisible here, and an entity configured with
   * its own `subscription.claude_config_dir` only fires the hook if that config
   * dir also carries it. Observed occupancy is therefore a real but incomplete
   * signal — it is why the explicit lease exists rather than being replaced by
   * this.
   */
  touch_observed(working_dir: string, session_id: string): ObservedResult {
    const key = canonical_worktree_path(working_dir);
    const now = Date.now();
    this.sweep_if_crowded(now);

    const existing = this.live_lease(key, now);
    if (existing) {
      if (!owns(existing, session_id)) return "blocked";
      // Roll the hold forward from this turn using the lease's own TTL, so a
      // long-running explicit hold is kept alive by evidence of real work
      // rather than expiring out from under a session that is still going.
      existing.expires_at = new Date(now + existing.ttl_ms).toISOString();
      return "renewed";
    }

    this.leases.set(key, {
      worktree_path: key,
      holder: "agent-observed",
      owner_id: session_id,
      session_id,
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.observed_ttl_ms).toISOString(),
      ttl_ms: this.observed_ttl_ms,
    });
    return "created";
  }

  /** Number of tracked leases, live or not. Test/diagnostic use only. */
  tracked_count(): number {
    return this.leases.size;
  }
}

/**
 * Build the daemon's worktree lease store from config, or null when the mutex
 * is stood down (#105).
 *
 * This exists as a named, exported function rather than as inline wiring in
 * `index.ts` for one reason: **`index.ts` is not testable.** It ends in a
 * top-level `void main()`, so importing it boots a real daemon and binds the
 * real port — no test can touch it, and nothing in the suite does.
 *
 * That mattered here more than it usually would. The entire #105 store shipped
 * once as 386 lines of fully-implemented, fully-tested dead code, because the
 * one line that constructed it was missing from `index.ts` and no test could
 * see the omission. Review confirmed the hole was still open: replacing the
 * construction with `null` left all 26 lease tests green.
 *
 * Moving the *policy* here — the kill-switch polarity, the TTL threading, the
 * default-on behavior of an absent `pr_cron` block — puts it under test. What
 * necessarily stays in `index.ts` is now a single call with no decisions in it,
 * guarded structurally by `worktree-wiring.test.ts`.
 *
 * Polarity note: the check is `=== false`, not a falsy test. An absent
 * `pr_cron` block, or a present one with no `worktree_lease_enabled` key, must
 * yield a real store — the mutex is default-on, and a machine with no `pr_cron`
 * config at all is exactly the machine most likely to collide.
 */
export function make_worktree_lease_store(config: LobsterFarmConfig): WorktreeLeaseStore | null {
  if (config.pr_cron?.worktree_lease_enabled === false) return null;
  return new WorktreeLeaseStore(
    config.pr_cron?.worktree_lease_ttl_ms,
    config.pr_cron?.worktree_observed_ttl_ms,
  );
}
