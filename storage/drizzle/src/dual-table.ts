/**
 * Generic dual-table factory: one column definition, both dialects.
 *
 * `defineDualTable` builds a SQLite table object AND a Postgres table object
 * from a single dialect-neutral column definition, eliminating the hand-written
 * twin schema files that previously had to be kept in sync by review.
 *
 * Type mechanics: every bundle helper constructs the real SQLite builder AND
 * the real Postgres builder; chain modifiers forward to both; result types are
 * extracted from drizzle's own method signatures; and `defineDualTable` feeds
 * mapped-type splits into the genuine `sqliteTable`/`pgTable` factories so row
 * inference goes through drizzle's `BuildColumns`. Casts are confined to two
 * documented honesty-model boundaries: the single one in {@link dual} (where
 * the runtime forwarder is re-typed as the strong per-column chain — see the
 * comment there) and the split-map reconciliation in {@link defineDualTable}
 * (the per-dialect `Record` is the structural twin of the mapped split). Both
 * boundaries are pinned by the parity / negative type tests in
 * `storage-conformance`'s `dual-parity-types.test.ts`, so a drizzle signature
 * change still breaks loudly there.
 *
 * The factory covers:
 *
 *   - `references()` / FK incl. `onDelete`, cross-table AND self-FK
 *   - per-dialect FK return-type annotations folded into ONE call
 *   - distinct int4 (`int4`) and int8 (`int8`) dual integer kinds
 *   - enum-config `text` preserving the name-literal generic
 *   - the extras path: composite `primaryKey()`, `unique()`, `uniqueIndex().where()`, `check()`
 *   - `autoPk` / `float8`
 */
import { sqliteTable, text as sqliteText, integer as sqliteInteger } from 'drizzle-orm/sqlite-core';
import type {
  SQLiteColumn,
  SQLiteColumnBuilderBase,
  SQLiteTableExtraConfigValue,
  SQLiteTableWithColumns,
} from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, integer as pgInteger } from 'drizzle-orm/pg-core';
import type { PgColumn, PgColumnBuilderBase, PgTableExtraConfigValue, PgTableWithColumns } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import type { $Type, BuildColumns, BuildExtraConfigColumns, ColumnBuilderBase, SQL } from 'drizzle-orm';
import * as sqliteCols from './columns/sqlite';
import * as pgCols from './columns/postgres';

// ---------------------------------------------------------------------------
// Method-result extraction over the REAL drizzle builder signatures.
// ---------------------------------------------------------------------------
type NotNullOf<B, TBase> = B extends { notNull(): infer R extends TBase } ? R : never;
type DefaultOf<B, TBase> = B extends { default(value: never): infer R extends TBase } ? R : never;
type PrimaryKeyOf<B, TBase> = B extends { primaryKey(): infer R extends TBase } ? R : never;
type UniqueOf<B, TBase> = B extends { unique(name?: string): infer R extends TBase } ? R : never;

/** Data type accepted by `.default()` — honours `$type` pinning like drizzle does. */
type DataOf<B extends ColumnBuilderBase> = B['_'] extends { $type: infer U } ? U : B['_']['data'];

/**
 * Foreign-key actions — shared shape across both dialects (drizzle's
 * `ReferenceConfig['actions']` is identical for sqlite-core and pg-core).
 */
export interface DualReferenceActions {
  readonly onUpdate?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';
  readonly onDelete?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';
}

/**
 * A built foreign-key target as a pair of both dialects' columns. Returned by
 * {@link DualTable.columnPair} and consumed by {@link DualColumnRef}.
 */
export interface DualColumnPair {
  readonly sqlite: SQLiteColumn;
  readonly postgres: PgColumn;
}

/**
 * A dual reference target: a lazy thunk returning BOTH dialects' built
 * columns. For a cross-table FK this is `() => other.columnPair('col')`; for a
 * self-FK it is `() => self.columnPair('col')` resolved against the table this
 * very builder is part of. `references()` forwards `.sqlite` to the SQLite
 * builder and `.postgres` to the Postgres builder, so each dialect receives the
 * dialect-correct column with NO per-dialect annotation at the call site — the
 * per-dialect column annotation a hand-written twin needs is absorbed once,
 * here.
 */
export type DualColumnRef = () => DualColumnPair;

// ---------------------------------------------------------------------------
// Dual builder pair
// ---------------------------------------------------------------------------

/**
 * Structural base used as the generic constraint in `defineDualTable` —
 * deliberately WITHOUT the chain methods so concrete `DualBuilder`
 * instantiations stay assignable to it.
 */
export interface DualColumnBuilderBase<
  S extends SQLiteColumnBuilderBase = SQLiteColumnBuilderBase,
  P extends PgColumnBuilderBase = PgColumnBuilderBase,
> {
  readonly sqlite: S;
  readonly postgres: P;
}

/** Chainable pair of one SQLite builder and one Postgres builder. */
export interface DualBuilder<S extends SQLiteColumnBuilderBase, P extends PgColumnBuilderBase>
  extends DualColumnBuilderBase<S, P> {
  notNull(): DualBuilder<NotNullOf<S, SQLiteColumnBuilderBase>, NotNullOf<P, PgColumnBuilderBase>>;
  default(
    value: (DataOf<S> & DataOf<P>) | SQL,
  ): DualBuilder<DefaultOf<S, SQLiteColumnBuilderBase>, DefaultOf<P, PgColumnBuilderBase>>;
  primaryKey(): DualBuilder<PrimaryKeyOf<S, SQLiteColumnBuilderBase>, PrimaryKeyOf<P, PgColumnBuilderBase>>;
  unique(name?: string): DualBuilder<UniqueOf<S, SQLiteColumnBuilderBase>, UniqueOf<P, PgColumnBuilderBase>>;
  $type<T>(): DualBuilder<$Type<S, T>, $Type<P, T>>;
  /**
   * Declare a foreign key for BOTH dialects from one call.
   * `references()` returns `this` on both drizzle builders, so the dual type is
   * unchanged — chaining stays exact.
   * @param ref - Lazy dual column-pair thunk (cross-table or self-FK).
   * @param actions - Optional `onDelete` / `onUpdate` (shared shape).
   */
  references(ref: DualColumnRef, actions?: DualReferenceActions): DualBuilder<S, P>;
}

/**
 * Runtime view of one dialect column builder: only the chain methods the
 * forwarder calls. The methods return this same view so the forwarding stays
 * free of `any`. drizzle's `*ColumnBuilderBase` marker interfaces do not expose
 * these methods on their public face, so the forwarder reads them through this
 * structural view and reconstructs the strong per-column chain types via the
 * single boundary cast in {@link dual}.
 */
interface RuntimeColumnBuilder {
  notNull(): RuntimeColumnBuilder;
  default(value: unknown): RuntimeColumnBuilder;
  primaryKey(): RuntimeColumnBuilder;
  unique(name?: string): RuntimeColumnBuilder;
  $type(): RuntimeColumnBuilder;
  references(ref: () => unknown, actions?: DualReferenceActions): RuntimeColumnBuilder;
}

/** Runtime forwarder shape: both dialect faces plus the chain methods. */
interface RuntimeDualBuilder {
  readonly sqlite: RuntimeColumnBuilder;
  readonly postgres: RuntimeColumnBuilder;
  notNull(): RuntimeDualBuilder;
  default(value: unknown): RuntimeDualBuilder;
  primaryKey(): RuntimeDualBuilder;
  unique(name?: string): RuntimeDualBuilder;
  $type(): RuntimeDualBuilder;
  references(ref: DualColumnRef, actions?: DualReferenceActions): RuntimeDualBuilder;
}

/**
 * Pair one SQLite builder with one Postgres builder into a chainable
 * {@link DualBuilder}. Each chain method forwards to both builders; `$type` is
 * a type-only no-op at runtime.
 *
 * The forwarder is fully typed against {@link RuntimeDualBuilder} (no `any`);
 * the strong per-column chain types are reconstructed by one documented
 * honesty-model cast at the boundary — the same pattern as
 * `defineDialectSchema` in `dialect.ts`.
 * @param s - SQLite column builder.
 * @param p - Postgres column builder.
 * @returns A dual builder forwarding every chain method to both dialects.
 */
function dual<S extends SQLiteColumnBuilderBase, P extends PgColumnBuilderBase>(s: S, p: P): DualBuilder<S, P> {
  const mk = (sb: RuntimeColumnBuilder, pb: RuntimeColumnBuilder): RuntimeDualBuilder => ({
    sqlite: sb,
    postgres: pb,
    notNull: () => mk(sb.notNull(), pb.notNull()),
    default: (value: unknown) => mk(sb.default(value), pb.default(value)),
    primaryKey: () => mk(sb.primaryKey(), pb.primaryKey()),
    unique: (name?: string) => mk(sb.unique(name), pb.unique(name)),
    $type: () => mk(sb, pb),
    references: (ref: DualColumnRef, actions?: DualReferenceActions) =>
      mk(
        sb.references(() => ref().sqlite, actions),
        pb.references(() => ref().postgres, actions),
      ),
  });
  // Honesty-model cast (mirrors defineDialectSchema in dialect.ts): the runtime
  // builders fully implement the chain methods; the static drizzle base types
  // do not surface them. Congruence is enforced by the parity / negative type
  // tests. This is the chain-forwarding boundary; the only other sanctioned cast
  // is the split-map reconciliation in defineDualTable below.
  const builders = s as unknown as RuntimeColumnBuilder;
  const pgBuilders = p as unknown as RuntimeColumnBuilder;
  return mk(builders, pgBuilders) as unknown as DualBuilder<S, P>;
}

// ---------------------------------------------------------------------------
// The dialect-neutral column bundle handed to `colsFn`.
// ---------------------------------------------------------------------------
const dualColumns = {
  /**
   * Plain text column — `text` on both dialects (drizzle core per dialect).
   * @param name - SQL column name.
   * @returns Dual builder for a `text` column.
   */
  text: <TName extends string>(name: TName) => dual(sqliteText(name), pgText(name)),
  /**
   * Enum-config text — preserves the `enum` name-literal generic on BOTH
   * dialects (`text(name, { enum })`).
   *
   * The signature mirrors drizzle's own `text` overload: generic over the
   * element union `U` and the readonly tuple `T extends Readonly<[U, ...U[]]>`
   * so the literal values flow into `$inferSelect` as `'a' | 'b'`, not `string`.
   * A naive `{ enum: TEnum }` parameter widens the array literal to `string[]`
   * and collapses the union.
   * @param name - SQL column name.
   * @param config - Drizzle text config carrying the `enum` literal tuple.
   * @returns Dual builder for a `text` column narrowed to the enum union.
   */
  textEnum: <TName extends string, U extends string, T extends Readonly<[U, ...U[]]>>(
    name: TName,
    config: { enum: T },
  ) => dual(sqliteText(name, config), pgText(name, config)),
  /**
   * Unix-epoch-ms — SQLite `integer` / PG `bigint` ('number' mode).
   * @param name - SQL column name.
   * @returns Dual builder for a millisecond-epoch column.
   */
  epochMs: (name: string) => dual(sqliteCols.epochMs(name), pgCols.epochMs(name)),
  /**
   * Boolean — SQLite `integer` (boolean mode) / PG native `boolean`.
   * @param name - SQL column name.
   * @returns Dual builder for a boolean column.
   */
  bool: (name: string) => dual(sqliteCols.bool(name), pgCols.bool(name)),
  /**
   * Structured JSON — SQLite `text` (json mode) / PG `jsonb`, pinned to T.
   * @param name - SQL column name.
   * @returns Dual builder for a JSON column typed as `T`.
   */
  jsonCol: <T>(name: string) => dual(sqliteCols.jsonCol<T>(name), pgCols.jsonCol<T>(name)),
  /**
   * Auto PK — SQLite `integer PK AUTOINCREMENT` / PG identity `bigint` PK.
   * @param name - SQL column name.
   * @returns Dual builder for an auto-generated primary key column.
   */
  autoPk: (name: string) => dual(sqliteCols.autoPk(name), pgCols.autoPk(name)),
  /**
   * 8-byte float — SQLite `real` / PG `double precision`.
   * @param name - SQL column name.
   * @returns Dual builder for an 8-byte floating-point column.
   */
  float8: (name: string) => dual(sqliteCols.float8(name), pgCols.float8(name)),
  /**
   * 32-bit integer — SQLite `integer` / PG `integer` (int4↔int4). For values
   * that fit comfortably in 32 bits (PIDs, ordinals, attempt counters).
   * @param name - SQL column name.
   * @returns Dual builder for a 32-bit integer column.
   */
  int4: (name: string) => dual(sqliteInteger(name), pgInteger(name)),
  /**
   * 64-bit integer — SQLite `integer` / PG `bigint` ('number' mode, int53-safe).
   * For values that exceed the 32-bit range (byte cursors over large files).
   * Distinct from `epochMs` only in intent; identical SQL mapping.
   * @param name - SQL column name.
   * @returns Dual builder for a 64-bit integer column.
   */
  int8: (name: string) => dual(sqliteInteger(name), pgBigint(name, { mode: 'number' })),
};

/**
 * Dialect-neutral column bundle passed to {@link defineDualTable}'s `colsFn`.
 *
 * Each helper builds both dialects' column builders from a single call, so a
 * column declared once can never silently drift between the SQLite and Postgres
 * faces.
 */
export type DualColumnBundle = typeof dualColumns;

// ---------------------------------------------------------------------------
// defineDualTable
// ---------------------------------------------------------------------------

type SqliteSplit<TCols extends Record<string, DualColumnBuilderBase>> = {
  [K in keyof TCols]: TCols[K]['sqlite'];
};
type PgSplit<TCols extends Record<string, DualColumnBuilderBase>> = {
  [K in keyof TCols]: TCols[K]['postgres'];
};

/** Result of {@link defineDualTable}: both real drizzle tables, fully typed. */
export interface DualTable<TName extends string, TCols extends Record<string, DualColumnBuilderBase>> {
  readonly sqlite: SQLiteTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: BuildColumns<TName, SqliteSplit<TCols>, 'sqlite'>;
    dialect: 'sqlite';
  }>;
  readonly postgres: PgTableWithColumns<{
    name: TName;
    schema: undefined;
    columns: BuildColumns<TName, PgSplit<TCols>, 'pg'>;
    dialect: 'pg';
  }>;
  /**
   * Lazy dual column-pair accessor for foreign-key targets. Returns the BUILT
   * columns of both faces under one key, so a referencing table can write
   * `() => target.columnPair('id')` and have each dialect resolve correctly.
   * @param key - Column key (the JS property name on the dual record).
   * @returns The SQLite and Postgres built columns for `key`.
   */
  columnPair<K extends keyof TCols>(key: K): DualColumnPair;
}

/**
 * Dialect-divergent extra config (indexes etc.). TWO callbacks: partial-index
 * predicates legitimately differ (`= 1` vs `= true`).
 */
export interface DualTableExtras<TName extends string, TCols extends Record<string, DualColumnBuilderBase>> {
  readonly sqlite?: (self: BuildColumns<TName, SqliteSplit<TCols>, 'sqlite'>) => SQLiteTableExtraConfigValue[];
  readonly postgres?: (self: BuildExtraConfigColumns<TName, PgSplit<TCols>, 'pg'>) => PgTableExtraConfigValue[];
}

/**
 * Define ONE table for BOTH dialects from a single column definition.
 * @param name - SQL table name (shared by both dialects).
 * @param colsFn - Column definition over the dialect-neutral bundle.
 * @param extras - Optional per-dialect indexes/constraints.
 * @returns A {@link DualTable} exposing both built table objects and `columnPair`.
 */
export function defineDualTable<TName extends string, TCols extends Record<string, DualColumnBuilderBase>>(
  name: TName,
  colsFn: (c: DualColumnBundle) => TCols,
  extras?: DualTableExtras<TName, TCols>,
): DualTable<TName, TCols> {
  const cols = colsFn(dualColumns);
  const sqliteMap: Record<string, SQLiteColumnBuilderBase> = {};
  const pgMap: Record<string, PgColumnBuilderBase> = {};
  for (const [key, value] of Object.entries(cols)) {
    sqliteMap[key] = value.sqlite;
    pgMap[key] = value.postgres;
  }
  // Split-map reconciliation boundary: the per-dialect `Record` built above is
  // the structural twin of the mapped `SqliteSplit`/`PgSplit` over `TCols`
  // (`Object.entries` erases the key↔builder correspondence the mapped type
  // keeps). Feeding it into the genuine factories routes row inference through
  // drizzle's `BuildColumns`; the dual-parity type tests pin the result.
  const sqlite = sqliteTable(name, sqliteMap as SqliteSplit<TCols>, extras?.sqlite);
  const postgres = pgTable(name, pgMap as PgSplit<TCols>, extras?.postgres);
  const sqliteColumns = getTableColumns(sqlite);
  const postgresColumns = getTableColumns(postgres);
  return {
    sqlite,
    postgres,
    columnPair(key) {
      return {
        sqlite: sqliteColumns[key as string],
        postgres: postgresColumns[key as string],
      };
    },
  };
}
