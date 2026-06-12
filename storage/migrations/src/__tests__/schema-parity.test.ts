/**
 * Anti-drift net 2: structural and type-image parity between the SQLite
 * canonical schema and the Postgres twin schema for every framework storage
 * package.
 *
 * **Role in the anti-drift system**
 *
 * - Net 1 (compile-time pin): `defineDialectSchema` + `PostgresTwinSchema` in
 *   `@makaio/storage-drizzle` enforce $inferSelect row equality at compile time.
 * - **Net 2 (this file)**: introspects the actual built table objects via
 *   `getTableConfig` and asserts structural, flag, default, index, constraint,
 *   and FK parity at the schema-object level. Runs in the normal SQLite vitest
 *   shard — no database needed.
 * - Net 4 (generation strictness): `discoverSchemas` rejects packages that
 *   declare `postgres` entries without `sqlite` entries, or vice versa.
 *
 * **Allowlist seam**
 *
 * `PG_ONLY_COLUMNS` lists `'<table>.<column>'` keys for Postgres-only generated
 * columns that have no SQLite counterpart. It currently holds exactly one entry:
 * `'messages.content_tsv'` — the stored tsvector column that backs the Postgres
 * full-text-search path. `PG_ONLY_INDEXES` holds the corresponding GIN index
 * `'messages.idx_messages_content_tsv'`. Both allowlists are bi-directionally
 * validated: a stale entry (present in the allowlist but absent from the Postgres
 * schema) is also an error.
 *
 * **Residual type-image ambiguity**
 *
 * A column hand-written as `PgInteger` (int4) for a field that uses `epochMs`
 * (SQLiteInteger → bigint) would pass the `COLUMN_TYPE_IMAGE` check because
 * `SQLiteInteger` maps to `['PgInteger', 'PgBigInt53']`. That ambiguity is
 * closed by:
 * 1. The reverse-bigint rule: `PgBigInt53` requires `SQLiteInteger` (enforced
 *    below) — prevents a SQLiteText column from masquerading as bigint.
 * 2. The identity-pairing assertion: `autoIncrement === true` on SQLite
 *    requires `generatedAlwaysAsIdentity` on Postgres (both directions).
 * 3. Bundle adoption: columns declared via `epochMs` / `autoPk` from
 *    `@makaio/storage-drizzle/columns/*` are structurally consistent by
 *    construction; review flags any hand-written epoch column as a lint item.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { is, getTableName, type Table } from 'drizzle-orm';
import { SQLiteTable, getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { PgTable, getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core';
import { discoverSchemas } from '../discover-schemas.js';

// ─────────────────────────────────────────────────────────────────────────────
// Type-image mapping and allowlist
// Verified against drizzle-orm 0.45.2 columnType strings.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQLite columnType → allowed Postgres columnTypes.
 * An unmapped SQLite type (e.g. SQLiteBlob entering the chain) causes an
 * explicit loud failure rather than silently passing.
 */
const COLUMN_TYPE_IMAGE: Readonly<Record<string, readonly string[]>> = {
  SQLiteText: ['PgText'],
  SQLiteTextJson: ['PgJsonb'],
  SQLiteBoolean: ['PgBoolean'],
  SQLiteInteger: ['PgInteger', 'PgBigInt53'],
  SQLiteReal: ['PgDoublePrecision'],
};

/**
 * Postgres-only columns the parity net deliberately ignores, keyed
 * `'<table>.<column>'`.
 *
 * Currently holds exactly one entry: `'messages.content_tsv'` — the stored
 * `tsvector` generated column that backs the Postgres full-text-search path.
 * An entry present here that does NOT appear in the Postgres table image is
 * also an error — stale allowlist entries are caught.
 */
const PG_ONLY_COLUMNS: ReadonlySet<string> = new Set<string>(['messages.content_tsv']);

/**
 * Postgres-only indexes the parity net deliberately ignores in the
 * postgres→sqlite direction, keyed `'<table>.<index>'`.
 *
 * Currently holds exactly one entry: `'messages.idx_messages_content_tsv'` —
 * the GIN index on the stored tsvector column. An entry present here whose
 * index is absent from the Postgres image is also an error — stale allowlist
 * entries are caught.
 */
const PG_ONLY_INDEXES: ReadonlySet<string> = new Set<string>(['messages.idx_messages_content_tsv']);

// ─────────────────────────────────────────────────────────────────────────────
// Image data structures
// ─────────────────────────────────────────────────────────────────────────────

interface ColumnParityImage {
  readonly column: string;
  readonly columnType: string;
  readonly notNull: boolean;
  readonly primary: boolean;
  readonly isUnique: boolean;
  readonly hasDefault: boolean;
  /**
   * Only populated when `.default` is a JS primitive (string | number |
   * boolean). Undefined both when the column has no default and when the
   * default is an SQL expression (e.g. the sql`'{}'` pattern) — expression
   * defaults carry opaque SQL objects on both dialects and are compared only
   * via {@link hasDefault}.
   */
  readonly defaultPrimitive: string | number | boolean | undefined;
  /**
   * True when the column has identity-like auto-generation:
   * - SQLite: `autoIncrement === true`
   * - Postgres: `generatedIdentity?.type === 'always'`
   */
  readonly identityLike: boolean;
}

interface IndexImage {
  readonly unique: boolean;
  /** Whether the index has a WHERE clause (partial index). Predicate text is NOT compared. */
  readonly partial: boolean;
  readonly columns: readonly string[];
}

interface TableParityImage {
  readonly packageName: string;
  readonly table: string;
  readonly columns: ReadonlyMap<string, ColumnParityImage>;
  readonly indexes: ReadonlyMap<string, IndexImage>;
  readonly uniqueConstraints: ReadonlyMap<string, readonly string[]>;
  readonly checkNames: ReadonlySet<string>;
  readonly compositePrimaryKeys: ReadonlyMap<string, readonly string[]>;
  /**
   * FK edge strings: `<cols>-><ftable>(<fcols>):onDelete=<x>:onUpdate=<y>`.
   * `onDelete` and `onUpdate` are normalized via `?? 'no action'` on both
   * sides — SQLite reports `undefined` when unset; Postgres reports
   * `'no action'`. This normalization was verified against drizzle-orm 0.45.2.
   */
  readonly foreignKeyEdges: ReadonlySet<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: build parity images from drizzle table objects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the value is a JS primitive (not an SQL expression object).
 * @param value - The column default value.
 */
function isPrimitive(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/**
 * Extract the column name from an index column entry. Drizzle types index
 * entries as a union of plain columns (which carry a `name`) and SQL
 * expressions (which do not). Framework schemas only index plain columns;
 * encountering an expression index is a loud failure rather than a silent skip.
 * @param tableName - SQL table name for the error message.
 * @param indexName - Index name for the error message.
 * @param col - Index column entry from `getTableConfig`.
 */
function indexColumnName(tableName: string, indexName: string, col: object): string {
  if ('name' in col && typeof col.name === 'string') {
    return col.name;
  }
  throw new Error(
    `Index '${indexName}' on table '${tableName}' uses a SQL expression column — ` +
      `the parity net only supports plain-column indexes.`,
  );
}

/**
 * Require an explicit name on an index or unique constraint. Drizzle types
 * these names as optional, but the parity comparison is keyed by name: SQLite
 * indexes always carry one, unique constraints derive one at construction, and
 * Postgres twins must name indexes identically to the canonical schema.
 * @param kind - Human-readable entity kind for the error message.
 * @param tableName - SQL table name for the error message.
 * @param name - Name reported by `getTableConfig`.
 */
function requireName(kind: string, tableName: string, name: string | undefined): string {
  if (name === undefined) {
    throw new Error(
      `${kind} on table '${tableName}' has no explicit name — ` +
        `twins must name indexes and constraints identically to the canonical schema.`,
    );
  }
  return name;
}

/**
 * Structural view of a drizzle column as reported by `getTableConfig`. Both
 * `SQLiteColumn` and `PgColumn` satisfy this shape; the dialect-specific
 * identity markers are optional and read only through
 * {@link DialectIntrospection.isIdentity}.
 */
interface IntrospectedColumn {
  readonly name: string;
  readonly columnType: string;
  readonly notNull: boolean;
  readonly primary: boolean;
  readonly isUnique: boolean;
  readonly hasDefault: boolean;
  readonly default: unknown;
  /** SQLite only: `PRIMARY KEY AUTOINCREMENT` flag (absent from base column typings). */
  readonly autoIncrement?: boolean | undefined;
  /** Postgres only: `GENERATED ... AS IDENTITY` configuration. */
  readonly generatedIdentity?: { readonly type: 'always' | 'byDefault' } | undefined;
}

/**
 * Structural view of a `getTableConfig` result covering exactly the buckets
 * the parity net compares. Both dialects' config objects satisfy this shape,
 * so the image builder is written once against it.
 */
interface IntrospectedTableConfig {
  readonly columns: readonly IntrospectedColumn[];
  readonly indexes: readonly {
    readonly config: {
      readonly name?: string | undefined;
      readonly unique?: boolean | undefined;
      readonly where?: unknown;
      readonly columns: readonly object[];
    };
  }[];
  readonly uniqueConstraints: readonly {
    readonly name?: string | undefined;
    readonly columns: readonly { readonly name: string }[];
  }[];
  readonly checks: readonly { readonly name: string }[];
  readonly primaryKeys: readonly {
    getName(): string;
    readonly columns: readonly { readonly name: string }[];
  }[];
  readonly foreignKeys: readonly {
    readonly onDelete?: string | undefined;
    readonly onUpdate?: string | undefined;
    readonly reference: () => {
      readonly columns: readonly { readonly name: string }[];
      readonly foreignTable: Table;
      readonly foreignColumns: readonly { readonly name: string }[];
    };
  }[];
}

/**
 * Dialect seam of the image builder: table detection, config extraction, and
 * the identity-marker read. Everything else in {@link buildTableImage} is
 * dialect-agnostic, so a bucket added to the comparison exists exactly once.
 */
interface DialectIntrospection {
  /**
   * Type guard for this dialect's drizzle table class.
   * @param value - Arbitrary schema-module export.
   */
  isTable(value: unknown): value is Table;
  /**
   * Run this dialect's `getTableConfig`, viewed through the shared structural
   * surface.
   * @param table - A table accepted by {@link isTable}.
   */
  getConfig(table: Table): IntrospectedTableConfig;
  /**
   * Whether the column auto-generates identity values (`AUTOINCREMENT` on
   * SQLite, `GENERATED ALWAYS AS IDENTITY` on Postgres).
   * @param column - Column entry from {@link getConfig}.
   */
  isIdentity(column: IntrospectedColumn): boolean;
}

/** SQLite side of the {@link DialectIntrospection} seam. */
const sqliteIntrospection: DialectIntrospection = {
  isTable: (value): value is Table => is(value, SQLiteTable),
  // Downcast is safe: getConfig is only called with tables accepted by isTable.
  getConfig: (table) => getSqliteTableConfig(table as SQLiteTable),
  isIdentity: (column) => column.autoIncrement === true,
};

/** Postgres side of the {@link DialectIntrospection} seam. */
const pgIntrospection: DialectIntrospection = {
  isTable: (value): value is Table => is(value, PgTable),
  // Downcast is safe: getConfig is only called with tables accepted by isTable.
  getConfig: (table) => getPgTableConfig(table as PgTable),
  isIdentity: (column) => column.generatedIdentity?.type === 'always',
};

/**
 * Build a {@link TableParityImage} from a drizzle table object.
 * @param packageName - Package name for error messages.
 * @param table - The drizzle table object.
 * @param introspection - Dialect seam for config extraction and identity flags.
 */
function buildTableImage(packageName: string, table: Table, introspection: DialectIntrospection): TableParityImage {
  const cfg = introspection.getConfig(table);
  const tableName = getTableName(table);

  const columns = new Map<string, ColumnParityImage>();
  for (const col of cfg.columns) {
    columns.set(col.name, {
      column: col.name,
      columnType: col.columnType,
      notNull: col.notNull,
      primary: col.primary,
      isUnique: col.isUnique,
      hasDefault: col.hasDefault,
      defaultPrimitive: isPrimitive(col.default) ? col.default : undefined,
      identityLike: introspection.isIdentity(col),
    });
  }

  const indexes = new Map<string, IndexImage>();
  for (const idx of cfg.indexes) {
    const idxName = requireName('Index', tableName, idx.config.name);
    indexes.set(idxName, {
      unique: idx.config.unique ?? false,
      partial: idx.config.where !== undefined,
      columns: idx.config.columns.map((c) => indexColumnName(tableName, idxName, c)),
    });
  }

  const uniqueConstraints = new Map<string, readonly string[]>();
  for (const uc of cfg.uniqueConstraints) {
    uniqueConstraints.set(
      requireName('Unique constraint', tableName, uc.name),
      uc.columns.map((c) => c.name),
    );
  }

  const checkNames = new Set<string>(cfg.checks.map((c) => c.name));

  const compositePrimaryKeys = new Map<string, readonly string[]>();
  for (const pk of cfg.primaryKeys) {
    compositePrimaryKeys.set(
      pk.getName(),
      pk.columns.map((c) => c.name),
    );
  }

  const foreignKeyEdges = new Set<string>();
  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference();
    const cols = ref.columns.map((c) => c.name).join(',');
    const ftable = getTableName(ref.foreignTable);
    const fcols = ref.foreignColumns.map((c) => c.name).join(',');
    const onDelete = (fk.onDelete ?? 'no action').toLowerCase();
    const onUpdate = (fk.onUpdate ?? 'no action').toLowerCase();
    foreignKeyEdges.add(`${cols}->${ftable}(${fcols}):onDelete=${onDelete}:onUpdate=${onUpdate}`);
  }

  return {
    packageName,
    table: tableName,
    columns,
    indexes,
    uniqueConstraints,
    checkNames,
    compositePrimaryKeys,
    foreignKeyEdges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery: load schema objects from both dialects via discoverSchemas.
// Workspace root mirrors generate-schema.ts: src/__tests__ → src → migrations
// → storage → framework root (4 levels up from the test file).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load schema modules for one dialect and extract table objects.
 * @param dialect - `'sqlite'` or `'postgres'`.
 * @returns Map from SQL table name to parity image, keyed by table name.
 */
async function loadTableImages(dialect: 'sqlite' | 'postgres'): Promise<Map<string, TableParityImage>> {
  const introspection = dialect === 'sqlite' ? sqliteIntrospection : pgIntrospection;
  const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
  const entries = await discoverSchemas(workspaceRoot, undefined, dialect);

  const images = new Map<string, TableParityImage>();

  for (const entry of entries) {
    const mod: Record<string, unknown> = await import(pathToFileURL(entry.schemaPath).href);

    for (const value of Object.values(mod)) {
      if (!introspection.isTable(value)) continue;
      const image = buildTableImage(entry.packageName, value, introspection);
      const existing = images.get(image.table);
      if (existing) {
        throw new Error(
          `Duplicate table name '${image.table}' from packages '${existing.packageName}' and '${entry.packageName}'. ` +
            `All declared schema tables must have unique SQL names.`,
        );
      }
      images.set(image.table, image);
    }
  }

  return images;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured diff helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a structured diff entry for parity failures.
 * @param packageName - Owning package name.
 * @param table - SQL table name.
 * @param column - Optional column name within the table.
 * @param expected - Expected value description.
 * @param actual - Actual value description.
 */
function diff(
  packageName: string,
  table: string,
  column: string | undefined,
  expected: string,
  actual: string,
): string {
  const location = column !== undefined ? `${table}.${column}` : table;
  return `[${packageName}] ${location}: expected ${expected} got ${actual}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared test state (loaded once before all it-blocks)
// ─────────────────────────────────────────────────────────────────────────────

/** Cached schema images shared across all it-blocks inside the describe. */
let cachedImages: { sqlite: Map<string, TableParityImage>; postgres: Map<string, TableParityImage> } | undefined;

describe('schema parity (sqlite ↔ postgres twins)', () => {
  // Load both dialect images once — the it-blocks share this state.
  // Each it-block calls `ensureLoaded()` before accessing images; subsequent
  // calls return the cached result immediately.
  async function ensureLoaded(): Promise<{
    sqliteImages: Map<string, TableParityImage>;
    pgImages: Map<string, TableParityImage>;
  }> {
    if (cachedImages) return { sqliteImages: cachedImages.sqlite, pgImages: cachedImages.postgres };
    const [sqlite, postgres] = await Promise.all([loadTableImages('sqlite'), loadTableImages('postgres')]);
    cachedImages = { sqlite, postgres };
    return { sqliteImages: sqlite, pgImages: postgres };
  }

  // ── (a) Table sets ──────────────────────────────────────────────────────

  it('(a) table sets: sqlite and postgres declare the same tables', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const sqliteNames = new Set(sqliteImages.keys());
    const pgNames = new Set(pgImages.keys());

    const failures: string[] = [];

    // Tables present in SQLite but missing from Postgres
    for (const name of sqliteNames) {
      if (!pgNames.has(name)) {
        const pkg = sqliteImages.get(name)!.packageName;
        failures.push(`[${pkg}] ${name}: table present in sqlite, missing from postgres`);
      }
    }

    // Tables present in Postgres but missing from SQLite (and not in allowlist)
    for (const name of pgNames) {
      if (!sqliteNames.has(name)) {
        const pkg = pgImages.get(name)!.packageName;
        failures.push(`[${pkg}] ${name}: table present in postgres, missing from sqlite`);
      }
    }

    // Sanity floor: at least some tables exist and include 'sessions'
    expect(sqliteImages.size, 'discovery must find at least one table').toBeGreaterThan(0);
    expect(sqliteImages.has('sessions'), "discovery must include the 'sessions' table").toBe(true);

    expect(failures).toEqual([]);
  });

  // ── (b) Column names + flags + defaults ────────────────────────────────

  it('(b) per-table: column names, notNull, primary, isUnique, hasDefault, and primitive defaults', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const failures: string[] = [];

    for (const [tableName, sqliteImg] of sqliteImages) {
      const pgImg = pgImages.get(tableName);
      if (!pgImg) continue; // Caught by (a)

      const pkg = sqliteImg.packageName;

      // Compute effective column name sets, accounting for the PG_ONLY_COLUMNS allowlist.
      const allowedPgOnly = new Set<string>();
      for (const key of PG_ONLY_COLUMNS) {
        const [t, c] = key.split('.');
        if (t === tableName && c) allowedPgOnly.add(c);
      }

      // SQLite columns: all must appear in Postgres (minus allowlist)
      for (const [colName, sqCol] of sqliteImg.columns) {
        if (!pgImg.columns.has(colName)) {
          failures.push(`[${pkg}] ${tableName}.${colName}: column present in sqlite, missing from postgres`);
          continue;
        }
        const pgCol = pgImg.columns.get(colName)!;

        if (sqCol.notNull !== pgCol.notNull)
          failures.push(
            diff(pkg, tableName, colName, `notNull=${String(sqCol.notNull)}`, `notNull=${String(pgCol.notNull)}`),
          );
        if (sqCol.primary !== pgCol.primary)
          failures.push(
            diff(pkg, tableName, colName, `primary=${String(sqCol.primary)}`, `primary=${String(pgCol.primary)}`),
          );
        if (sqCol.isUnique !== pgCol.isUnique)
          failures.push(
            diff(pkg, tableName, colName, `isUnique=${String(sqCol.isUnique)}`, `isUnique=${String(pgCol.isUnique)}`),
          );
        if (sqCol.hasDefault !== pgCol.hasDefault)
          failures.push(
            diff(
              pkg,
              tableName,
              colName,
              `hasDefault=${String(sqCol.hasDefault)}`,
              `hasDefault=${String(pgCol.hasDefault)}`,
            ),
          );

        // Strict default-representation parity: primitive defaults must match
        // exactly, and a primitive default on one side paired with an SQL
        // expression on the other is representation drift. SQL-expression
        // defaults are compared only via hasDefault above — both sides carry
        // opaque SQL objects, so they meet here as undefined === undefined.
        if (sqCol.defaultPrimitive !== pgCol.defaultPrimitive) {
          failures.push(
            diff(
              pkg,
              tableName,
              colName,
              `default=${JSON.stringify(sqCol.defaultPrimitive)}`,
              `default=${JSON.stringify(pgCol.defaultPrimitive)}`,
            ),
          );
        }
      }

      // Postgres-only columns: must all be in PG_ONLY_COLUMNS; stale allowlist entries are also errors
      for (const colName of pgImg.columns.keys()) {
        const key = `${tableName}.${colName}`;
        if (!sqliteImg.columns.has(colName)) {
          if (!PG_ONLY_COLUMNS.has(key)) {
            failures.push(
              `[${pkg}] ${tableName}.${colName}: column present in postgres but not in sqlite and not in PG_ONLY_COLUMNS allowlist`,
            );
          }
        }
      }

      // Stale allowlist entries: if an allowlisted key references this table but
      // the column is absent from the Postgres image, the entry is stale.
      for (const pgOnlyCol of allowedPgOnly) {
        if (!pgImg.columns.has(pgOnlyCol)) {
          failures.push(
            `[${pkg}] ${tableName}.${pgOnlyCol}: PG_ONLY_COLUMNS entry is stale — column not found in postgres`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ── (c+d) Type image + identity pairing ────────────────────────────────

  it('(c+d) per-column: type-image mapping, reverse-bigint rule, and identity pairing', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const failures: string[] = [];

    for (const [tableName, sqliteImg] of sqliteImages) {
      const pgImg = pgImages.get(tableName);
      if (!pgImg) continue; // Caught by (a)

      const pkg = sqliteImg.packageName;

      for (const [colName, sqCol] of sqliteImg.columns) {
        const pgCol = pgImg.columns.get(colName);
        if (!pgCol) continue; // Caught by (b)

        // Type image: SQLite column type must be in the mapping table
        const allowedPgTypes = COLUMN_TYPE_IMAGE[sqCol.columnType];
        if (!allowedPgTypes) {
          failures.push(
            `[${pkg}] ${tableName}.${colName}: unmapped sqlite columnType '${sqCol.columnType}' — update COLUMN_TYPE_IMAGE`,
          );
          continue;
        }

        // Type image: PG column type must be in the allowed set for this SQLite type
        if (!allowedPgTypes.includes(pgCol.columnType)) {
          failures.push(
            diff(
              pkg,
              tableName,
              colName,
              `pg columnType ∈ [${allowedPgTypes.join(', ')}] for sqlite type ${sqCol.columnType}`,
              `pg columnType=${pgCol.columnType}`,
            ),
          );
        }

        // Reverse-bigint rule: PgBigInt53 must only appear for SQLiteInteger columns
        if (pgCol.columnType === 'PgBigInt53' && sqCol.columnType !== 'SQLiteInteger') {
          failures.push(
            diff(
              pkg,
              tableName,
              colName,
              `PgBigInt53 only valid for SQLiteInteger (got ${sqCol.columnType})`,
              `pg=${pgCol.columnType}`,
            ),
          );
        }

        // Identity pairing (both directions):
        //   sqlite.autoIncrement === true ⟺ (pg.columnType === 'PgBigInt53' && pg.generatedIdentity?.type === 'always')
        const sqliteIsIdentity = sqCol.identityLike;
        const pgIsIdentity = pgCol.identityLike && pgCol.columnType === 'PgBigInt53';

        if (sqliteIsIdentity && !pgIsIdentity) {
          failures.push(
            diff(
              pkg,
              tableName,
              colName,
              `pg column to be PgBigInt53 with generatedAlwaysAsIdentity (sqlite is autoIncrement)`,
              `pg columnType=${pgCol.columnType}, identityLike=${String(pgCol.identityLike)}`,
            ),
          );
        }
        if (!sqliteIsIdentity && pgIsIdentity) {
          failures.push(
            diff(
              pkg,
              tableName,
              colName,
              `sqlite column to have autoIncrement=true (pg has generatedAlwaysAsIdentity)`,
              `sqlite identityLike=${String(sqCol.identityLike)}`,
            ),
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ── (e) Index maps ──────────────────────────────────────────────────────

  it('(e) index maps: names, unique flags, partial-index presence, and column lists', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const failures: string[] = [];

    for (const [tableName, sqliteImg] of sqliteImages) {
      const pgImg = pgImages.get(tableName);
      if (!pgImg) continue;

      const pkg = sqliteImg.packageName;

      // Indexes in sqlite but not postgres
      for (const [idxName, sqIdx] of sqliteImg.indexes) {
        if (!pgImg.indexes.has(idxName)) {
          failures.push(`[${pkg}] ${tableName} index '${idxName}': present in sqlite, missing from postgres`);
          continue;
        }
        const pgIdx = pgImg.indexes.get(idxName)!;

        if (sqIdx.unique !== pgIdx.unique)
          failures.push(
            `[${pkg}] ${tableName} index '${idxName}': unique=${String(sqIdx.unique)} (sqlite) vs unique=${String(pgIdx.unique)} (postgres)`,
          );

        // Partial-index presence is compared; predicate text is intentionally NOT
        // compared because SQLite uses `= 1` (integer-boolean) while Postgres uses
        // `= true` (native boolean). The DDL divergence is by design.
        if (sqIdx.partial !== pgIdx.partial)
          failures.push(
            `[${pkg}] ${tableName} index '${idxName}': partial=${String(sqIdx.partial)} (sqlite) vs partial=${String(pgIdx.partial)} (postgres)`,
          );

        // Column list (ordered) must match exactly
        const sqCols = sqIdx.columns.join(',');
        const pgCols = pgIdx.columns.join(',');
        if (sqCols !== pgCols)
          failures.push(
            `[${pkg}] ${tableName} index '${idxName}': columns=[${sqCols}] (sqlite) vs columns=[${pgCols}] (postgres)`,
          );
      }

      // Indexes in postgres but not sqlite — skip allowlisted PG-only indexes
      for (const idxName of pgImg.indexes.keys()) {
        const key = `${tableName}.${idxName}`;
        if (!sqliteImg.indexes.has(idxName) && !PG_ONLY_INDEXES.has(key)) {
          failures.push(`[${pkg}] ${tableName} index '${idxName}': present in postgres, missing from sqlite`);
        }
      }

      // Stale PG_ONLY_INDEXES entries: an allowlisted key for this table whose
      // index is absent from the Postgres image means the allowlist is out of sync.
      for (const pgOnlyKey of PG_ONLY_INDEXES) {
        const [t, idxName] = pgOnlyKey.split('.');
        if (t === tableName && idxName && !pgImg.indexes.has(idxName)) {
          failures.push(
            `[${pkg}] ${tableName}.${idxName}: PG_ONLY_INDEXES entry is stale — index not found in postgres`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ── (f) Unique constraints ──────────────────────────────────────────────

  it('(f) unique constraints: names and column lists (distinct bucket from unique indexes)', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const failures: string[] = [];

    for (const [tableName, sqliteImg] of sqliteImages) {
      const pgImg = pgImages.get(tableName);
      if (!pgImg) continue;

      const pkg = sqliteImg.packageName;

      for (const [ucName, sqCols] of sqliteImg.uniqueConstraints) {
        if (!pgImg.uniqueConstraints.has(ucName)) {
          failures.push(
            `[${pkg}] ${tableName} unique constraint '${ucName}': present in sqlite, missing from postgres`,
          );
          continue;
        }
        const pgCols = pgImg.uniqueConstraints.get(ucName)!;
        if (sqCols.join(',') !== pgCols.join(',')) {
          failures.push(
            `[${pkg}] ${tableName} unique constraint '${ucName}': columns=[${sqCols.join(',')}] (sqlite) vs columns=[${pgCols.join(',')}] (postgres)`,
          );
        }
      }

      for (const ucName of pgImg.uniqueConstraints.keys()) {
        if (!sqliteImg.uniqueConstraints.has(ucName)) {
          failures.push(
            `[${pkg}] ${tableName} unique constraint '${ucName}': present in postgres, missing from sqlite`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ── (g) Check-constraint names ──────────────────────────────────────────

  it('(g) check-constraint name sets (predicate text not compared)', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const failures: string[] = [];

    for (const [tableName, sqliteImg] of sqliteImages) {
      const pgImg = pgImages.get(tableName);
      if (!pgImg) continue;

      const pkg = sqliteImg.packageName;

      for (const name of sqliteImg.checkNames) {
        if (!pgImg.checkNames.has(name))
          failures.push(`[${pkg}] ${tableName} check '${name}': present in sqlite, missing from postgres`);
      }
      for (const name of pgImg.checkNames) {
        if (!sqliteImg.checkNames.has(name))
          failures.push(`[${pkg}] ${tableName} check '${name}': present in postgres, missing from sqlite`);
      }
    }

    expect(failures).toEqual([]);
  });

  // ── (h) Composite primary keys ──────────────────────────────────────────

  it('(h) composite primary keys: names and ordered column lists', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const failures: string[] = [];

    for (const [tableName, sqliteImg] of sqliteImages) {
      const pgImg = pgImages.get(tableName);
      if (!pgImg) continue;

      const pkg = sqliteImg.packageName;

      for (const [pkName, sqCols] of sqliteImg.compositePrimaryKeys) {
        if (!pgImg.compositePrimaryKeys.has(pkName)) {
          failures.push(`[${pkg}] ${tableName} composite PK '${pkName}': present in sqlite, missing from postgres`);
          continue;
        }
        const pgCols = pgImg.compositePrimaryKeys.get(pkName)!;
        if (sqCols.join(',') !== pgCols.join(',')) {
          failures.push(
            `[${pkg}] ${tableName} composite PK '${pkName}': columns=[${sqCols.join(',')}] (sqlite) vs columns=[${pgCols.join(',')}] (postgres)`,
          );
        }
      }

      for (const pkName of pgImg.compositePrimaryKeys.keys()) {
        if (!sqliteImg.compositePrimaryKeys.has(pkName)) {
          failures.push(`[${pkg}] ${tableName} composite PK '${pkName}': present in postgres, missing from sqlite`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ── (i) FK edges ────────────────────────────────────────────────────────

  it('(i) FK edges: target table, target columns, onDelete, and onUpdate (names excluded)', async () => {
    const { sqliteImages, pgImages } = await ensureLoaded();

    const failures: string[] = [];

    for (const [tableName, sqliteImg] of sqliteImages) {
      const pgImg = pgImages.get(tableName);
      if (!pgImg) continue;

      const pkg = sqliteImg.packageName;

      for (const edge of sqliteImg.foreignKeyEdges) {
        if (!pgImg.foreignKeyEdges.has(edge)) {
          failures.push(`[${pkg}] ${tableName} FK edge '${edge}': present in sqlite, missing from postgres`);
        }
      }

      for (const edge of pgImg.foreignKeyEdges) {
        if (!sqliteImg.foreignKeyEdges.has(edge)) {
          failures.push(`[${pkg}] ${tableName} FK edge '${edge}': present in postgres, missing from sqlite`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
