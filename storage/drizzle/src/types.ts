import type { LibSQLDatabase } from 'drizzle-orm/libsql';

/**
 * Canonical database type alias for all Makaio storage consumers.
 *
 * Typed as the shared async-compatible Drizzle surface, which keeps the
 * cross-driver query contract stable while excluding libsql-only members such
 * as `$client`, `batch()`, and `resultKind`.
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
  '$client' | 'batch' | 'resultKind'
>;
