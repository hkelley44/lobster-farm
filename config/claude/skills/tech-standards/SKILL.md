---
name: tech-standards
description: >
  Architectural best practices and team technology standards. Auto-loads during
  feature planning, implementation, and code review. Defines WHAT tools and
  patterns to use — not HOW to use them (that's coding-dna).
---

# Tech Standards — Architectural Decision Guide

_When you need X, use Y. These aren't opinions — they're the established best practices for this team's stack._

This guide operates at the **architectural decision** level. It tells you what to choose.
Implementation details live in coding-dna. Process lives in planning-dna.

---

## General Principles

**Match the entity's existing stack.** Before proposing any tool or pattern, check what the entity already uses (MEMORY.md, existing codebase). If sonar uses Auth.js, canal-street should too — unless there's a documented, compelling reason not to.

**Check across entities.** The team's established patterns span all projects. What one entity uses is likely the team standard. Read other entities' MEMORY.md files to understand the shared toolkit.

**Use established libraries before rolling your own.** Auth.js exists so you don't write cookie handling. TanStack Query exists so you don't write cache invalidation. The boring choice is the right choice.

**Consistency > novelty.** New tools have onboarding cost, documentation cost, and maintenance cost. Only introduce them when the existing tool genuinely cannot handle the requirement — not because something newer exists.

---

## Authentication

| Context | Standard | Notes |
|---------|----------|-------|
| Next.js app | **Auth.js** (formerly NextAuth) | Handles sessions, CSRF, providers, secure cookies |
| Python API | **JWT with established library** | python-jose or PyJWT, not hand-rolled verification |
| Service-to-service | **API keys or IAM roles** | Depends on infrastructure |

**Never spec manual cookie/JWT session handling for a Next.js app.** Auth.js handles this correctly — secure HttpOnly cookies, CSRF protection, session management, provider integration. Rolling your own means reimplementing security-critical code that Auth.js already solves.

If Auth.js genuinely cannot handle a requirement (unusual OAuth flow, non-standard provider, specific token format), document WHY before proposing an alternative.

---

## Rendering & Data Fetching (Next.js)

**Server components are the default.** Every component is a server component unless it needs browser APIs or interactivity.

| Data Type | Pattern | Where |
|-----------|---------|-------|
| Static / semi-static | Server component + `fetch()` with `next: { revalidate: N }` | Server |
| User-specific | Server component with auth check | Server |
| Interactive / real-time | Client component + TanStack Query | Client |
| True real-time (prices, trades) | Client component + WebSocket/SSE | Client |

### Rules

- **Push `"use client"` down the tree.** Never at layout or shell level. Extract interactive parts into small client leaf components.
- **Server-side fetch for anything that doesn't need real-time updates.** Pages that display data should be server components, not client components with useQuery.
- **Polling > 30s interval is acceptable.** Polling at 3-5s is wasteful — use WebSocket/SSE for true real-time.
- **ISR (`revalidate`) for data that changes hourly/daily.** Exchange metadata, token lists, configuration — these don't need client-side fetching.

---

## State Management

| Need | Tool | When |
|------|------|------|
| Server-fetchable data | Server components | Data available at request time, no interactivity needed |
| Client async state | TanStack Query | Caching, dedup, stale-while-revalidate, polling |
| Client UI state | React useState / useReducer | Form state, toggles, local UI interactions |
| Complex cross-component state | Zustand (if needed) | Only when the above three genuinely can't handle it |

Don't reach for global state management (Redux, Zustand, Jotai) by default. Server components + TanStack Query eliminate most of the use cases that drove adoption of those tools.

---

## API Design

**Proxy pattern for 3rd-party APIs.** Browser never calls external APIs directly.

```
Browser → Next.js Route Handler → External API
```

This keeps secrets server-side, enables response caching, and allows error normalization.

### Route Handlers

- Set `Cache-Control` headers for cacheable responses
- Return proper HTTP status codes (404 = not found, 502 = upstream failed, 400 = bad request)
- Use server actions for mutations when the caller is a server component

### REST Standards

- Proper HTTP status codes — not everything is 200 with `{ success: false }`
- Typed exception hierarchies with `retryable` flag (see coding-dna error handling)
- Consistent error response shape across endpoints

---

## Error Handling & UX

- **`loading.tsx`** in each route segment — instant loading states via Suspense
- **`error.tsx`** in each route segment — graceful error recovery with retry
- **Suspense boundaries** around async content — enables streaming SSR
- **Typed exceptions** with `retryable` flag at the API layer (see coding-dna)

---

## Infrastructure

| Need | Standard | Notes |
|------|----------|-------|
| Container workloads | **AWS ECS (Fargate)** | Team's established pattern |
| CI/CD | **GitHub Actions** | Path-filtered for monorepos |
| Secrets | **1Password** | `op run --env-file`, never hardcode |
| Database | **PostgreSQL** | RDS in production, local for dev |
| Monitoring | **Sentry** | Error tracking + performance |

These are the team defaults. Check the entity's MEMORY.md for any entity-specific infrastructure decisions.

---

## When to Deviate

Deviation from these standards requires:

1. **A genuine technical reason** — "the existing tool cannot handle this requirement"
2. **Documentation** — explain WHY in the spec, not just WHAT you're using instead
3. **User approval** — if the deviation introduces a new tool to the team's stack

"I prefer X" or "X is newer" or "X has more GitHub stars" is not sufficient. Consistency has compounding value that novelty rarely outweighs.

---

_This guide evolves. When we adopt new standards or discover better patterns, update this file._
