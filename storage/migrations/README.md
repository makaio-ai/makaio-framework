# @makaio/storage-migrations

Centralized Drizzle migration management: schema discovery, aggregation, and runtime migration application.

## What This Is

Framework central runner for schema migrations. Provides:

- **Schema discovery** — Scans workspace `package.json` files for `makaio.drizzleSchema` declarations and resolves them to absolute paths per dialect.
- **Schema aggregation** — Generates combined `.generated/schema.ts` (SQLite) and `.generated/schema.postgres.ts` (Postgres) barrels that Drizzle Kit uses to produce SQL migration files.
- **Runtime migration application** — `readMigrations()` and `applyMigrations()` apply pre-resolved SQL migrations at startup without Drizzle's `migrate()` helper.

## Migration Tiers

There are two runtime migration tiers that share the same database but use separate ledgers:

- **Central tier** — Framework central migrations from this package use `__drizzle_migrations` on
  SQLite (Drizzle's historical name, so existing ledgers keep matching) and `__makaio_migrations`
  on Postgres (a name that never collides with a consumer-owned Drizzle ledger sharing the same
  database). Hosts may provide their own host-owned central migration bundle through an explicit
  composition seam; this framework package does not discover or apply host-owned schemas by
  filesystem convention.
- **Extension tier** — Extension-owned schemas declare `storage.migrations` on their package
  manifest. The runtime resolves those folders using `storage.packageRoot` and keys each bundle
  with `storage.migrationSourceId` when provided, applying them to hashed tracking tables whose
  naming scheme is engine-owned (`StorageEngine.migrations.extensionLedgerName`):
  `__drizzle_migrations_<sha256>` on SQLite, `__makaio_migrations_<sha256>` on Postgres.

## Key Exports

- `getMigrationsFolder(dialect?)` — Absolute path to the dialect's committed migration folder.
  The directory name is engine-owned (`StorageEngine.migrations.chainDirName`): `drizzle/` for
  SQLite, `drizzle-postgres/` for Postgres. Engines whose chain ships in their own package
  resolve it via `StorageEngine.migrations.resolveSourceChainDir`.
- `readMigrations(source?)` — Reads `_journal.json` plus SQL files into ordered migration entries;
  validates `expectedDialect` against the journal using the engine's declared journal dialect
  (`StorageEngine.migrations.journalDialect`).
- `applyMigrations(db, migrations, migrationsTable?)` — Applies ordered entries with a configurable
  tracking table. Per-engine mechanics — ledger naming and DDL, the `BEGIN` flavor, and the
  cross-process locking protocol — are owned by `StorageEngine.migrations`; this package only
  orchestrates the run. The Postgres values (`buildPostgresLedgerDdl`, `POSTGRES_MIGRATION_BEGIN`,
  `migrationAdvisoryLockKey`) are exported by `@makaio/storage-pg`.
- `discoverSchemas(workspaceRoot, patterns?, dialect?)` — Returns `DiscoveredSchema[]` sorted by package name then path. `dialect` defaults to `'sqlite'`.
- `generateSchema(options?)` — Writes the aggregated dialect barrels; accepts optional `workspaceRoot`, `generatedDir`, `logger`, `patterns`, and `dialects` overrides. Defaults to `['sqlite']` — additional dialects are opt-in.
- `DiscoveredSchema` — `{ packageName: string; schemaPath: string }`

## Declaring a Schema

### Legacy form (sqlite-only, backward compatible)

```json
{
  "name": "@makaio/my-framework-package",
  "makaio": {
    "drizzleSchema": "./src/storage/schema.ts"
  }
}
```

Array form:

```json
{
  "makaio": {
    "drizzleSchema": [
      "./src/session/storage/schema.ts",
      "./src/session/turns/schema.ts"
    ]
  }
}
```

Legacy forms (bare string or string array) are treated as sqlite-only declarations and remain
fully supported.

### Object form (both dialects)

For packages that participate in the Postgres migration chain, use the object form to declare
both dialect chains. SQLite is always the baseline:

```json
{
  "makaio": {
    "drizzleSchema": {
      "sqlite": ["./src/storage/schema.ts"],
      "postgres": ["./src/storage/schema.postgres.ts"]
    }
  }
}
```

The two lists are positionally paired by convention (`postgres[i]` is the twin of `sqlite[i]`).

**Invariants enforced by `discoverSchemas`:**
- Declaring `postgres` entries without `sqlite` entries is a declaration error (every dialect run).
- On the `'postgres'` run, any package with `sqlite` entries but zero `postgres` entries is a
  generation-time strictness error — all central-tier packages must declare Postgres twins before
  the Postgres chain can be generated.
- Every declared path in **both** lists is existence-checked regardless of the requested dialect;
  a missing Postgres twin file fails even the `sqlite` run.

## Per-dialect extension migrations

Extension-owned schemas declare their migration chain on the package manifest
under `storage.migrations` (not `makaio.drizzleSchema`, which is the central
tier). Like `makaio.drizzleSchema`, `storage.migrations` accepts either a bare
string or a per-dialect object:

```jsonc
{
  "storage": {
    // Bare string: one dialect-agnostic chain, applied on every active dialect.
    "migrations": "drizzle",

    // Object form: a separate chain folder per dialect.
    "migrations": { "sqlite": "drizzle", "postgres": "drizzle-postgres" }
  }
}
```

How it is resolved and applied:

- The composition root resolves every declared per-dialect path against the
  extension root and containment-checks each one; it does not pick a dialect.
- The runtime selects the chain for the **active** dialect at boot. A bare
  string is used on every dialect; the object form selects
  `migrations[activeDialect]`, falling back to the singular chain when that
  dialect has no entry.
- Each chain is applied to a per-extension tracking table whose name is
  engine-owned (`StorageEngine.migrations.extensionLedgerName`):
  `__drizzle_migrations_<sha256>` on SQLite, `__makaio_migrations_<sha256>` on
  Postgres.
- If an extension ships only a chain for a dialect other than the active one,
  the runtime hard-fails boot with an actionable error (disable the extension or
  ship a chain for the active dialect) rather than silently skipping migrations.

**Directory naming is load-bearing.** The SQLite chain folder stays `drizzle/`;
the Postgres chain folder **must not** be named `drizzle`. Packaged (embedded)
hosts are SQLite-only and embed every directory literally named `drizzle` they
find, with no dialect check. Emitting the Postgres chain into a non-`drizzle`
directory (convention: `drizzle-postgres`, matching the central chain) keeps it
out of SQLite-only hosts. Generate an extension's Postgres chain with that
extension's own `db:generate` pointed at a non-`drizzle` output directory.

The framework's own extensions (`account-manager`, `review`) remain SQLite-only
for now and declare a bare-string chain. They do not yet ship a Postgres chain:
their schemas are pure SQLite tables, and the per-dialect object form is intended
for extensions that genuinely need dialect-specific migration text once a
Postgres extension host exists.

## Committed Migration Chains

The SQLite chain is committed in this package; the Postgres chain is committed in
`@makaio/storage-pg`. Both are regenerated by this package's `db:generate`:

| Directory | Dialect | Consumed by |
|-----------|---------|-------------|
| `drizzle/` (this package) | SQLite | `getMigrationsFolder('sqlite')`, bundled dist layout |
| `drizzle-postgres/` (in `@makaio/storage-pg`) | Postgres | `getMigrationsFolder('postgres')` via the engine's `resolveSourceChainDir` |

The SQLite chain is copied into the framework distribution bundle by the build step and located by
`resolveBundledMigrationsDir` at runtime. The Postgres chain ships with `@makaio/storage-pg` and
resolves through `StorageEngine.migrations.resolveSourceChainDir`.

**Unqualified-DDL invariant (Postgres chain):** every statement in the Postgres chain must use
unqualified identifiers — never `"public"."sessions"`, always `"sessions"`. The chain lands in
whichever schema leads the connection's `search_path`: consumers choose their own schema, and the
storage conformance harness provisions one isolated schema per suite (see
`storage/conformance/README.md`). drizzle-kit qualifies foreign-key references with `"public".`,
so the Postgres `db:generate` leg ends with the normalize script shipped with `@makaio/storage-pg`
(`scripts/normalize-migrations.ts`), which strips the qualifier mechanically;
`src/__tests__/postgres-chain-ddl.test.ts` pins the invariant against any path that bypasses the
script. If qualified DDL can ever not be normalized away, the per-schema isolation model must fall
back to one database per consumer/suite.

Rewriting a landed migration file changes its content hash — the ledger identity used by
`applyMigrations` — so databases provisioned from a pre-rewrite chain must be re-created.

**Identifier-length note (Postgres chain):** a few Drizzle-derived constraint names (the
`workflow_execution_links` composite PK and the `workflow_execution_*` foreign keys) exceed
PostgreSQL's 63-byte identifier limit; PostgreSQL truncates them with a NOTICE on apply. This is
accepted: the truncated names stay pairwise distinct, and drizzle-kit re-derives the same
over-length names for future `ALTER`/`DROP` statements, which truncate to the same identifiers.
Tooling that compares constraint names against live catalog data (for example
`information_schema`) must normalize names to their 63-byte truncation rather than compare raw
snapshot names.

## Dev-time Workflow

Run from the repository root:

```bash
# Regenerate both chains (SQLite and Postgres)
yarn workspace @makaio/storage-migrations db:generate

# Regenerate both chains from scratch (resets accumulated migration history)
yarn workspace @makaio/storage-migrations db:generate:fresh

# SQLite-only interactive commands
yarn workspace @makaio/storage-migrations db:push
yarn workspace @makaio/storage-migrations db:studio
yarn workspace @makaio/storage-migrations db:reset
```

`db:generate` pipeline:
1. `tsx src/generate-schema.ts` — discovers schemas for both dialects, writes `.generated/schema.ts` and `.generated/schema.postgres.ts`.
2. `tsx $(yarn bin drizzle-kit) generate` — diffs the SQLite barrel against the existing `drizzle/` chain.
3. `yarn workspace @makaio/storage-pg db:generate` — diffs the Postgres barrel against the chain committed in `@makaio/storage-pg` (`drizzle-postgres/`) and strips `"public".` qualifiers (see the unqualified-DDL invariant above).

Note: `db:push`, `db:studio`, and `db:reset` are SQLite-only by design; Postgres targets receive
migrations at runtime through the standard `applyMigrations` path, not through Drizzle Kit push.

## Runtime Usage

`initializeNodeDatabase()` creates the database client and calls `runMigrations()`:

```typescript
import { applyMigrations, readMigrations } from '@makaio/storage-migrations';

const migrations = readMigrations();
await applyMigrations(db, migrations);
```

The startup path is `initializeNodeDatabase()` → `runMigrations()` → `readMigrations()` /
`applyMigrations()`. It does not call Drizzle's `migrate()`.

During node boot, framework central migrations run after bus and transport creation, but before
the database handle is published on `RuntimeSubjects.database`, before storage handlers are
registered, and before extension storage or services start. Extension migrations declared through
`storage.migrations` run later inside `ExtensionCoordinator.startAll()`, still before each
extension's storage handlers and services start.

## Architecture

`@makaio/storage-migrations` owns the framework central migration runner. Framework packages
declare central schemas locally via `makaio.drizzleSchema`; host-owned central schemas belong in a
separate host-owned migration bundle wired by the host composition root; extension-owned tables use
`storage.migrations` instead of joining either central bundle.

The discovery step (`discoverSchemas`) reads `workspaces` from the provided workspace root
`package.json` to enumerate packages, making it resilient to workspace structure changes without
manual updates.

---

*Part of Makaio Framework*
