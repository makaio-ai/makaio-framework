/**
 * Engine-owned classification of database errors.
 *
 * Raw DDL flows (migration adoption, idempotent CREATE) and bounded-retry
 * write paths need to recognize driver failures portably. Each storage engine
 * owns the knowledge of how its drivers report these conditions; consumers go
 * through `StorageEngine.errors` instead of branching on the dialect.
 *
 * This module hosts the SQLite classifiers backing the built-in engine, plus
 * the cause-chain inspection helpers engine packages build their own
 * classifiers from.
 * @packageDocumentation
 */

/**
 * Walk an error's cause chain until a link satisfies the predicate.
 *
 * Building block for engine error classifiers: drivers and call sites
 * routinely wrap failures (`new Error(..., { cause })`), so classification
 * must consider every `Error` link in the chain, not just the outermost one.
 * @param error - Error (or arbitrary thrown value) to inspect.
 * @param predicate - Test applied to every `Error` link in the chain.
 * @returns `true` when any link in the cause chain satisfies the predicate.
 */
export function someInCauseChain(error: unknown, predicate: (link: Error) => boolean): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (predicate(current)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Read a string `code` property off an error, if present.
 *
 * Driver errors (node-postgres `DatabaseError`, libsql errors) carry their
 * SQLSTATE / driver code as a non-standard `code` property. Building block
 * for engine error classifiers that match on those codes.
 * @param error - Error link to read from.
 * @returns The string code, or `undefined` when absent or non-string.
 */
export function readErrorCode(error: Error): string | undefined {
  const { code } = error as Error & { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/**
 * Returns `true` when the error (or any link in its cause chain) reports
 * that a schema object already exists on SQLite.
 *
 * Matches the `already exists` message text — SQLite reports duplicate schema
 * objects only through the error message. Used by the migration applicator to
 * decide whether a failed first CREATE can be adopted into the ledger.
 * @param error - Error thrown by a DDL statement.
 * @returns Whether the failure is a duplicate-schema-object conflict.
 */
export function isSqliteDuplicateObjectError(error: unknown): boolean {
  return someInCauseChain(error, (link) => /already exists/i.test(link.message));
}

/**
 * Returns `true` when the error (or any link in its cause chain) reports a
 * SQLite unique-constraint violation.
 *
 * Matches the `UNIQUE constraint failed` message text. SQLite errors carry
 * the violated column list, not constraint names, so constraint scoping is a
 * Postgres-only concept honored by the Postgres engine's classifier — the
 * built-in engine ignores the optional scope when delegating here.
 *
 * Used by write paths that resolve write-write races through a bounded retry
 * (for example MAX-based counter assignment on engines whose default
 * isolation level lets two concurrent statements compute the same next value).
 * @param error - Error thrown by a DML statement.
 * @returns Whether the failure is a unique-constraint violation.
 */
export function isSqliteUniqueViolationError(error: unknown): boolean {
  return someInCauseChain(error, (link) => /UNIQUE constraint failed/i.test(link.message));
}
