# @makaio/storage-drizzle

Drizzle ORM extension for storage namespaces with a runtime-selected SQLite/Postgres client seam.

## What This Is

Extends `@makaio/storage-core` with:

- **Declaration merging** - Adds `drizzle` property to `StorageNamespaceExtensions`
- **Database client sub-entry** - Async factory that selects node-postgres for
  `postgres://` / `postgresql://` URLs, Bun SQLite for Bun-local databases, and
  libSQL/Drizzle for Node.js or remote URLs
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
import { createDatabaseClient } from '@makaio/storage-drizzle/client';

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

// Production with Postgres (requires the consumer-provided `pg` package)
const { db } = await createDatabaseClient({
  url: process.env.DATABASE_URL, // postgres://user:pw@host:5432/db
});
```

`pg` is consumer-provided — a documented peer, deliberately not listed in this
package's dependencies or peer dependencies so selecting SQLite never pulls in
a Postgres driver: hosts that use `postgres://` / `postgresql://` URLs install
it in the host application; SQLite-only hosts need nothing extra.

## Architecture Principles

**1. Extension Point** - Uses TypeScript declaration merging, not inheritance

**2. Runtime driver seam** - Client factory selects the appropriate driver (node-postgres,
Bun SQLite, libSQL) by runtime and URL while exposing one `MakaioDatabase` contract

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

**Client entry (`@makaio/storage-drizzle/client`):**

- `createDatabaseClient(config)` - Async factory for the runtime-selected database driver
  (SQLite by default, Postgres for `postgres://` / `postgresql://` URLs)
- `isPostgresUrl(url)` - Predicate for the Postgres URL dispatch rule
- `DatabaseClient` - `{ db: MakaioDatabase, dialect: StorageDialect, close(): void | Promise<void> }`
- `DatabaseClientConfig` - `{ url?: string, authToken?: string, postgres?: PostgresClientOptions }`

## Design Philosophy

**"Extend, don't replace"** - Declaration merging adds capabilities without modifying core abstractions.

---

*Part of Makaio Framework*
