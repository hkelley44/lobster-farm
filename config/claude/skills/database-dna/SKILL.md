---
name: database-dna
description: >
  Database design, schema architecture, and query optimization standards.
  Auto-loads when designing data models, writing migrations, creating schemas,
  optimizing queries, or working with PostgreSQL/Prisma/SQLAlchemy. Load
  alongside coding-dna for any work that touches persistent data.
---

# DATABASE-DNA.md — How We Design Data

_Schema is architecture. Get it right — it outlives everything else._

---

## Philosophy

**Schema decisions are the most permanent.** Code can be refactored in a day. Schema migrations on production with millions of rows take careful planning, downtime windows, and prayer. Think hard. Use Opus High. Get it right early.

**Normalize, then denormalize with purpose.** Start normalized (3NF). Only denormalize when you have measured performance data showing a specific query is too slow, and only in that specific place. Premature denormalization is premature optimization's meaner cousin.

**Every query has a plan.** Before writing a query that will run in production, know how it will be executed. Indexes exist for every WHERE, JOIN, and ORDER BY clause in hot paths. If you can't explain the query plan, you don't understand the query.

**Data outlives code.** The application will be rewritten. The schema will survive. Design for the next application, not just this one.

---

## Schema Standards

### Primary Keys
- **UUID v4 or v7** for all external-facing IDs. Never auto-increment integers — they're enumerable, sequential, and leak information.
- If using UUIDs: use `gen_random_uuid()` at the database level, not application level.

### Timestamps
- `created_at` and `updated_at` on every table. Database-managed (`DEFAULT now()`, trigger for updates), not application-managed.
- Soft deletes via `deleted_at` timestamp when business logic requires history. Hard deletes when it doesn't.
- **All timestamps UTC.** No exceptions. Timezone conversion happens at the presentation layer.

### Naming
- **snake_case everywhere.** Tables, columns, indexes, constraints.
- Table names: plural (`users`, `orders`, `candles`).
- Foreign key columns: `{referenced_table_singular}_id` (e.g., `user_id`, `order_id`).
- Junction tables: descriptive (`user_roles`, not `user_role_mapping`).
- Boolean columns: `is_` or `has_` prefix (`is_active`, `has_verified_email`).

### Types
- Enum values stored as strings, not integers. Strings are self-documenting in raw queries.
- Money/financial values: use `DECIMAL` or `NUMERIC`, never `FLOAT`.
- JSON columns: use `JSONB` (not `JSON`) in PostgreSQL. Always validate shape at application boundary with Zod/Pydantic.
- Text fields: use `TEXT` over `VARCHAR(n)` unless you have a specific length constraint.

### Relationships
- All foreign keys have explicit `ON DELETE` behavior (`CASCADE`, `SET NULL`, or `RESTRICT`). Never rely on defaults.
- Every foreign key column must be indexed.
- Junction tables have composite primary keys where appropriate.

---

## Indexing

- Primary key index is automatic. Don't duplicate it.
- **Composite indexes:** most selective column first. Column order matters.
- **Covering indexes** for hot queries that touch few columns.
- **Partial indexes** for common filter conditions (e.g., `WHERE deleted_at IS NULL`).
- Name indexes explicitly: `idx_{table}_{columns}` (e.g., `idx_users_email`).
- **Review EXPLAIN ANALYZE** for any query in production hot paths. If you haven't checked the plan, you don't know if the index works.

---

## Query Patterns

- **Parameterized queries always.** Never interpolate values into SQL strings.
- **SELECT only what you need.** Never `SELECT *` in production code.
- **Cursor-based pagination** (keyset) for large datasets. Offset pagination for small admin views only.
- **Batch operations** for multi-row inserts/updates. Never loop single-row operations.
- **Transactions** for multi-table mutations. Clear boundaries. Short-lived — don't hold transactions open.
- **Connection pooling** configured and sized for expected concurrency.

---

## ORM Standards

### Prisma (TypeScript projects)
- Schema is the source of truth. Generate types from it.
- Use `@relation` annotations explicitly — don't rely on inference.
- Use `select` or `include` to avoid over-fetching. Never load all fields when you need three.
- Prisma migrations for schema changes. Raw SQL migrations for data migrations.
- Seed files for development data. Never use production data in development.

### SQLAlchemy (Python projects)
- Declarative models with type annotations.
- Alembic for migrations. Auto-generate, then review before applying.
- Session management: use context managers, always close sessions.
- Avoid lazy loading in production — use `joinedload` or `selectinload` explicitly.

---

## Anti-Patterns

- ❌ Auto-increment integers as external IDs — enumerable and information-leaking
- ❌ Storing structured data as JSON blobs — use proper tables and relations
- ❌ Missing indexes on foreign keys — guaranteed slow joins at scale
- ❌ N+1 queries — use eager loading or batch queries
- ❌ Business logic in triggers or stored procedures — keep it in application code where it's testable
- ❌ `VARCHAR(255)` everywhere by default — choose appropriate types
- ❌ Untyped JSONB without validation — validate shape at the boundary
- ❌ `SELECT *` in production — fetch only what you need
- ❌ Long-running transactions — hold locks as briefly as possible
- ❌ Schema changes without reviewing EXPLAIN ANALYZE on affected queries

---

_This DNA evolves. When we discover schema patterns or query optimizations worth codifying, they go here. Domain-specific schemas live in entity codebases._
