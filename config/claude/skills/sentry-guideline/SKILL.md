---
name: sentry-guideline
description: >
  Sentry error monitoring integration standards. Auto-loads when integrating
  Sentry, adding error tracking, setting up observability, or configuring
  alerting. Covers SDK init, error capture, breadcrumbs, cron monitoring,
  source maps, noise reduction, and webhook forwarding.
---

# Sentry Integration Guideline

_Universal standards for integrating Sentry into any LobsterFarm entity. Not project-specific -- this is the shared foundation._

---

## Philosophy

**Errors should wake you up, not drown you.** Good observability means every real problem surfaces quickly, and every non-problem stays quiet. The goal is a Sentry dashboard where every unresolved issue is actionable.

**Context is everything.** A bare stack trace is barely useful. Tags for filtering, structured context for debugging, breadcrumbs for the timeline -- these turn "something broke" into "here's exactly what happened."

**Capture at the boundary, not everywhere.** Instrument error boundaries, catch blocks, and integration points. Don't sprinkle `captureException` in every function -- that creates noise and duplicates.

---

## SDK Init Pattern

### Dedicated instrument file

Create a separate `instrument.ts` that initializes Sentry before anything else. The v8 SDK uses OpenTelemetry under the hood, so it **must** load before all other imports.

```typescript
// src/instrument.ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
  release: `{package-name}@${process.env.GIT_SHA || 'unknown'}`,
  sampleRate: 1.0,
  normalizeDepth: 5,
  attachStacktrace: true,
  maxBreadcrumbs: 50,
  sendDefaultPii: false,
  ignoreErrors: [
    /ECONNRESET/,
    /ECONNREFUSED/,
    /socket hang up/,
  ],
  beforeSend(event, hint) {
    // Filter known operational noise
    return event;
  },
});
```

### Loading order

For ESM projects (Node 18.19+), use the `--import` flag:

```bash
node --import ./dist/instrument.js ./dist/index.js
```

The `instrument.ts` must be a **separate build entry point** so it compiles independently. In tsup:

```typescript
entry: ['src/index.ts', 'src/instrument.ts'],
```

### DSN from environment

DSN comes from 1Password, injected via `op run`. Never hardcoded.

```
# .env.op
SENTRY_DSN=op://command-center/sentry/dsn
```

### Required config fields

| Field | Value | Why |
|-------|-------|-----|
| `dsn` | From env | Connection string |
| `environment` | `NODE_ENV` or `'production'` | Filters in Sentry UI |
| `release` | `{pkg}@{git-sha}` | Regression detection, source maps |
| `sampleRate` | `1.0` | All errors captured |
| `normalizeDepth` | `5` | Deep enough for nested context objects |
| `attachStacktrace` | `true` | Stack traces on `captureMessage` too |
| `maxBreadcrumbs` | `50` | Enough history without bloat |
| `sendDefaultPii` | `false` | No user IPs, cookies, etc. |

### tracesSampleRate

Set based on traffic volume:

- **Low-traffic services** (daemons, crons): `1.0` -- capture everything
- **Medium-traffic APIs**: `0.1` to `0.5`
- **High-traffic services**: `0.01` to `0.1`
- **Omit entirely** if you do not want tracing -- setting `0` still initializes OpenTelemetry machinery

---

## Error Capturing Standards

### captureException vs captureMessage

- `Sentry.captureException(error)` -- for Error objects (stack traces, grouping)
- `Sentry.captureMessage(msg, level)` -- for informational events without an error

### Never capture AND re-throw

This creates duplicates. Pick one:

```typescript
// WRONG: captured twice if caller also catches
catch (err) {
  Sentry.captureException(err);
  throw err;
}

// RIGHT: capture at the boundary, log for local visibility
catch (err) {
  console.error(`[module] Operation failed: ${err}`);
  Sentry.captureException(err, {
    tags: { module: 'module-name' },
    contexts: { operation: { /* relevant context */ } },
  });
}
```

### Always add context

Bare `captureException(error)` is an anti-pattern. Always include:

- **Tags** -- low-cardinality values for filtering/searching in the Sentry UI
- **Contexts** -- structured data viewable on the issue detail page

```typescript
Sentry.captureException(err, {
  tags: {
    module: 'webhook',
    entity: entity_id,
    webhook_source: 'github',
  },
  contexts: {
    pr: { number: pr.number, title: pr.title, branch: pr.headRefName },
  },
});
```

### Tag taxonomy

Standard tags every project should use:

| Tag | Description | Example values |
|-----|-------------|----------------|
| `module` | Which subsystem | `server`, `webhook`, `cron`, `pool` |
| `entity` | Which project/entity | `lobster-farm`, `alpha` |
| `environment` | Deploy environment | `production`, `staging`, `development` |

Plus domain-specific tags defined per project. Keep tag **values** low-cardinality. High-cardinality IDs (session IDs, PR numbers) go in `contexts`, not tags.

### Isolation scopes for non-HTTP work

For cron jobs, queue handlers, and subprocess execution, wrap in `withIsolationScope()` to prevent context bleed:

```typescript
Sentry.withIsolationScope(async (scope) => {
  scope.setTag('cron.job', 'pr-review');
  scope.setContext('tick', { entity_id, pr_count: prs.length });
  await process_tick();
});
```

---

## Breadcrumb Standards

### When to add manual breadcrumbs

- State transitions (lifecycle changes, phase advances)
- External service calls (API calls, webhook sends)
- Decision points (branching logic that affects behavior)

### When NOT to add breadcrumbs

- High-frequency events (every request, every heartbeat)
- Redundant with automatic instrumentation (HTTP requests are auto-captured)

### Category naming

Use `{domain}.{subcategory}`:

- `daemon.lifecycle` -- startup, shutdown, restart
- `daemon.pool` -- bot assignment, release, park, resume
- `daemon.feature` -- phase transitions
- `daemon.api` -- external API calls
- `daemon.state` -- config reloads, state mutations

```typescript
Sentry.addBreadcrumb({
  category: 'daemon.pool',
  message: `Assigned pool-${bot_id} to channel ${channel_id}`,
  level: 'info',
  data: { bot_id, channel_id, entity_id, archetype },
});
```

---

## Cron Monitoring

Wrap recurring tasks with `Sentry.captureCheckIn()`:

```typescript
const checkInId = Sentry.captureCheckIn(
  { monitorSlug: 'job-name', status: 'in_progress' },
  {
    schedule: { type: 'interval', value: 30, unit: 'minute' },
    checkinMargin: 5,
    maxRuntime: 15,
    failureIssueThreshold: 3,
    recoveryThreshold: 2,
  },
);

try {
  await run_job();
  Sentry.captureCheckIn({ checkInId, monitorSlug: 'job-name', status: 'ok' });
} catch (err) {
  Sentry.captureCheckIn({ checkInId, monitorSlug: 'job-name', status: 'error' });
  Sentry.captureException(err);
}
```

### Configuration guidelines

| Field | Rule |
|-------|------|
| `schedule` | Match the actual interval |
| `checkinMargin` | How late a check-in can be before considered missed. Set <= interval |
| `maxRuntime` | Based on expected duration + generous buffer |
| `failureIssueThreshold` | `3` -- avoid noise from single transient failures |
| `recoveryThreshold` | `2` -- require sustained recovery before resolving |

---

## Source Maps

### Build-time upload via esbuild plugin

For tsup/esbuild projects, use `@sentry/esbuild-plugin`:

```typescript
import { sentryEsbuildPlugin } from '@sentry/esbuild-plugin';

export default defineConfig({
  sourcemap: true,
  esbuildPlugins: process.env.SENTRY_AUTH_TOKEN ? [
    sentryEsbuildPlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ] : [],
});
```

### Conditional activation

The plugin only activates when `SENTRY_AUTH_TOKEN` is present. Local `npm run build` works without credentials. CI/CD builds inject secrets via `op run`.

### Build-time secrets

```
# .env.op (add alongside SENTRY_DSN)
SENTRY_AUTH_TOKEN=op://command-center/sentry/token
SENTRY_ORG=op://command-center/sentry/org
SENTRY_PROJECT=op://command-center/sentry/project
```

Build command: `op run --env-file .env.op -- npm run build`

---

## Release Tracking

### Format

`{package-name}@{git-sha-short}`

Example: `lobsterfarm-daemon@a1b2c3d`

For tagged releases, use semver: `lobsterfarm-daemon@1.2.3`

### Injection

Capture git SHA at build or startup time:

```bash
export GIT_SHA=$(git rev-parse --short HEAD)
```

Pass as environment variable to the running process.

---

## Noise Reduction

### beforeSend hook

Drop expected operational states that are handled by application logic:

```typescript
beforeSend(event, hint) {
  const err = hint.originalException;
  // Rate limits handled by retry logic
  if (err instanceof Error && err.message.includes('rate limit')) return null;
  return event;
},
```

### beforeSendTransaction hook

Drop high-frequency, low-value transactions:

```typescript
beforeSendTransaction(event) {
  if (event.transaction === 'GET /status') return null;
  return event;
},
```

### ignoreErrors

Regex patterns for transient network errors that resolve themselves:

```typescript
ignoreErrors: [
  /ECONNRESET/,
  /ECONNREFUSED/,
  /socket hang up/,
  /ETIMEDOUT/,
],
```

### Custom fingerprinting

When error messages contain dynamic data (IDs, timestamps), set a stable fingerprint:

```typescript
Sentry.captureException(err, {
  fingerprint: ['webhook-handler', entity_id, 'spawn-failure'],
});
```

Without this, each unique message creates a new issue.

### Alert rules

Configure in Sentry UI:
- Frequency thresholds, not every-event
- Different thresholds for different environments
- Digest mode for high-volume alerts

---

## Webhook Forwarding

### Sentry to Discord

For daemon-managed projects, forward Sentry alerts to the entity's Discord `#alerts` channel:

1. Create a Sentry Internal Integration with a webhook URL
2. Subscribe to `issue` events (created, resolved, assigned, archived)
3. Verify HMAC-SHA256 signature (`Sentry-Hook-Signature` header)
4. Read `Sentry-Hook-Resource` header for event type
5. Respond 200 within 1 second (Sentry timeout) -- process asynchronously
6. Map Sentry project to entity, format embed, post to `#alerts`

### Signature verification

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify_sentry_signature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
```

---

## Graceful Shutdown

Call `Sentry.flush()` before process exit to ensure pending events are sent:

```typescript
process.on('SIGTERM', async () => {
  await Sentry.flush(2000); // 2 second timeout
  process.exit(0);
});
```

For uncaught exceptions, flush synchronously before crashing:

```typescript
process.on('uncaughtException', async (err) => {
  Sentry.captureException(err, { tags: { severity: 'fatal' } });
  await Sentry.flush(2000);
  process.exit(1);
});
```

---

## Anti-Patterns

| Anti-pattern | Why it's bad | Fix |
|-------------|-------------|-----|
| Capturing every 4xx | Floods dashboard with expected behavior | Only capture 5xx and unexpected 4xx |
| Dynamic data in error messages | `"Failed for PR #${n}"` creates N separate issues | Use stable message + context/tags for the variable part |
| Bare `captureException(error)` | No context makes triage impossible | Always add tags and contexts |
| `tracesSampleRate: 0` | Still initializes OpenTelemetry machinery | Omit the field entirely to disable tracing |
| Never resolving issues | Kills regression detection -- new occurrences blend in | Resolve issues when fixed; Sentry reopens on regression |
| Capturing AND re-throwing | Duplicates every error | Capture at the boundary only |
| Hardcoded DSN in source | Credential leak, can't rotate | Use env var via 1Password |

---

## Secrets

All Sentry credentials in 1Password:

```
# .env.op
SENTRY_DSN=op://command-center/sentry/dsn
SENTRY_AUTH_TOKEN=op://command-center/sentry/token
SENTRY_ORG=op://command-center/sentry/org
SENTRY_PROJECT=op://command-center/sentry/project
```

- DSN injected at runtime via `op run`
- Auth token injected at build time for source map upload
- Never in code, never in CI env vars directly, never in `.env` files committed to git
