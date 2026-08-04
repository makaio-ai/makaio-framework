# Schema Authoring Guide

This guide walks through adding a table to the **central** database — the
framework-wide schema discovered via `makaio.drizzleSchema`. Most tables belong
here. (Extension-owned tables follow a different path; see the storage-migrations
policy.)

Tables are defined **once** and emit one chain per dialect: a SQLite chain
(always) and a Postgres chain (only when the Postgres storage engine package is
installed). A single dual-table definition keeps the two dialect faces from ever
silently drifting.

---

## Adding a Table

### 1. Define the table once with `defineDualTable`

In your package's schema file (e.g. `src/storage/schema.ts`), build the table
from one column spec. `defineDualTable` constructs both the SQLite and Postgres
builders from that spec, so the two faces stay congruent by construction:

```typescript
import { defineDualTable } from '@makaio/storage-drizzle';

export const widgetsDual = defineDualTable('widgets', (c) => ({
  id: c.text('id').primaryKey(),
  label: c.text('label').notNull(),
  config: c.jsonCol<Record<string, string>>('config'),
  enabled: c.bool('enabled').notNull().default(true),
  createdAt: c.epochMs('created_at').notNull(),
}));
```

The column helpers (`text`, `jsonCol`, `bool`, `epochMs`, `autoPk`, `float8`, …)
each emit the dialect-correct column type on both sides (for example `bool`
becomes a SQLite integer-boolean and a Postgres `boolean`; `epochMs` becomes a
SQLite integer and a Postgres `bigint`). Chain methods like `notNull`, `default`,
`primaryKey`, and `$type` forward to both builders.

### 2. Re-export both faces under the canonical name

Consumers should never see two names for one table. Export the SQLite face under
the canonical name from `schema.ts`, and the Postgres face under the **same**
name from `schema.postgres.ts`:

```typescript
// schema.ts
/** SQLite face of the `widgets` table (canonical schema). */
export const widgets = widgetsDual.sqlite;

export type InsertWidget = typeof widgets.$inferInsert;
export type SelectWidget = typeof widgets.$inferSelect;
```

```typescript
// schema.postgres.ts
import { widgetsDual } from './schema.js';

/** Postgres face of the `widgets` table. */
export const widgets = widgetsDual.postgres;
```

Row types are owned exclusively by `schema.ts`. Handlers import `widgets` and
resolve the dialect-correct object at runtime via `resolveSchema(db, schema)` — a
branch-free lookup keyed by the handle's dialect brand.

### 3. Declare the file pair on `makaio.drizzleSchema`

In the package's `package.json`, declare both schema files in object form so the
table is discovered for both chains:

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

A bare string or string array means SQLite-only (legacy form). The object form is
required for any table that participates in the Postgres chain.

### 4. Generate and commit

```bash
yarn db:generate
```

This regenerates the schema barrels, then appends a new migration to the SQLite
chain (`framework/storage/migrations/drizzle/`) and — when the Postgres engine
package is installed — to the Postgres chain
(`framework/storage/pg/drizzle-postgres/`), threading one `--name` across both so
the filenames correlate. Commit the appended `.sql` files and the updated
`_journal.json` for every chain that changed.

> Landed migrations are never renamed or renumbered — generation only appends. To
> rebuild a chain from scratch during pre-release development, use
> `yarn db:generate:fresh` (and reset any provisioned database afterward).

> The generation scripts assume a Unix-like shell (the `:fresh` variants delete
> each chain directory with `rm -rf` before regenerating).

---

## SQLite Table Rebuilds

Some changes cannot be expressed as an `ALTER TABLE` in SQLite — adding or
dropping a table-level `CHECK` constraint is the common one. drizzle-kit then
generates the documented table rebuild: `CREATE TABLE __new_x` → copy rows →
`DROP TABLE x` → `ALTER TABLE __new_x RENAME TO x`, wrapped in
`PRAGMA foreign_keys=OFF` / `PRAGMA foreign_keys=ON`.

That pragma pair is inert where the generator puts it: SQLite ignores
foreign-key-enforcement pragmas inside a transaction, and `applyMigrations`
opens one around every migration. Without the pragma taking effect,
`DROP TABLE x` performs an implicit delete of every row in `x`, which fires the
cascade actions of any child table referencing it — silently emptying the
children while the parent's rows survive the copy.

The runner closes that gap rather than each migration working around it: the
SQLite engine declares `migrations.constraintSuspension`, and `applyMigrations`
brackets any migration whose statement stream requests suspension with the
engine's suspend/restore statements **outside** the transaction. Migrations that
do not request it keep running with enforcement active.

When you author or hand-correct a rebuild migration:

- Keep the generated `PRAGMA foreign_keys=OFF` as the migration's first
  statement — it is what signals the requirement to the runner.
- Never rely on a pragma inside a migration's statement stream to change
  connection state; it will not.
- Add a regression test that seeds a parent row plus a child row before the
  rebuild and asserts the child survives it.

---

## Escape Hatch: Genuinely Divergent Tables

A few tables cannot be expressed from a single column spec because one dialect
needs a column the other has no equivalent for. The canonical example is
`messages`, whose Postgres face carries a `content_tsv` `tsvector` generated
column and a GIN index for full-text search; SQLite has no `tsvector`, and it
provisions search differently (at runtime, via an FTS5 virtual table).

For these, author the two faces **by hand** and pair them with
`defineDialectSchema`:

```typescript
// schema.ts
import { defineDialectSchema } from '@makaio/storage-drizzle';

const messagesSqlite = sqliteTable('messages', { /* ... */ });
const messagesPostgres = pgTable('messages', { /* ... incl. content_tsv ... */ });

export const messagesSchema = defineDialectSchema(
  { messages: messagesSqlite },
  { messages: messagesPostgres },
);
```

`defineDialectSchema` congruence-checks the two faces at compile time, failing the
build (naming the table key) if a column drifts — except the single column named
by the `PostgresOnlyGeneratedColumnKey` exemption, which is allowed to exist only
on the Postgres side. Reach for this **only** when `defineDualTable` genuinely
cannot express the table (FTS, `tsvector`, row-level security).

### Hand-written SQL needs a pairing or an n/a marker

When a divergent table's migration is hand-authored in one chain only, the
generated-DDL parity lint requires you to account for the missing counterpart.
Either ship a same-stem `.sql` migration in the other chain, or commit a
`<stem>.na.md` marker in the chain dir that lacks it, documenting why none exists.

The live example pairs the hand-written Postgres FTS migration
`framework/storage/pg/drizzle-postgres/0001_messages_content_tsv.sql` with the
marker `framework/storage/migrations/drizzle/0001_messages_content_tsv.na.md`: the
marker records that SQLite full-text search is provisioned at runtime (the SQLite
engine builds the `messages_fts` FTS5 virtual table at boot), so there is
intentionally no SQLite migration counterpart. The marker is documentation only —
no runtime path reads it.
