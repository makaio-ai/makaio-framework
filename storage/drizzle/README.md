# @makaio/storage-drizzle

Drizzle ORM extension for storage namespaces with a registry-based SQLite/Postgres storage engine seam.

## What This Is

Extends `@makaio/storage-core` with:

- **Declaration merging** - Adds `drizzle` property to `StorageNamespaceExtensions`
- **Storage engine seam** - One `StorageEngine` contract packaging everything
  dialect-specific (client creation, error classification, capabilities,
  migration behavior, full-text search) behind a global registry, with the
  built-in SQLite engine as the default
- **Database client sub-entry** - Async factory dispatching through the engine
  registry: the SQLite engine serves local files, `:memory:`, and remote
  libSQL/Turso URLs (Bun SQLite under Bun, `@libsql/client` elsewhere), while
  `postgres://` / `postgresql://` URLs are served by the registered
  `@makaio/storage-pg` engine
- **Type-safe tables** - Access Drizzle schemas directly from storage namespaces

## Quick Start

**Enable drizzle extension (side-effect import):**

```typescript
import '@makaio/storage-drizzle';
// Now StorageNamespaceExtensions.drizzle is available
```

**Create storage namespace with drizzle tables:**

```typescript
import { createStorageNamespace } from '@makaio/storage-drizzle';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

// Define Drizzle table
export const sessionsTable = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data'),
  createdAt: integer('created_at'),
});

// Create namespace with extension
export const SessionStorage = createStorageNamespace('session', {
  schemas: {
    get: {
      request: z.object({ sessionId: z.string() }),
      response: z.object({ session: SessionSchema.nullable() }),
    },
  },
  extensions: {
    drizzle: { sessions: sessionsTable },
  },
});

// Type-safe access
const table = SessionStorage.extensions.drizzle?.sessions;
```

**Create database client:**

```typescript
import { registerStorageEngine } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { storageEngine as postgresEngine } from '@makaio/storage-pg';

// Runtime-selected local SQLite client
const { db } = await createDatabaseClient();
// Uses: file:./makaio.db

// Production with Turso
const { db } = await createDatabaseClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Local libSQL server
const { db } = await createDatabaseClient({
  url: 'http://localhost:8080',
});

// Production with Postgres (requires the registered @makaio/storage-pg engine)
registerStorageEngine(postgresEngine);
const { db } = await createDatabaseClient({
  url: process.env.DATABASE_URL, // postgres://user:pw@host:5432/db
});
```

`postgres://` / `postgresql://` URLs require the `@makaio/storage-pg` engine:
without it, `createDatabaseClient` fails with an actionable install error
instead of misrouting the URL to SQLite (Node runtime hosts auto-register the
engine for recognized URLs — see the boot ordering contract below). The `pg`
driver ships as a regular dependency of `@makaio/storage-pg` — this package
declares no Postgres driver at all, so selecting SQLite never pulls one in:
hosts that use `postgres://` / `postgresql://` URLs install the engine
package; SQLite-only hosts need nothing extra.

## Dual-Table Schemas

`defineDualTable` is the canonical, one-definition-per-table mechanism for
storage schemas that must exist on BOTH dialects. You write the columns once,
against a dialect-neutral bundle, and the factory builds a real SQLite table
object and a real Postgres table object from that single definition. There are
no hand-maintained per-dialect copies to keep in sync by review — a divergence
becomes a compile error in one place instead of a silent drift between two
files.

```typescript
import { defineDualTable } from '@makaio/storage-drizzle';

export const sessionsDual = defineDualTable('sessions', (c) => ({
  sessionId: c.text('session_id').primaryKey(),
  status: c.textEnum('status', { enum: ['active', 'closed'] }).notNull(),
  createdAt: c.epochMs('created_at').notNull(),
}));

// Expose the canonical faces. The SQLite face carries the row-type aliases.
export const sessions = sessionsDual.sqlite;
export type SelectSession = typeof sessions.$inferSelect;
```

The partner `schema.postgres.ts` is a one-line re-export of the Postgres face:

```typescript
import { sessionsDual } from './schema.js';
export const sessions = sessionsDual.postgres;
```

### Column bundle

The bundle handed to the column callback maps a dialect-neutral intent to the
correct builder on each dialect:

- `text` / `textEnum` — `text` on both dialects; `textEnum` preserves the enum
  literal tuple so the row type narrows to the union (e.g. `'a' | 'b'`), not
  `string`
- `epochMs` — Unix-epoch-ms (SQLite `integer` / Postgres `bigint`)
- `bool` — SQLite `integer` (boolean mode) / Postgres native `boolean`
- `jsonCol<T>` — SQLite `text` (json mode) / Postgres `jsonb`, pinned to `T`
- `autoPk` — auto-generated PK (SQLite `integer PK AUTOINCREMENT` / Postgres
  identity `bigint` PK); the Postgres identity face omits the key from its
  insert shape, which is the only drizzle-honest insert divergence
- `float8` — SQLite `real` / Postgres `double precision`
- `int4` — 32-bit integer on both dialects (PIDs, ordinals, counters)
- `int8` — 64-bit integer (SQLite `integer` / Postgres `bigint`, int53-safe)

The `int4` vs `int8` choice is a deliberate single selection at definition
time: a structural same-row parity check cannot tell them apart, so the choice
is what the permanent type tests pin.

### Foreign keys

Foreign keys are declared once and resolve to the dialect-correct column on each
side. A cross-table FK targets the other table's `columnPair`:

```typescript
turnId: c.text('turn_id').references(() => turnsDual.columnPair('turnId'), {
  onDelete: 'cascade',
});
```

`columnPair(key)` returns both dialects' built columns under one key, so a
referencing table never reaches into a specific dialect face.

### Per-dialect extras — the predicate escape hatch

Table-level indexes and constraints take TWO callbacks because some predicates
legitimately differ across dialects. The canonical case is a partial unique
index whose boolean predicate is `= 1` on SQLite and `= true` on Postgres:

```typescript
defineDualTable('client_profiles', (c) => ({ /* columns */ }), {
  sqlite: (t) => [
    uniqueIndex('uniq_default_profile').on(t.scope).where(sql`${t.isDefault} = 1`),
  ],
  postgres: (t) => [
    pgUniqueIndex('uniq_default_profile').on(t.scope).where(sql`${t.isDefault} = true`),
  ],
});
```

Most extras are identical between the two callbacks (composite primary keys,
named uniques, plain indexes); only the genuinely divergent predicate uses the
escape hatch.

### Full-text-search escape hatch

One table is deliberately NOT a dual table: `messages`. Postgres maintains a
`content_tsv` `tsvector` column via a `GENERATED ALWAYS AS ... STORED`
expression plus a GIN index, and SQLite has no equivalent (its full-text search
lives in a separate FTS5 virtual table). That single Postgres-only generated
column is the reason `messages` stays a hand-written twin, with the column
recorded as a registered exemption that the schema-parity check tolerates on
that table and no other. New schemas should reach for `defineDualTable` first;
a hand-written twin is justified only by a comparable dialect-only generated
column or index that has no portable form.

## Engine Seam

Everything dialect-specific lives behind one contract. A `StorageEngine`
packages:

- `dialect` — the `StorageDialect` it serves (`'sqlite'` | `'postgres'`)
- `matchesUrl?(url)` — URL claim; the built-in SQLite engine omits it and
  serves every URL no registered engine claims
- `createClient(config)` — driver selection and connection setup
- `errors` — duplicate-object / unique-violation classification for raw DDL
  flows and bounded-retry write paths
- `capabilities` — queryable runtime capabilities (binary column type, catalog
  `tableExists` probe, MAX-counter race flag) instead of dialect branches
- `migrations` — ledger naming and DDL, journal dialect, chain directory name,
  `BEGIN` flavor, and the optional cross-process `acquireTransactionLock`
  protocol
- `fts` — full-text-search provisioning and the dialect-divergent queries as
  whole operations

### Registry

One engine per dialect, stored on `globalThis` under a `Symbol.for` key so
duplicated module instances resolve the same map. The built-in SQLite engine
is seeded set-if-absent on first access and is the default engine.
Re-registering the same engine object is a no-op; registering a different
object for an already-registered dialect throws.

- `registerStorageEngine(engine)` — explicit registration
- `getStorageEngine(dialect)` / `findStorageEngine(dialect)` — lookup; the
  first throws an actionable install hint when absent, the second returns
  `undefined`
- `resolveStorageEngine(db)` — engine serving a database handle's dialect brand
- `resolveStorageEngineForUrl(url)` — registered `matchesUrl` claims first,
  then the URL hint table (`STORAGE_ENGINE_URL_HINTS`), else the default engine

### Boot ordering contract

Engines register **before** database initialization, on every surface:

- Hosts pass engines through the boot `database.engines` option (or call
  `registerStorageEngine` before creating clients); the Node and Bun runtime
  hosts register those engines first, then resolve the database target.
- Node and Bun runtime hosts additionally auto-register hinted engines: a
  database URL recognized by the hint table (`postgres://` / `postgresql://` →
  `@makaio/storage-pg`) loads that package's well-known `storageEngine` export
  and registers it before any client is created. There are no side-effect
  imports — registration is always an explicit call.
- Test harnesses register engines explicitly (the storage conformance harness
  registers the Postgres engine idempotently in its config factories).

A URL recognized by the hint table without a registered engine fails with the
shared actionable message (`describeMissingStorageEngine`) naming the package
to install.

## Architecture Principles

**1. Extension Point** - Uses TypeScript declaration merging, not inheritance

**2. Engine seam** - The client factory dispatches through the storage engine registry;
each engine owns its drivers and dialect behavior while exposing one `MakaioDatabase` contract

**3. Entrypoint Split** - Root exports namespace/drizzle helpers; client creation lives under
`@makaio/storage-drizzle/client`

**4. Type Preservation** - Specific table types flow through extensions

## Key Exports

**Root entry (`@makaio/storage-drizzle`):**

- `createStorageNamespace` - Re-export from `@makaio/storage-core`
- `executeTransaction(db, callback)` - Execute a callback in a Drizzle transaction
- `registerDrizzleHandlers(registration)` - Wrap typed storage handler registration for
  extension manifests
- `DrizzleHandlerRegistration` - Typed registration callback consumed by `registerDrizzleHandlers`
- `sanitizeFtsQuery(query)` - Quote user input for safe SQLite FTS5 `MATCH` usage
- `didAffectRows(result)` - Normalize libsql/bun-sqlite write results to a boolean
- `affectedRowCount(result)` - Normalize libsql/bun-sqlite write results to a row count
- `DrizzleSchemaRecord` - `Record<string, Table>` for table definitions
- `MakaioDatabase` - Canonical database type alias for storage consumers
- `TransactionCallback` - Callback type for `executeTransaction`
- `StorageNamespace`, `StorageNamespaceConfig`, `StorageNamespaceExtensions` - Re-exported core
  storage types

Engine seam (root entry):

- `StorageEngine` (+ `StorageEngineErrorClassifiers`, `StorageEngineCapabilities`,
  `StorageEngineMigrationBehavior`) - The engine contract
- `registerStorageEngine` / `getStorageEngine` / `findStorageEngine` /
  `resolveStorageEngine` / `resolveStorageEngineForUrl` - The global engine registry
- `sqliteStorageEngine` - The built-in default engine
- `STORAGE_ENGINE_URL_HINTS` / `describeMissingStorageEngine` - URL hint table and the
  shared missing-engine error text
- `FtsSearchStrategy` (+ input/hit types), `sqliteFtsSearchStrategy`,
  `buildFirstUserMessagePreviewQuery` - Engine-owned full-text search
- `isSqliteDuplicateObjectError` / `isSqliteUniqueViolationError`, `someInCauseChain` /
  `readErrorCode` - SQLite classifiers plus the cause-chain helpers engine packages
  build their own classifiers from
- `quoteSqlIdentifier` - Identifier escaping for hand-written statement text
- `importRuntimeModule` - Bundler-opaque dynamic import for optional engine packages
- `brandDatabase` / `getRawSqlExecutor` - Dialect brand and raw SQL executor attachment
- `defineDialectSchema` / `resolveSchema` - Per-dialect schema variants resolved by the
  handle's brand
- `defineDualTable` (+ `DualColumnBundle`, `DualBuilder`, `DualTable`, `DualTableExtras`,
  `DualColumnRef`, `DualReferenceActions`) - One column definition builds both dialect
  table objects; the canonical schema-authoring mechanism

**Client entry (`@makaio/storage-drizzle/client`):**

- `createDatabaseClient(config)` - Async factory dispatching through the storage engine registry
  (SQLite by default; `postgres://` / `postgresql://` URLs require the registered
  `@makaio/storage-pg` engine, which owns the node-postgres driver glue)
- `DatabaseClient` - `{ db: MakaioDatabase, dialect: StorageDialect, close(): void | Promise<void> }`
- `DatabaseClientConfig` - `{ url?: string, authToken?: string, postgres?: PostgresClientOptions }`

## Design Philosophy

**"Extend, don't replace"** - Declaration merging adds capabilities without modifying core abstractions.

---

*Part of Makaio Framework*
