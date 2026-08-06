/**
 * A FIFO lane that runs queued operations one at a time.
 *
 * The shape solves one recurring problem: a state transition that has to read,
 * mutate, publish, and possibly roll back must not interleave with another
 * transition derived from the same pre-state. Chaining every operation onto a
 * single tail makes each one atomic with respect to the others, in submission
 * order.
 *
 * Two properties are load-bearing and are the reason this exists as a shared
 * primitive rather than as a hand-rolled `Promise` field per call site:
 *
 * 1. **The stored tail never rejects.** A failed operation surfaces only to its
 *    own caller; the lane keeps draining. A rejected tail would otherwise cancel
 *    every operation queued behind the failure.
 * 2. **Submission order is run order.** `run` chains onto the tail synchronously,
 *    so two callers that submit in the same turn of the event loop run in the
 *    order they submitted.
 *
 * Operations must not await work that can only complete by re-entering the lane —
 * that is a self-deadlock the lane cannot detect. Owners of a lane typically keep
 * extension-owned promises outside it for exactly that reason.
 * @example
 * ```typescript
 * private readonly lane = new SerialLane();
 *
 * public mutate(): Promise<void> {
 *   return this.lane.run(async () => {
 *     const snapshot = this.state;
 *     this.state = next(snapshot);
 *     try {
 *       await this.publish();
 *     } catch (error) {
 *       this.state = snapshot;
 *       throw error;
 *     }
 *   });
 * }
 * ```
 */
export class SerialLane {
  /**
   * Tail of the lane.
   *
   * Always settled-or-pending and never rejected — see the class contract.
   */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Runs one operation after every operation submitted earlier has settled.
   * @typeParam TResult - Value produced by the operation.
   * @param operation - Operation to run once the lane drains.
   * @returns The operation's result; rejects with the operation's own failure.
   */
  public run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
