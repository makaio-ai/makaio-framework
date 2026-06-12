/**
 * Dialect-aware classification of database errors.
 *
 * Raw DDL flows (migration adoption, idempotent CREATE) need to recognize
 * "schema object already exists" failures portably. SQLite reports them only
 * through the error message; Postgres reports them through SQLSTATE codes.
 * @packageDocumentation
 */
import type { StorageDialect } from './types';

/**
 * SQLSTATE codes Postgres raises for an already-existing schema object:
 * `42P07` (duplicate_table) and `42710` (duplicate_object — indexes,
 * triggers, and other named objects).
 */
const POSTGRES_DUPLICATE_OBJECT_CODES: ReadonlySet<string> = new Set(['42P07', '42710']);

/**
 * Walk an error's cause chain until a link satisfies the predicate.
 * @param error - Error (or arbitrary thrown value) to inspect.
 * @param predicate - Test applied to every `Error` link in the chain.
 * @returns `true` when any link in the cause chain satisfies the predicate.
 */
function someInCauseChain(error: unknown, predicate: (link: Error) => boolean): boolean {
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
 * SQLSTATE / driver code as a non-standard `code` property.
 * @param error - Error link to read from.
 * @returns The string code, or `undefined` when absent or non-string.
 */
function readErrorCode(error: Error): string | undefined {
  const { code } = error as Error & { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/**
 * Returns `true` when the error (or any link in its cause chain) reports
 * that a schema object already exists.
 *
 * SQLite matches the `already exists` message text; Postgres matches the
 * SQLSTATE codes `42P07`/`42710`. Used by the migration applicator to decide
 * whether a failed first CREATE can be adopted into the ledger.
 * @param error - Error thrown by a DDL statement.
 * @param dialect - Dialect of the handle that executed the statement.
 * @returns Whether the failure is a duplicate-schema-object conflict.
 */
export function isDuplicateObjectError(error: unknown, dialect: StorageDialect): boolean {
  if (dialect === 'postgres') {
    return someInCauseChain(error, (link) => {
      const code = readErrorCode(link);
      return code !== undefined && POSTGRES_DUPLICATE_OBJECT_CODES.has(code);
    });
  }
  return someInCauseChain(error, (link) => /already exists/i.test(link.message));
}

/**
 * Returns `true` when the error (or any link in its cause chain) reports a
 * unique-constraint violation.
 *
 * Postgres matches SQLSTATE `23505` (unique_violation); when `constraint` is
 * given, the driver error's `constraint` property must match it too, so
 * callers can react to one specific index without swallowing unrelated
 * violations. SQLite matches the `UNIQUE constraint failed` message text —
 * SQLite errors carry the violated column list, not the constraint name, so
 * the `constraint` scope applies only on Postgres.
 *
 * Used by write paths that resolve write-write races through a bounded retry
 * (for example MAX-based counter assignment under Postgres `READ COMMITTED`,
 * where two concurrent statements can compute the same next value).
 * @param error - Error thrown by a DML statement.
 * @param dialect - Dialect of the handle that executed the statement.
 * @param constraint - Optional Postgres constraint/index name to scope the match.
 * @returns Whether the failure is a unique-constraint violation.
 */
export function isUniqueViolationError(error: unknown, dialect: StorageDialect, constraint?: string): boolean {
  if (dialect === 'postgres') {
    return someInCauseChain(error, (link) => {
      if (readErrorCode(link) !== '23505') {
        return false;
      }
      if (constraint === undefined) {
        return true;
      }
      const { constraint: violated } = link as Error & { constraint?: unknown };
      return violated === constraint;
    });
  }
  return someInCauseChain(error, (link) => /UNIQUE constraint failed/i.test(link.message));
}
