# @makaio/storage-pg

Postgres storage engine for the Makaio framework.

## Install & Usage

```bash
npm install @makaio/storage-pg
export MAKAIO_DATABASE_URL=postgres://user:password@host:5432/makaio
```

The node-postgres driver (`pg`) is a regular dependency — installing this
package is everything a Postgres host needs for the driver. The committed
Postgres migration chain ships inside the npm tarball (`drizzle-postgres/`)
and is applied automatically at boot. The engine attaches through the storage
engine registry: Node and Bun runtime hosts auto-resolve it for recognized
`postgres://` / `postgresql://` URLs, the `database.engines` boot option
registers it explicitly, and direct callers use
`registerStorageEngine(storageEngine)` — see "How It Attaches" below.

## What This Is

Packages everything Postgres-specific behind the storage engine seam of
`@makaio/storage-drizzle` (one `StorageEngine` per dialect, attached through
the global engine registry):

- **Engine definition** — `postgresStorageEngine` claims `postgres://` /
  `postgresql://` URLs (case-insensitively, mirroring the core URL hint table)
  and creates clients over the node-postgres driver.
- **Error classifiers** — `isPostgresDuplicateObjectError` (SQLSTATE
  `42P07`/`42710`) and `isPostgresUniqueViolationError` (`23505`, with optional
  constraint-name scoping); both walk wrapped error cause chains.
- **Migration behavior** — the `__makaio_migrations` ledger (identity primary
  key plus `UNIQUE` hash), `BEGIN ISOLATION LEVEL READ COMMITTED` transaction
  pinning, the `pg_advisory_xact_lock` cross-process protocol keyed by
  `migrationAdvisoryLockKey`, `__makaio_migrations_<hash>` extension ledgers,
  and the committed Postgres migration chain itself: it ships in this
  package's `drizzle-postgres/` directory and is resolved through the engine's
  `resolveSourceChainDir`. The directory name is deliberately distinct from
  the default `drizzle` directory so embedded-host chain discovery never picks
  up the Postgres chain.
- **Full-text search** — `postgresFtsSearchStrategy`: tsvector matching via
  `websearch_to_tsquery`, `ts_rank` ordering, and `ts_headline` excerpts over
  the stored generated `messages.content_tsv` column. Boot-time provisioning is
  a no-op — the column and its GIN index ship through the central Postgres
  migration chain.

## How It Attaches

The engine is never imported statically by framework core — attachment always
goes through the engine registry (a lint rule enforces the dependency
direction, because a static import would let bundlers silently inline the
Postgres engine into the core distribution):

- **Explicit registration** — `registerStorageEngine(storageEngine)` before any
  database client is created, or via the runtime boot option
  `database.engines: [storageEngine]` (registration precedes database
  initialization by construction).
- **Host auto-resolve** — Node and Bun runtime hosts recognize Postgres
  database URLs through the core hint table, import this package, and register
  its well-known `storageEngine` export before any client is created.
- **Test harnesses** — register explicitly (the storage conformance harness
  calls its idempotent `ensurePostgresEngineRegistered()` in every
  client-creating entry point).

## Key Exports

- `postgresStorageEngine` — the engine definition
- `storageEngine` — well-known auto-resolve alias (same object as
  `postgresStorageEngine`)
- `isPostgresDuplicateObjectError(error)` / `isPostgresUniqueViolationError(error, constraint?)`
  — error classifiers (also wired as `postgresStorageEngine.errors`)
- `migrationAdvisoryLockKey(tableName)` — signed 64-bit advisory lock key
  (first 8 bytes, big-endian, of `SHA-256("makaio:migrations:<tableName>")`)
- `buildPostgresLedgerDdl(tableName)` — idempotent ledger `CREATE TABLE` DDL
- `POSTGRES_MIGRATION_BEGIN` — the pinned `BEGIN ISOLATION LEVEL READ COMMITTED`
  statement text
- `postgresFtsSearchStrategy` — the tsvector FTS strategy (also wired as
  `postgresStorageEngine.fts`)

The Postgres column bundle (`epochMs`, `bool`, `jsonCol`, `autoPk`, `float8`)
is NOT part of this package: column bundles are schema-declaration vocabulary
owned by `@makaio/framework/storage/drizzle/columns/postgres`, so hand-written
Postgres twin schema files in framework core never import this engine package.

The migration statement texts, ledger names, and the advisory-lock key
derivation are **cross-version contracts**: runners built from different
framework versions must agree on them byte-for-byte, otherwise concurrent runs
stop serializing against each other or stop recognizing each other's ledgers.
All of them are byte-pinned by this package's tests and exercised live by the
storage conformance suite.

---

*Part of Makaio Framework*
