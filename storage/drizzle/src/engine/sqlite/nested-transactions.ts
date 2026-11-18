/**
 * Serialization of the nested transactions (savepoints) of one transaction.
 *
 * A nested `tx.transaction()` is a savepoint on the one connection the
 * transaction owns. Savepoints form a stack: the one opened last must be
 * released or rolled back first. Two nested transactions of the same
 * transaction that run at the same time are therefore broken by construction
 * (the second opens inside the first, and rolling the first back removes the
 * second's savepoint: "no such savepoint"), on every SQLite driver.
 *
 * Both driver adapters route the nested transactions of each transaction
 * context through {@link createSiblingQueue}, so siblings run one after the
 * other in the order they were requested. A nested transaction opened from
 * inside its own sibling's callback (through the parent instead of the child
 * context) is a re-entrant call and is rejected rather than left to wait for
 * itself.
 * @packageDocumentation
 */
import { serializeByKey } from '../../transaction';

/** Runs one nested transaction once the siblings requested before it finished. */
export type SiblingQueue = <T>(nestedTransaction: () => Promise<T>) => Promise<T>;

/**
 * Create the queue that serializes the nested transactions of one transaction context.
 * @returns A queue scoped to exactly one parent transaction.
 */
export function createSiblingQueue(): SiblingQueue {
  const tails = new Map<'siblings', Promise<void>>();
  return (nestedTransaction) => serializeByKey(tails, 'siblings', nestedTransaction);
}

/** A drizzle transaction context that can open nested transactions. */
export interface NestedTransactionScope<TContext> {
  /**
   * Run a callback inside a savepoint of this transaction.
   * @param callback - Work to run with the nested transaction context.
   */
  transaction<T>(callback: (nested: TContext) => Promise<T>): Promise<T>;
}

/**
 * Make a transaction context run its nested transactions one at a time,
 * recursively for every nested context it hands out.
 * @param context - Transaction context, adapted in place.
 * @typeParam TContext - Transaction context type.
 */
export function serializeNestedTransactions<TContext extends NestedTransactionScope<TContext>>(
  context: TContext,
): void {
  const queue = createSiblingQueue();
  const openSavepoint = context.transaction.bind(context);
  context.transaction = <T>(callback: (nested: TContext) => Promise<T>): Promise<T> =>
    queue(() =>
      openSavepoint((nested) => {
        serializeNestedTransactions(nested);
        return callback(nested);
      }),
    );
}
