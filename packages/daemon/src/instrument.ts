/**
 * Sentry SDK initialization — loaded before all other imports via `node --import`.
 *
 * This file is a separate tsup entry point so it compiles independently.
 * The v8 SDK uses OpenTelemetry under the hood, which requires early loading
 * to properly instrument Node.js built-in modules (http, fs, etc.).
 *
 * DSN is injected from 1Password at runtime via `op run`.
 */

import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env["SENTRY_DSN"],
  environment: process.env["NODE_ENV"] || "production",
  release: `lobsterfarm-daemon@${process.env["GIT_SHA"] || "unknown"}`,
  tracesSampleRate: 1.0, // low-traffic daemon — capture everything
  sampleRate: 1.0,
  normalizeDepth: 5,
  attachStacktrace: true,
  maxBreadcrumbs: 50,
  sendDefaultPii: false,
  ignoreErrors: [
    /ECONNRESET/,
    /ECONNREFUSED/,
    /socket hang up/,
    /ETIMEDOUT/,
  ],
  beforeSend(event, hint) {
    const err = hint.originalException;
    // Discord.js handles rate limits internally via retry — drop from Sentry
    if (err instanceof Error && err.message.includes("rate limit")) return null;
    return event;
  },
  beforeSendTransaction(event) {
    // Drop health check noise — high frequency, zero diagnostic value
    if (event.transaction === "GET /status") return null;
    return event;
  },
});
