/**
 * Cross-driver result helpers for Drizzle write operations.
 *
 * The libsql dialect returns `{ rowsAffected: number }`, the bun-sqlite
 * dialect returns `{ changes: number }`, and the node-postgres dialect returns
 * `{ rowCount: number }`. Consumers must not depend on any of these fields
 * directly — use {@link didAffectRows} to normalise across drivers.
 * @packageDocumentation
 */

/**
 * Shape emitted by Drizzle write operations across all supported drivers.
 *
 * The libsql (Node.js) driver populates `rowsAffected`, the bun-sqlite driver
 * populates `changes`, and the node-postgres driver populates `rowCount`.
 * Several may be present when a future driver version unifies the surface;
 * any being absent is normal.
 */
export interface DrizzleWriteResult {
  /** Affected-row count reported by the libsql driver. */
  readonly rowsAffected?: number | null;
  /** Affected-row count reported by the bun-sqlite driver. */
  readonly changes?: number | null;
  /** Affected-row count reported by the node-postgres driver. */
  readonly rowCount?: number | null;
}

/**
 * Extract the affected row count from a Drizzle write result.
 *
 * Returns the driver-appropriate count regardless of which supported driver
 * is active at runtime.
 * @param result - Write result from a Drizzle `insert`, `update`, or `delete`.
 * @returns Number of affected rows, defaulting to `0` when no field is set.
 */
export function affectedRowCount(result: DrizzleWriteResult): number {
  return result.rowsAffected ?? result.changes ?? result.rowCount ?? 0;
}

/**
 * Determine whether a Drizzle write operation mutated at least one row.
 *
 * Normalises the driver-specific result shape so callers do not need to know
 * which dialect is active at runtime.
 * @param result - Write result from a Drizzle `insert`, `update`, or `delete`.
 * @returns `true` when one or more rows were affected.
 */
export function didAffectRows(result: DrizzleWriteResult): boolean {
  return affectedRowCount(result) > 0;
}
