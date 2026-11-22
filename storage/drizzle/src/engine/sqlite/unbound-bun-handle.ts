import { is } from 'drizzle-orm';
import { SQLiteBunSession } from 'drizzle-orm/bun-sqlite/session';
import type { MakaioDatabase } from '../../types';

/** Structural view of a drizzle handle that may expose a bun-sqlite session. */
interface SessionCarrier {
  /** Session the handle was constructed with, if any. */
  readonly session?: unknown;
}

/**
 * Handles and transaction contexts adapted by `bindBunSqliteTransactions`. Written only through
 * {@link markBunSqliteHandleBound}; a weak set, so a closed handle is not kept alive.
 */
const boundBunSqliteHandles = new WeakSet<object>();

/**
 * Record that `bindBunSqliteTransactions` adapted `db` (a handle or one of its
 * transaction contexts) to the async
 * transaction contract. The mark cannot be produced by assigning or binding a
 * `transaction` property, so a hand-rolled handle stays recognisable as unbound.
 * @internal Called only by the binding in `bun-transaction.ts`; not part of the package index.
 * @param db - The handle or transaction context that was just adapted.
 */
export function markBunSqliteHandleBound(db: object): void {
  boundBunSqliteHandles.add(db);
}

/**
 * Whether `db` is a bun-sqlite handle whose `transaction()` still runs
 * drizzle's native, synchronous boundary instead of the async atomicity
 * contract that `bindBunSqliteTransactions` installs.
 *
 * Drizzle's bun-sqlite session identifies itself through its `entityKind`,
 * checked with drizzle's `is()`; a handle counts as bound only when
 * `bindBunSqliteTransactions` marked it ({@link markBunSqliteHandleBound}).
 * An own `transaction` property is no proof: a hand-rolled handle may have
 * re-bound drizzle's native method itself.
 *
 * Kept apart from `bun-transaction.ts` so `executeTransaction` can use it
 * without an import cycle through the nested-transaction queue.
 * @param db - Database handle to probe.
 * @returns `true` when `db` is a bun-sqlite handle that was never bound.
 */
export function isUnboundBunSqliteHandle(db: MakaioDatabase): boolean {
  const session = (db as SessionCarrier).session;
  return is(session, SQLiteBunSession) && !boundBunSqliteHandles.has(db);
}
