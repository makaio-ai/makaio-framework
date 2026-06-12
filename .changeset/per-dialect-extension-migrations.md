---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Allow extensions to declare per-dialect migration chains. `StorageManifest.migrations` widens from a single string to `string | Partial<Record<StorageDialect, string>>`: a bare string keeps its current meaning (one dialect-agnostic chain applied on every active dialect), while the object form (e.g. `{ sqlite: 'drizzle', postgres: 'drizzle-postgres' }`) lets an extension ship dialect-specific migration text. The composition root resolves and containment-checks every declared per-dialect path and stays dialect-agnostic; the runtime selects the chain matching the active dialect, and the per-extension ledger naming is engine-owned (`__drizzle_migrations_<sha256>` on SQLite, `__makaio_migrations_<sha256>` on Postgres). This mirrors the existing `makaio.drizzleSchema` object-form precedent.

`StorageDialect` (`'sqlite' | 'postgres'`) now lives in `@makaio/contracts` as the single source of truth and is re-exported by `@makaio/storage-drizzle`, so existing import paths are unchanged. The `'sqlite'`/`'postgres'` literals in `@makaio/contracts` are serializable manifest identity vocabulary, not a dialect branch, so they are exempt from the framework's zero-postgres dialect-branch metric.

A Postgres extension chain must be emitted into a non-`drizzle` directory (convention: `drizzle-postgres`): packaged SQLite-only hosts embed every directory literally named `drizzle`, so this naming keeps Postgres chains out of those hosts.
