/**
 * Anti-drift net 3: live schema inventory.
 *
 * **Role in the anti-drift system**
 *
 * - Net 1 (compile-time pin): `defineDialectSchema` + `PostgresTwinSchema` in
 *   `@makaio/storage-drizzle` enforce `$inferSelect` row equality at compile time.
 * - Net 2 (structural/type-image parity): `schema-parity.test.ts` in
 *   `@makaio/storage-migrations` introspects drizzle table objects and asserts
 *   column, index, constraint, and FK parity between SQLite and Postgres twins.
 *   Runs without a database.
 * - **Net 3 (this file)**: provisions a real database, applies the central
 *   migration chain, then queries the live catalog to verify that every table,
 *   column (including its SQL type), index (including uniqueness), and
 *   constraint declared in the drizzle schemas is actually present on the
 *   server — and that no stray tables landed outside the chain. Catches
 *   migration ↔ schema drift that compile-time nets cannot see: only this net
 *   has the live catalog's ground truth, so it is the one that detects a twin
 *   column updated without regenerating the migration chain (e.g. an epoch
 *   column declared bigint but applied as integer).
 *
 * Both dialect legs run from this single file: SQLite in every normal CI shard,
 * Postgres in the service-container job. No dialect branches appear outside the
 * catalog query adapters.
 *
 * **Identifier normalization**
 *
 * PostgreSQL truncates identifiers longer than 63 bytes before writing them to
 * the catalog. Several workflow-execution constraint names derived by drizzle
 * exceed this limit (see `storage/migrations/README.md`). `normalizeIdentifier`
 * truncates expected names to 63 bytes using byte-correct Buffer slicing before
 * comparing against catalog names. The normalization is generic — no allowlist.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql, is, getTableName, type Table } from 'drizzle-orm';
import { SQLiteTable, getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { PgTable, getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core';
import type { StorageDialect } from '@makaio/storage-drizzle';
import { discoverSchemas } from '@makaio/storage-migrations/discover-schemas';
import { resolveDefaultMigrationsTable } from '@makaio/storage-migrations/apply-migrations';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Expected-side image: slim inventory of declared drizzle schema objects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slim inventory of one drizzle table: names and normalized SQL types used
 * for catalog comparison. Default values remain net 2's domain.
 */
interface TableInventory {
  /** SQL table name as declared in the schema. */
  readonly tableName: string;
  /** Package that declares this table (for structured diff messages). */
  readonly packageName: string;
  /** Column name → normalized declared SQL type (see {@link normalizeSqlType}). */
  readonly columnTypes: ReadonlyMap<string, string>;
  /** Index name (as declared in the schema) → declared uniqueness flag. */
  readonly indexNames: ReadonlyMap<string, { readonly unique: boolean }>;
  /** Unique-constraint names declared via `uniqueConstraints` (distinct from unique indexes). */
  readonly uniqueConstraintNames: ReadonlySet<string>;
  /** Composite-PK names declared via `primaryKeys`. */
  readonly compositePkNames: ReadonlySet<string>;
  /** Check-constraint names reported by drizzle. */
  readonly checkNames: ReadonlySet<string>;
  /** True when the table has at least one FK reference declared. */
  readonly hasForeignKeys: boolean;
}

/**
 * Require an explicit name on an index or constraint entry.
 * Drizzle types these as optional, but the catalog comparison is keyed by name.
 * @param kind - Human-readable kind for the error message.
 * @param tableName - SQL table name for the error message.
 * @param name - Name reported by `getTableConfig`.
 */
function requireName(kind: string, tableName: string, name: string | undefined): string {
  if (name === undefined) {
    throw new Error(
      `${kind} on table '${tableName}' has no explicit name — ` +
        `all indexes and constraints must be named for live-inventory comparison.`,
    );
  }
  return name;
}

/**
 * Normalize an SQL type name for declared-vs-live comparison.
 *
 * Lowercases and maps the trivial canonical aliases the two sides may use for
 * the same type: drizzle's `getSQLType()` spelling vs the live catalog's
 * long form (`information_schema.columns.data_type` on Postgres, the declared
 * type from `pragma_table_info` on SQLite). Unknown types pass through
 * lowercased, so a new type either matches exactly or fails loudly with both
 * spellings in the diff message.
 * @param rawType - Type name from `getSQLType()` or the live catalog.
 * @returns Canonical lowercase type name.
 */
function normalizeSqlType(rawType: string): string {
  const lowered = rawType.trim().toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    int: 'integer',
    int4: 'integer',
    int8: 'bigint',
    float8: 'double precision',
    'character varying': 'varchar',
    'timestamp without time zone': 'timestamp',
  };
  return aliases[lowered] ?? lowered;
}

/**
 * Build a {@link TableInventory} from a drizzle table object for a given dialect.
 * @param packageName - Owning package name.
 * @param table - Drizzle table object.
 * @param dialect - Dialect of the table object.
 */
function buildTableInventory(packageName: string, table: Table, dialect: StorageDialect): TableInventory {
  const tableName = getTableName(table);

  const cfg = dialect === 'sqlite' ? getSqliteTableConfig(table as SQLiteTable) : getPgTableConfig(table as PgTable);

  const columnTypes = new Map<string, string>(cfg.columns.map((c) => [c.name, normalizeSqlType(c.getSQLType())]));

  const indexNames = new Map<string, { readonly unique: boolean }>();
  for (const idx of cfg.indexes) {
    const name = requireName('Index', tableName, idx.config.name);
    indexNames.set(name, { unique: idx.config.unique ?? false });
  }

  const uniqueConstraintNames = new Set<string>(
    cfg.uniqueConstraints.map((uc) => requireName('Unique constraint', tableName, uc.name)),
  );

  const compositePkNames = new Set<string>(cfg.primaryKeys.map((pk) => pk.getName()));

  const checkNames = new Set<string>(cfg.checks.map((c) => c.name));

  const hasForeignKeys = cfg.foreignKeys.length > 0;

  return {
    tableName,
    packageName,
    columnTypes,
    indexNames,
    uniqueConstraintNames,
    compositePkNames,
    checkNames,
    hasForeignKeys,
  };
}

/**
 * Load the slim inventory of all declared schema tables for a dialect.
 *
 * Mirrors the loader pattern from `schema-parity.test.ts` (~40 lines), but
 * builds {@link TableInventory} objects rather than full parity images.
 * workspace root = 4 levels up from this file:
 * `suites/ → src/ → conformance/ → storage/ → framework/`.
 * @param dialect - Active conformance dialect.
 * @returns Map from SQL table name to inventory.
 */
async function loadExpectedInventory(dialect: StorageDialect): Promise<Map<string, TableInventory>> {
  const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
  const entries = await discoverSchemas(workspaceRoot, undefined, dialect);

  const inventory = new Map<string, TableInventory>();

  for (const entry of entries) {
    const mod: Record<string, unknown> = await import(pathToFileURL(entry.schemaPath).href);

    for (const value of Object.values(mod)) {
      const isTable = dialect === 'sqlite' ? is(value, SQLiteTable) : is(value, PgTable);
      if (!isTable) continue;

      const table = value as Table;
      const inv = buildTableInventory(entry.packageName, table, dialect);

      const existing = inventory.get(inv.tableName);
      if (existing) {
        throw new Error(
          `Duplicate table name '${inv.tableName}' declared by '${existing.packageName}' ` +
            `and '${entry.packageName}'. All schema tables must have unique SQL names.`,
        );
      }
      inventory.set(inv.tableName, inv);
    }
  }

  return inventory;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifier normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an identifier to match the form it will appear in the live catalog.
 *
 * For `'postgres'`: PostgreSQL truncates identifiers to 63 **bytes**, but at
 * character boundaries (`pg_mbcliplen`) — it never emits a split multi-byte
 * character. Naive byte-slicing of a non-ASCII identifier would decode the
 * split character to U+FFFD and silently diverge from the catalog, so this
 * helper only accepts ASCII identifiers — where byte and character truncation
 * coincide — and fails loudly otherwise instead of producing a misleading
 * "missing from live catalog" mismatch.
 *
 * For `'sqlite'`: identifiers are stored verbatim — returned unchanged.
 * @param name - Raw identifier (e.g. from `getTableConfig`).
 * @param dialect - Active storage dialect.
 * @returns Catalog-normalized identifier.
 * @throws If `name` contains non-ASCII characters under `'postgres'`.
 */
function normalizeIdentifier(name: string, dialect: StorageDialect): string {
  if (dialect === 'postgres') {
    const bytes = Buffer.from(name);
    if (bytes.length !== name.length) {
      throw new Error(
        `Identifier '${name}' contains non-ASCII characters — byte-based truncation ` +
          `would diverge from PostgreSQL's character-boundary truncation`,
      );
    }
    // ASCII-only (enforced above): slicing at 63 bytes cannot split a character.
    return bytes.subarray(0, 63).toString();
  }
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live catalog queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all user-defined table names from the live catalog.
 * @param ctx - Active database context.
 * @returns Set of live table names.
 */
async function fetchLiveTables(ctx: StorageDatabaseContext): Promise<Set<string>> {
  if (ctx.dialect === 'postgres') {
    const rows = await ctx.executor.all<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    return new Set(rows.map((r) => r.table_name));
  }
  const rows = await ctx.executor.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  return new Set(rows.map((r) => r.name));
}

/**
 * Fetch column names and their normalized live SQL types for a specific table.
 * @param ctx - Active database context.
 * @param tableName - Unqualified table name.
 * @returns Map from column name to normalized live SQL type.
 */
async function fetchLiveColumns(ctx: StorageDatabaseContext, tableName: string): Promise<Map<string, string>> {
  if (ctx.dialect === 'postgres') {
    const rows = await ctx.executor.all<{ column_name: string; data_type: string }>(
      sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${tableName}`,
    );
    return new Map(rows.map((r) => [r.column_name, normalizeSqlType(r.data_type)]));
  }
  // SQLite: pragma_table_info is an inline table-valued function
  const rows = await ctx.executor.all<{ name: string; type: string }>(
    sql`SELECT name, type FROM pragma_table_info(${tableName})`,
  );
  return new Map(rows.map((r) => [r.name, normalizeSqlType(r.type)]));
}

/**
 * Fetch all index names and their uniqueness flags from the live catalog.
 *
 * Uniqueness is derived from the index DDL prefix on both dialects
 * (`CREATE UNIQUE INDEX ...`): `pg_indexes.indexdef` on Postgres,
 * `sqlite_master.sql` on SQLite (auto-indexes are already excluded).
 * @param ctx - Active database context.
 * @returns Map from index name to its live uniqueness flag.
 */
async function fetchLiveIndexes(ctx: StorageDatabaseContext): Promise<Map<string, { unique: boolean }>> {
  if (ctx.dialect === 'postgres') {
    const rows = await ctx.executor.all<{ indexname: string; indexdef: string }>(
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`,
    );
    return new Map(rows.map((r) => [r.indexname, { unique: /^CREATE UNIQUE INDEX/i.test(r.indexdef) }]));
  }
  const rows = await ctx.executor.all<{ name: string; sql: string | null }>(
    sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%'`,
  );
  return new Map(
    rows.map((r) => [r.name, { unique: typeof r.sql === 'string' && /^CREATE UNIQUE INDEX/i.test(r.sql) }]),
  );
}

/** A row from the Postgres constraint catalog. */
type PgConstraintRow = {
  /** Constraint name (from pg_constraint). */
  conname: string;
  /** 'u' = unique, 'f' = foreign key, 'p' = primary key, 'c' = check */
  contype: string;
  /** Unqualified name of the constrained table (from pg_class). */
  relname: string;
};

/**
 * Fetch the constraint catalog for the current schema, scoped per table.
 *
 * Postgres enforces constraint-name uniqueness only per table (`pg_constraint`
 * is unique on `(conrelid, conname)`), so the catalog is keyed by table name
 * first: relname → conname → contype. A flat name-keyed map would let a
 * same-named constraint on an unrelated table satisfy a lookup (false pass) —
 * a real hazard here because several constraint names are 63-byte-truncated
 * by the server before landing in the catalog.
 * Joins `pg_constraint` → `pg_class` → `pg_namespace`; uses `current_schema()`
 * which reflects the harness search_path, thereby also verifying that schema
 * isolation is in effect.
 * @param ctx - Active database context (postgres only).
 * @returns Map from table name to that table's constraint-name → contype map.
 */
async function fetchLivePgConstraints(ctx: StorageDatabaseContext): Promise<Map<string, Map<string, string>>> {
  const rows = await ctx.executor.all<PgConstraintRow>(
    sql`SELECT c.conname, c.contype, r.relname FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema()`,
  );

  const byTable = new Map<string, Map<string, string>>();

  for (const row of rows) {
    let tableConstraints = byTable.get(row.relname);
    if (!tableConstraints) {
      tableConstraints = new Map<string, string>();
      byTable.set(row.relname, tableConstraints);
    }
    tableConstraints.set(row.conname, row.contype);
  }

  return byTable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describeStorageConformance('live schema inventory', (config) => {
  const getCtx = useSuiteDatabaseContext(config);

  // ── Assertion 1: every expected table exists live, every expected column ──
  // ── exists in its live table, and the live column type matches            ──

  it('every declared table and its columns exist in the live database with matching types', async () => {
    const ctx = getCtx();
    const expected = await loadExpectedInventory(config.dialect);
    const liveTableNames = await fetchLiveTables(ctx);

    const failures: string[] = [];

    for (const [tableName, inv] of expected) {
      if (!liveTableNames.has(tableName)) {
        failures.push(`[${inv.packageName}] table '${tableName}': declared in schema, missing from live catalog`);
        continue;
      }

      const liveColumns = await fetchLiveColumns(ctx, tableName);
      for (const [colName, declaredType] of inv.columnTypes) {
        const liveType = liveColumns.get(colName);
        if (liveType === undefined) {
          failures.push(`[${inv.packageName}] ${tableName}.${colName}: declared column missing from live catalog`);
        } else if (liveType !== declaredType) {
          // Type drift: the schema twin was changed without regenerating the
          // migration chain (or vice versa). Example defect class: an epoch
          // column declared bigint but applied as integer would overflow on
          // the first real millisecond-timestamp write.
          //
          // The bare equality holds for every column, including
          // non-SQL-standard built-ins such as tsvector:
          // `information_schema.columns.data_type` reports pg_catalog types by
          // their format_type() name and reserves 'USER-DEFINED' for types
          // outside pg_catalog (a rule baked into the view definition on all
          // supported server majors), so drizzle's getSQLType() spelling and
          // the catalog spelling agree without per-column overrides.
          failures.push(
            `[${inv.packageName}] ${tableName}.${colName}: declared type '${declaredType}', live type '${liveType}'`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ── Assertion 2: live table set = expected set + exactly the ledger table ──

  it('live table set matches declared set plus exactly the migration ledger table', async () => {
    const expected = await loadExpectedInventory(config.dialect);
    const liveTableNames = await fetchLiveTables(getCtx());
    const ledgerTable = resolveDefaultMigrationsTable(config.dialect);

    const failures: string[] = [];

    // Every expected table must appear live (already checked in assertion 1, but this
    // assertion focuses on the SET relationship — both directions).
    for (const tableName of expected.keys()) {
      if (!liveTableNames.has(tableName)) {
        const pkg = expected.get(tableName)!.packageName;
        failures.push(`[${pkg}] table '${tableName}': in declared set, missing from live set`);
      }
    }

    // Every live table must be either in the expected set or be the ledger table.
    for (const liveTable of liveTableNames) {
      if (!expected.has(liveTable) && liveTable !== ledgerTable) {
        failures.push(
          `table '${liveTable}': present in live catalog but not declared in any schema ` +
            `and not the migration ledger ('${ledgerTable}') — possible drift`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  // ── Assertion 3: every expected index and constraint (normalized) exists live ──

  it('every declared index and constraint exists in the live catalog under its normalized name', async () => {
    const ctx = getCtx();
    const expected = await loadExpectedInventory(config.dialect);
    const liveIndexes = await fetchLiveIndexes(ctx);
    const livePgConstraints = config.dialect === 'postgres' ? await fetchLivePgConstraints(ctx) : undefined;

    const failures: string[] = [];

    for (const [, inv] of expected) {
      const { tableName, packageName: pkg } = inv;

      // Index names + uniqueness
      for (const [rawName, { unique: declaredUnique }] of inv.indexNames) {
        const normalized = normalizeIdentifier(rawName, config.dialect);
        const liveIndex = liveIndexes.get(normalized);
        if (liveIndex === undefined) {
          failures.push(
            `[${pkg}] ${tableName} index '${rawName}' (normalized: '${normalized}'): ` +
              `declared in schema, missing from live catalog`,
          );
        } else if (liveIndex.unique !== declaredUnique) {
          failures.push(
            `[${pkg}] ${tableName} index '${rawName}' (normalized: '${normalized}'): ` +
              `declared unique=${declaredUnique}, live unique=${liveIndex.unique}`,
          );
        }
      }

      if (config.dialect === 'postgres' && livePgConstraints !== undefined) {
        // All constraint lookups are scoped to the owning table: pg constraint
        // names are unique only per table, so a flat lookup could be satisfied
        // by a same-named constraint on an unrelated table (false pass).
        const tableConstraints = livePgConstraints.get(tableName);

        // Unique constraints → contype 'u'
        for (const rawName of inv.uniqueConstraintNames) {
          const normalized = normalizeIdentifier(rawName, config.dialect);
          const contype = tableConstraints?.get(normalized);
          if (contype === undefined) {
            failures.push(
              `[${pkg}] ${tableName} unique constraint '${rawName}' (normalized: '${normalized}'): ` +
                `declared in schema, missing from pg_constraint`,
            );
          } else if (contype !== 'u') {
            failures.push(
              `[${pkg}] ${tableName} unique constraint '${rawName}' (normalized: '${normalized}'): ` +
                `found in pg_constraint with contype='${contype}', expected 'u'`,
            );
          }
        }

        // Composite PK names → contype 'p'
        for (const rawName of inv.compositePkNames) {
          const normalized = normalizeIdentifier(rawName, config.dialect);
          const contype = tableConstraints?.get(normalized);
          if (contype === undefined) {
            failures.push(
              `[${pkg}] ${tableName} composite PK '${rawName}' (normalized: '${normalized}'): ` +
                `declared in schema, missing from pg_constraint`,
            );
          } else if (contype !== 'p') {
            failures.push(
              `[${pkg}] ${tableName} composite PK '${rawName}' (normalized: '${normalized}'): ` +
                `found in pg_constraint with contype='${contype}', expected 'p'`,
            );
          }
        }

        // Check constraint names → contype 'c'
        for (const rawName of inv.checkNames) {
          const normalized = normalizeIdentifier(rawName, config.dialect);
          const contype = tableConstraints?.get(normalized);
          if (contype === undefined) {
            failures.push(
              `[${pkg}] ${tableName} check constraint '${rawName}' (normalized: '${normalized}'): ` +
                `declared in schema, missing from pg_constraint`,
            );
          } else if (contype !== 'c') {
            failures.push(
              `[${pkg}] ${tableName} check constraint '${rawName}' (normalized: '${normalized}'): ` +
                `found in pg_constraint with contype='${contype}', expected 'c'`,
            );
          }
        }

        // FK existence per table: drizzle FK entries carry no accessible constraint name
        // (the name is auto-derived during DDL generation, not stored on the runtime object).
        // We verify that the live table has at least one FK constraint, using the same
        // table-scoped catalog as the named lookups above.
        if (inv.hasForeignKeys) {
          const hasLiveFk =
            tableConstraints !== undefined && [...tableConstraints.values()].some((contype) => contype === 'f');
          if (!hasLiveFk) {
            failures.push(
              `[${pkg}] table '${tableName}' declares FK references but no 'f' constraints ` +
                `were found in pg_constraint scoped to this table — FK DDL may have been dropped`,
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ── Assertion 4: meta-assertion — normalization rule is exercised ──
  // At least one expected constraint name must exceed 63 bytes before normalization
  // (the workflow_execution_* names documented in storage/migrations/README.md).
  // If this assertion fails, those names were renamed without updating the README contract.

  // Normalization (63-byte truncation) is a Postgres-only concern: the gate
  // makes sqlite runs report this block as skipped instead of vacuously green.
  const describePg = config.dialect === 'postgres' ? describe : describe.skip;

  describePg('normalization rule integrity', () => {
    it('at least one declared constraint name exceeds 63 bytes (normalization rule is exercised)', async () => {
      const expected = await loadExpectedInventory(config.dialect);

      let foundOverLength = false;

      outer: for (const inv of expected.values()) {
        for (const rawName of [...inv.uniqueConstraintNames, ...inv.compositePkNames, ...inv.checkNames]) {
          if (Buffer.byteLength(rawName) > 63) {
            foundOverLength = true;
            break outer;
          }
        }
      }

      expect(
        foundOverLength,
        'No expected constraint name exceeds 63 bytes. ' +
          'If the workflow_execution_* constraint names were renamed, update this assertion ' +
          'AND the identifier-length note in storage/migrations/README.md to reflect the new ' +
          'over-length names (or remove this meta-assertion if the normalization rule no ' +
          'longer has a live exercised case).',
      ).toBe(true);
    });
  });

  // ── Assertion 5: sanity floor — discovery returned a meaningful result ──
  // Guards against a silently empty discoverSchemas result that would make all
  // previous assertions vacuously pass.
  //
  // Floor is set at 20. The actual count at implementation time was 26 tables
  // across the framework schema packages. The floor is deliberately below that
  // count so it only trips on a broken/empty discovery, not on routine schema
  // refactors that drop a table or two.

  it('expected table count meets the sanity floor (guards against vacuous pass)', async () => {
    const SANITY_FLOOR = 20;
    const expected = await loadExpectedInventory(config.dialect);
    expect(
      expected.size,
      `discoverSchemas returned only ${expected.size} table(s) — expected at least ${SANITY_FLOOR}. ` +
        `A silently empty discovery result would make all live-inventory assertions vacuously pass. ` +
        `Check that workspace package.json files declare makaio.drizzleSchema correctly and that ` +
        `the workspace root resolved to the framework root.`,
    ).toBeGreaterThanOrEqual(SANITY_FLOOR);
  });
});
