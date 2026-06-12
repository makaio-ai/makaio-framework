/**
 * Dialect schema seam — bidirectional type-congruence enforcement between
 * SQLite canonical tables and their Postgres twins.
 *
 * The `resolveSchema` helper selects the right table record for a given
 * database handle at registration time. The `defineDialectSchema` constructor
 * enforces structural parity at compile time: a missing twin, a non-PgTable
 * value, or any select-row drift fails compilation naming the offending table
 * key. `$inferInsert` is deliberately NOT pinned — identity columns are absent
 * from Postgres insert models while optional on SQLite autoincrement.
 *
 * **Named-key exemption**: `PostgresOnlyGeneratedColumnKey` names the single
 * Postgres-only generated column (`contentTsv`) that is omitted from the
 * select-row equality check in `PostgresTwinSchema`. Any other extra, missing,
 * or mistyped Postgres column outside this named set still fails compilation.
 * The structural parity test (`schema-parity.test.ts`) polices the exempted key
 * per-table via `PG_ONLY_COLUMNS`.
 * @packageDocumentation
 */

import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { getDatabaseDialect, type MakaioDatabase } from './types';

/**
 * Bidirectional type equality — resolves to `true` only when `A` and `B` are
 * mutually identical (not merely mutually assignable in one direction).
 */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * The single Postgres-only generated column key that is exempt from the
 * select-row equality check in {@link PostgresTwinSchema}.
 *
 * Only this named key is exempt; any other extra, missing, or mistyped
 * Postgres column still fails compilation. The structural parity test
 * (`schema-parity.test.ts`) polices the exempted key per-table via
 * `PG_ONLY_COLUMNS`.
 */
export type PostgresOnlyGeneratedColumnKey = 'contentTsv';

/**
 * Validation type for a Postgres twin record: for every SQLite table key, the
 * twin's `$inferSelect` row — with the Postgres-only generated column omitted
 * via {@link PostgresOnlyGeneratedColumnKey} — must be identical to the
 * canonical table's. On drift the expected property type collapses to an
 * error-literal object that names the offending table key in the compile error.
 */
export type PostgresTwinSchema<
  TSqlite extends Record<string, SQLiteTable>,
  TPostgres extends Record<keyof TSqlite, PgTable>,
> = {
  readonly [K in keyof TSqlite]: Equal<
    TSqlite[K]['$inferSelect'],
    Omit<TPostgres[K]['$inferSelect'], PostgresOnlyGeneratedColumnKey>
  > extends true
    ? TPostgres[K]
    : { readonly 'postgres twin has select-row drift for table': K };
};

/**
 * A schema declared for both storage dialects — a per-dialect table registry
 * whose keys ARE the closed `StorageDialect` union, so {@link resolveSchema}
 * resolves by plain key lookup. `postgres` is intentionally typed as
 * `TSqlite`: at runtime it holds real `pgTable` twins, presented through the
 * canonical SQLite-typed face (the same documented honesty model as the
 * driver cast in `client.ts`). Congruence is compiler-enforced by
 * {@link PostgresTwinSchema} at construction and by the structural parity test.
 */
export interface DialectSchema<TSqlite extends Record<string, SQLiteTable>> {
  readonly sqlite: TSqlite;
  readonly postgres: TSqlite;
}

/**
 * Build a {@link DialectSchema} from a canonical SQLite table record and its
 * congruent Postgres twins. Compile-time net: a missing twin, a non-PgTable
 * value, or any select-row drift (outside the named
 * {@link PostgresOnlyGeneratedColumnKey} exemption) fails compilation naming
 * the table key. `$inferInsert` is deliberately NOT pinned (identity columns
 * are absent from PG insert models while optional on SQLite autoincrement).
 * @param sqlite - Canonical SQLite table objects, keyed by export name.
 * @param postgres - Postgres twin table objects under the same keys.
 * @returns The dialect schema consumed by {@link resolveSchema}.
 */
export function defineDialectSchema<
  TSqlite extends Record<string, SQLiteTable>,
  TPostgres extends Record<keyof TSqlite, PgTable>,
>(sqlite: TSqlite, postgres: TPostgres & PostgresTwinSchema<TSqlite, TPostgres>): DialectSchema<TSqlite> {
  // Honesty-model cast (mirrors the driver cast in client.ts): the runtime
  // objects are real pgTable twins; type congruence is enforced above and by
  // the structural parity test. This is the single sanctioned cast here.
  return { sqlite, postgres: postgres as unknown as TSqlite };
}

/**
 * Resolve the dialect-correct table objects for a database handle.
 *
 * {@link DialectSchema} is a per-dialect table registry keyed by
 * `StorageDialect` — its keys ARE the closed dialect union — so resolution is
 * a branch-free registry lookup by the handle's dialect brand. Returns the
 * SQLite-typed view in both cases; under Postgres the runtime objects are the
 * congruent twins, so drizzle compiles correct SQL and value mappings.
 * @param db - Database handle (brand read via `getDatabaseDialect`; unbranded
 *   handles resolve to SQLite). The brand is schema-independent, so handles of
 *   any schema generic are accepted (plain `MakaioDatabase` is assignable to
 *   this parameter type).
 * @param schema - Dialect schema built by {@link defineDialectSchema}.
 * @returns The table record for the handle's active dialect.
 */
export function resolveSchema<TSqlite extends Record<string, SQLiteTable>>(
  db: MakaioDatabase<Record<string, unknown>>,
  schema: DialectSchema<TSqlite>,
): TSqlite {
  return schema[getDatabaseDialect(db)];
}
