/**
 * Postgres-specific classification of database errors.
 *
 * node-postgres surfaces server failures as `DatabaseError` instances carrying
 * the SQLSTATE in a non-standard `code` property (and the violated constraint
 * name in `constraint` for constraint failures). These classifiers walk the
 * cause chain via the shared helpers from `@makaio/storage-drizzle`, so
 * wrapped driver errors classify the same as bare ones.
 * @packageDocumentation
 */
import { readErrorCode, someInCauseChain } from '@makaio/storage-drizzle';

/**
 * SQLSTATE codes Postgres raises for an already-existing schema object:
 * `42P07` (duplicate_table) and `42710` (duplicate_object — indexes,
 * triggers, and other named objects).
 */
const POSTGRES_DUPLICATE_OBJECT_CODES: ReadonlySet<string> = new Set(['42P07', '42710']);

/**
 * Returns `true` when the error (or any link in its cause chain) reports
 * that a schema object already exists on Postgres.
 *
 * Matches the SQLSTATE codes `42P07`/`42710`. Used by the migration
 * applicator to decide whether a failed first CREATE can be adopted into the
 * ledger.
 * @param error - Error thrown by a DDL statement.
 * @returns Whether the failure is a duplicate-schema-object conflict.
 */
export function isPostgresDuplicateObjectError(error: unknown): boolean {
  return someInCauseChain(error, (link) => {
    const code = readErrorCode(link);
    return code !== undefined && POSTGRES_DUPLICATE_OBJECT_CODES.has(code);
  });
}

/**
 * Returns `true` when the error (or any link in its cause chain) reports a
 * Postgres unique-constraint violation.
 *
 * Matches SQLSTATE `23505` (unique_violation); when `constraint` is given,
 * the driver error's `constraint` property must match it too, so callers can
 * react to one specific index without swallowing unrelated violations.
 *
 * Used by write paths that resolve write-write races through a bounded retry
 * (for example MAX-based counter assignment under `READ COMMITTED`, where two
 * concurrent statements can compute the same next value).
 * @param error - Error thrown by a DML statement.
 * @param constraint - Optional constraint/index name to scope the match.
 * @returns Whether the failure is a unique-constraint violation.
 */
export function isPostgresUniqueViolationError(error: unknown, constraint?: string): boolean {
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
