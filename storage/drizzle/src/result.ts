/**
 * Cross-driver result helpers for Drizzle write operations.
 *
 * The libsql dialect returns `{ rowsAffected: number }` while the bun-sqlite
 * dialect returns `{ changes: number }`. Consumers must not depend on either
 * field directly — use {@link didAffectRows} to normalise across drivers.
 * @packageDocumentation
 */

/**
 * Shape emitted by Drizzle write operations across all supported drivers.
 *
 * The libsql (Node.js) driver populates `rowsAffected`; the bun-sqlite driver
 * populates `changes`. Both may be present when a future driver version unifies
 * the surface; either being absent is normal.
 */
export interface DrizzleWriteResult {
  readonly rowsAffected?: number | null;
  readonly changes?: number | null;
}

/**
 * Determine whether a Drizzle write operation mutated at least one row.
 *
 * Normalises the driver-specific result shape so callers do not need to know
 * which SQLite dialect is active at runtime.
 * @param result - Write result from a Drizzle `insert`, `update`, or `delete`.
 * @returns `true` when one or more rows were affected.
 */
export function didAffectRows(result: DrizzleWriteResult): boolean {
  return (result.rowsAffected ?? result.changes ?? 0) > 0;
}

/**
 * Extract the affected row count from a Drizzle write result.
 *
 * Returns the driver-appropriate count regardless of whether the libsql or
 * bun-sqlite dialect is active.
 * @param result - Write result from a Drizzle `insert`, `update`, or `delete`.
 * @returns Number of affected rows, defaulting to `0` when neither field is set.
 */
export function affectedRowCount(result: DrizzleWriteResult): number {
  return result.rowsAffected ?? result.changes ?? 0;
}
