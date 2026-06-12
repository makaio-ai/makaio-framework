---
"@makaio/framework": minor
"@makaio/storage-pg": minor
"@makaio/runtime-node": minor
---

Extract the PostgreSQL storage engine into the standalone `@makaio/storage-pg` package. The core distribution runs SQLite-only: it no longer bundles the Postgres driver glue or the `drizzle-postgres` migration chain, and CI verifies the artifact contains no Postgres driver/engine code. The Postgres column bundle stays core-owned at `@makaio/framework/storage/drizzle/columns/postgres` — column bundles are schema-declaration vocabulary, not engine code, and framework core never imports `@makaio/storage-pg`. `pg` is now a regular dependency of `@makaio/storage-pg` (the consumer-provided convention for `pg` is retired). Postgres usage = `npm install @makaio/storage-pg` + a `postgres://` `MAKAIO_DATABASE_URL`.
