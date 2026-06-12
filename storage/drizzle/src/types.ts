import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { StorageDialect } from '@makaio/contracts';

/**
 * Storage backend dialect identifier.
 *
 * Re-exported from `@makaio/contracts` — the single source of truth for the
 * dialect vocabulary. Postgres is opt-in via connection URL; SQLite is the
 * default dialect and the fallback for unbranded handles (see
 * {@link getDatabaseDialect}).
 */
export type { StorageDialect };

/**
 * Brand key attached to database handles by `createDatabaseClient`.
 *
 * Declared via `Symbol.for` so the brand survives duplicated module instances
 * (a bundled dist copy and a workspace copy of this package resolve the same
 * symbol through the global symbol registry).
 */
export const DATABASE_DIALECT: unique symbol = Symbol.for('makaio.storage.dialect');

/**
 * Canonical database type alias for all Makaio storage consumers: the
 * dialect-portable Drizzle query-builder surface.
 *
 * Typed as the shared async-compatible Drizzle surface, which keeps the
 * cross-driver query contract stable while excluding libsql-only members such
 * as `$client`, `batch()`, and `resultKind`.
 *
 * Raw statement members (`run`, `all`, `get`, `values`) are intentionally
 * excluded as well — they exist only on the SQLite drivers. Raw SQL goes
 * through the executor resolved by `getRawSqlExecutor(db)` instead. This
 * narrowing turns "would crash on Postgres" into "does not compile".
 *
 * At runtime, the factory in `client.ts` may return a `BunSQLiteDatabase`
 * instance (sync dialect) cast to this type. That is safe because:
 * - All query-builder methods (`select`, `insert`, `update`, `delete`) exist
 * on both drivers with compatible call signatures.
 * - Awaiting Bun's synchronous return values still preserves the existing
 *   async call sites, even though it introduces the normal microtask boundary
 *   of `await`.
 *
 * **All consumers must import this type** instead of importing
 * `LibSQLDatabase` directly from `drizzle-orm/libsql`. This single import
 * seam is what makes the runtime driver swap transparent to callers.
 *
 * **Caveat:** Consumers must not access libsql-only members such as
 * `db.$client` directly — use the `close()` function returned by
 * `createDatabaseClient` instead. The factory handles driver-specific teardown
 * internally.
 * @typeParam TSchema - Drizzle table schema record. Defaults to an empty schema.
 */
export type MakaioDatabase<TSchema extends Record<string, unknown> = Record<string, never>> = Omit<
  LibSQLDatabase<TSchema>,
  '$client' | 'batch' | 'resultKind' | 'run' | 'all' | 'get' | 'values'
> & {
  /**
   * Dialect brand attached by `createDatabaseClient`. Optional because
   * hand-rolled handles (e.g. in-memory test clients) are never branded —
   * they resolve to `'sqlite'` via {@link getDatabaseDialect}.
   */
  readonly [DATABASE_DIALECT]?: StorageDialect;
};

/**
 * Read the active storage dialect of a database handle.
 *
 * Unbranded handles default to `'sqlite'` — a safe default, not a guess: only
 * `createDatabaseClient` produces Postgres handles and it always brands them.
 * Hand-rolled test clients (e.g. raw in-memory drizzle instances) therefore
 * keep SQLite semantics without any extra setup.
 * @param db - Database handle to inspect. The brand is schema-independent, so
 *   handles of any schema generic are accepted (plain `MakaioDatabase` is
 *   assignable to this parameter type).
 * @returns The branded dialect, or `'sqlite'` when the handle is unbranded.
 */
export function getDatabaseDialect(db: MakaioDatabase<Record<string, unknown>>): StorageDialect {
  return db[DATABASE_DIALECT] ?? 'sqlite';
}
