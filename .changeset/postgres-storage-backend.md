---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/runtime-node": minor
---

Add an optional PostgreSQL storage backend alongside the default SQLite backend.

Opt in by installing the `@makaio/storage-pg` engine package in the host application (it brings the `pg` driver ^8.x as a regular dependency) and pointing the runtime at a Postgres server: pass the `database.url` boot option or set the `MAKAIO_DATABASE_URL` environment variable to a `postgres://` / `postgresql://` URL. No core package depends on a Postgres driver, so selecting SQLite never pulls one in and SQLite-only hosts install nothing extra. The driver is pure JavaScript and works under both Node.js and Bun. Without a Postgres URL nothing changes: SQLite stays the default.

- The database target resolves in this order (empty and whitespace-only values count as unset): `database.url` boot option → `MAKAIO_DATABASE_URL` → `dbPath` → `MAKAIO_DATABASE_PATH` → `<makaioHome>/makaio.db`. A non-Postgres URL from the first two sources is rejected with an error instead of falling through. Postgres targets open a node-postgres pool (4 connections by default; tune with `database.poolMax`).
- The Postgres migration chain ships with `@makaio/storage-pg` and is resolved through its storage engine; boot applies the chain matching the selected backend automatically. Concurrent Postgres boots are safe — migration runs are serialized with a transaction-scoped advisory lock.
- Full-text search works on both backends through the same contracts: FTS5/bm25 on SQLite, `tsvector`/`ts_rank` with `websearch_to_tsquery` parsing and `ts_headline` excerpts on Postgres. `@makaio/contracts` documents the dialect-specific query semantics and score scales; scores are positive on both dialects but never comparable across dialects.
- `MakaioDatabase` is narrowed to the dialect-portable query-builder surface: the raw-statement members (`run`, `all`, `get`, `values`) are removed (joining the already-excluded `$client`, `batch`, and `resultKind`), and raw SQL goes through the executor returned by `getRawSqlExecutor(db)`.
- Data is not migrated across backends: pointing an existing SQLite installation at Postgres starts from an empty database. Tested against PostgreSQL 18.
