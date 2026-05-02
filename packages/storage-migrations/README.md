# @makaio/storage-migrations

Centralized Drizzle migration management: schema discovery, aggregation, and runtime migration application.

## What This Is

Framework central runner for SQLite schema migrations. Provides:

- **Schema discovery** — Scans workspace `package.json` files for `makaio.drizzleSchema` declarations and resolves them to absolute paths
- **Schema aggregation** — Generates a combined `.generated/schema.ts` that Drizzle Kit uses to produce SQL migration files
- **Runtime migration application** — `readMigrations()` and `applyMigrations()` apply pre-resolved SQL migrations at startup without Drizzle's `migrate()` helper

## Migration Tiers

Makaio has two runtime migration tiers that share the same SQLite database but use separate ledgers:

- **Central tier** — Framework central migrations from this package use `__drizzle_migrations`.
  Hosts may provide their own host-owned central migration bundle through an explicit composition
  seam; this framework package does not discover or apply host-owned schemas by filesystem
  convention.
- **Extension tier** — Extension-owned schemas declare `storage.migrations` on their package
  manifest. The runtime resolves those folders using `storage.packageRoot` and keys each bundle
  with `storage.migrationSourceId` when provided, applying them to hashed tracking tables named
  `__drizzle_migrations_<sha256>`.

## Key Exports

- `getMigrationsFolder()` — Absolute path to the `drizzle/` migration folder (used by `NodeRuntime`)
- `readMigrations(source?)` — Reads `_journal.json` plus SQL files into ordered migration entries
- `applyMigrations(db, migrations, migrationsTable?)` — Applies ordered entries with a configurable tracking table
- `discoverSchemas(workspaceRoot, patterns?)` — Returns `DiscoveredSchema[]` sorted by package name
- `generateSchema(options?)` — Writes the aggregated `.generated/schema.ts`; accepts optional `workspaceRoot`, `generatedDir`, `logger`, and `patterns` overrides
- `DiscoveredSchema` — `{ packageName: string; schemaPath: string }`

## Dev-time Workflow

Framework central packages declare their Drizzle schema file in `package.json`:

```json
{
  "name": "@makaio/my-framework-package",
  "makaio": {
    "drizzleSchema": [
      "./src/storage/schema.ts"
    ]
  }
}
```

Extension-owned schemas should not use `makaio.drizzleSchema`; declare `storage.migrations`
with `storage.packageRoot` and, for bundled hosts, `storage.migrationSourceId` on the extension
manifest instead.

Then run the workspace commands from the repository root:

```bash
yarn workspace @makaio/storage-migrations db:generate
yarn workspace @makaio/storage-migrations db:generate:fresh
yarn workspace @makaio/storage-migrations db:push
yarn workspace @makaio/storage-migrations db:studio
yarn workspace @makaio/storage-migrations db:reset
```

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
