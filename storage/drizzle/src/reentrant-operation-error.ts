/**
 * Error for work that would have to wait for itself.
 * @packageDocumentation
 */

/**
 * A database operation was requested from inside the work that already holds
 * what the operation has to wait for.
 *
 * Waiting would never end: the holder only releases after its callback
 * settled, and the callback is waiting for the nested operation. The error is
 * raised before anything waits, so the holder fails with a diagnosis instead of
 * stalling every other user of the handle.
 *
 * Only the cycle that passes through one async context is detectable. A
 * callback that awaits work started elsewhere which in turn waits for the
 * handle (a bus request answered by a handler that uses the same database, for
 * example) forms the same cycle through promises, which cannot be seen from
 * here: such callbacks must contain database work only.
 */
export class ReentrantOperationError extends Error {
  /**
   * The operation queue slot this async context holds was requested again.
   * @returns The error to throw instead of queueing behind the caller itself.
   */
  public static forQueue(): ReentrantOperationError {
    return new ReentrantOperationError(
      'Re-entrant call: this async context already holds the slot of the operation queue it would wait on, so it ' +
        'would wait for itself. Run the nested work directly inside the holding callback (database work through ' +
        'its transaction context) instead of queueing it again.',
    );
  }

  /**
   * The handle this async context holds exclusively was requested exclusively again.
   * @returns The error to throw instead of waiting for the caller itself.
   */
  public static forHandle(): ReentrantOperationError {
    return new ReentrantOperationError(
      'Re-entrant call: this async context already holds the database handle exclusively (inside a transaction ' +
        'callback or a raw session), so opening another transaction, session or queued operation on it would ' +
        'wait for itself. Issue the nested statements directly (through the transaction context inside a ' +
        'transaction), or start the transaction or session outside the holding callback.',
    );
  }

  private constructor(message: string) {
    super(message);
    this.name = 'ReentrantOperationError';
  }
}
