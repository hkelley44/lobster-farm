/**
 * Sentry helpers for the daemon.
 *
 * Centralizes Sentry imports and provides typed wrappers for common operations.
 * All error capture, breadcrumbs, and cron monitoring go through this module
 * so the rest of the codebase doesn't import @sentry/node directly.
 *
 * If Sentry is not initialized (no DSN), all functions are safe no-ops.
 */

import * as Sentry from "@sentry/node";

// Re-export Sentry for direct access when the wrappers aren't sufficient
export { Sentry };

// ── Error capture ──

interface CaptureContext {
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  fingerprint?: string[];
}

/**
 * Capture an exception with tags and structured context.
 * Safe to call even if Sentry is not initialized.
 */
export function captureException(
  err: unknown,
  ctx?: CaptureContext,
): void {
  Sentry.captureException(err, {
    tags: ctx?.tags,
    contexts: ctx?.contexts,
    fingerprint: ctx?.fingerprint,
  });
}

/**
 * Capture an informational message (not an error).
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = "info",
  ctx?: CaptureContext,
): void {
  Sentry.captureMessage(message, {
    level,
    tags: ctx?.tags,
    contexts: ctx?.contexts,
  });
}

// ── Breadcrumbs ──

interface BreadcrumbData {
  category: string;
  message: string;
  level?: Sentry.SeverityLevel;
  data?: Record<string, unknown>;
}

/**
 * Add a manual breadcrumb at a state transition or decision point.
 */
export function addBreadcrumb(crumb: BreadcrumbData): void {
  Sentry.addBreadcrumb({
    category: crumb.category,
    message: crumb.message,
    level: crumb.level ?? "info",
    data: crumb.data,
  });
}

// ── Cron monitoring ──

interface CronMonitorConfig {
  schedule: { type: "interval"; value: number; unit: "minute" | "hour" | "day" };
  checkinMargin: number;
  maxRuntime: number;
  failureIssueThreshold?: number;
  recoveryThreshold?: number;
}

/**
 * Start a cron check-in. Returns the checkInId for completion.
 */
export function cronCheckInStart(
  monitorSlug: string,
  monitorConfig: CronMonitorConfig,
): string {
  return Sentry.captureCheckIn(
    { monitorSlug, status: "in_progress" },
    monitorConfig,
  );
}

/**
 * Complete a cron check-in with success or error status.
 */
export function cronCheckInFinish(
  checkInId: string,
  monitorSlug: string,
  status: "ok" | "error",
): void {
  Sentry.captureCheckIn({ checkInId, monitorSlug, status });
}

// ── Shutdown ──

/**
 * Flush pending Sentry events. Call during graceful shutdown.
 */
export async function flush(timeout_ms: number = 2000): Promise<void> {
  await Sentry.flush(timeout_ms);
}
