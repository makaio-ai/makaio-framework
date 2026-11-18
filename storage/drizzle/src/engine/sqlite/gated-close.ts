/**
 * The `close()` of a local SQLite handle.
 * @packageDocumentation
 */
import type { DatabaseClient } from '../../client';
import { ReentrantOperationError } from '../../reentrant-operation-error';
import type { HandleGate } from './handle-gate';

/**
 * Build the `close()` of a local handle.
 *
 * Closing the connection under an open transaction or raw session would pull
 * the connection out from beneath work that is still running (and, on libsql,
 * leave it alone while closing only its replacement), so closing goes through
 * the handle's gate like any other statement: it waits for the transaction or
 * session holding the handle, and for everything that queued for the handle
 * before the close, then closes the connection. Work that starts after
 * `close()` was requested fails with the driver's closed-connection error;
 * `close()` neither cancels nor waits for work that has not reached the handle
 * yet (an operation still waiting in the operation queue, for example).
 *
 * `close()` returns synchronously when the handle is free and a promise when
 * it had to wait. It is idempotent: repeated calls return the first call's
 * result while that close is pending or succeeded. A close that failed, whether
 * it threw synchronously or its promise rejected, leaves the handle open and
 * the next call tries again, so a connection-release failure is never reported
 * as success to a later caller. A caller that holds the handle itself (inside
 * a transaction or raw session callback) cannot wait for its own release and
 * is rejected with a {@link ReentrantOperationError}, even while a close
 * requested from outside is pending.
 * @param gate - Gate of the handle, absent for remote handles that have none.
 * @param closeConnection - Closes the handle's connection.
 * @returns The handle's `close()`.
 */
export function createGatedClose(gate: HandleGate | undefined, closeConnection: () => void): DatabaseClient['close'] {
  let pending: { readonly result: void | Promise<void> } | undefined;
  return () => {
    // Checked before the cached result is returned: a close that is already
    // pending waits for the holder, so handing its promise to the holder
    // itself would make both wait for each other.
    if (gate?.heldByCaller()) throw ReentrantOperationError.forHandle();
    if (pending !== undefined) return pending.result;

    let result: void | Promise<void>;
    try {
      result = gate === undefined ? closeConnection() : gate.run(closeConnection);
    } catch (error) {
      pending = undefined;
      throw error;
    }
    pending = { result };
    if (result instanceof Promise) {
      // Retry after a failed release; the caller still receives `result`.
      result.then(undefined, () => {
        if (pending?.result === result) pending = undefined;
      });
    }
    return result;
  };
}
