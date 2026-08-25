/**
 * Engine-dispatched transaction-scoped stable-key locking.
 * @packageDocumentation
 */
import { sql } from 'drizzle-orm';
import { resolveStorageEngine } from './engine/registry';
import type { TransactionLock } from './engine/types';
import type { MakaioDatabase } from './types';
import type { TransactionCallback } from './transaction';

/** Transaction context accepted by {@link acquireTransactionLocks}. */
export type TransactionLockTransaction = Parameters<TransactionCallback<unknown>>[0];

/**
 * Acquire all requested stable keys before the caller evaluates or mutates the
 * rows they protect.
 *
 * Expressions are evaluated one at a time so an engine that maps keys to
 * database locks controls the exact acquisition order. SQLite returns no
 * expressions because its transaction writer serialization already supplies
 * the required ordering.
 * @param db - Database handle selecting the storage engine strategy.
 * @param tx - Open transaction that will retain acquired locks until completion.
 * @param locks - Stable keys the following statements may mutate.
 */
export async function acquireTransactionLocks(
  db: MakaioDatabase,
  tx: TransactionLockTransaction,
  locks: readonly TransactionLock[],
): Promise<void> {
  for (const expression of resolveStorageEngine(db).transactionLocks.lockExpressions(locks)) {
    await tx.select({ acquired: expression }).from(sql.raw('(SELECT 1) AS transaction_lock_anchor'));
  }
}
