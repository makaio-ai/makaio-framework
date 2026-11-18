/**
 * How a cancelled operation reports the cleanup it could not finish.
 *
 * A cancellation says nothing but "stop", so an operation that was cancelled
 * rejects with the signal's reason, and the caller that owns process termination
 * treats exactly that as a clean stop. When the cleanup the cancellation set off
 * failed, the failure must not disappear behind the reason: the operation rejects
 * with an `AggregateError` instead, whose `errors` are the cleanup failures and
 * whose `cause` is the reason. Everything that classifies a cancellation reads
 * it through these functions, so the shape has one definition.
 * @packageDocumentation
 */

/**
 * The rejection of a cancelled operation.
 * @param reason - Why the operation was cancelled (`signal.reason`).
 * @param cleanupFailures - What failed while cleaning up; may be empty.
 * @param message - Message of the aggregate used when there are cleanup failures.
 * @returns `reason` itself when the cleanup was clean, otherwise an `AggregateError` of the failures caused by it.
 */
export function cancellationRejection(reason: unknown, cleanupFailures: readonly unknown[], message: string): unknown {
  if (cleanupFailures.length === 0) return reason;
  return new AggregateError(cleanupFailures, message, { cause: reason });
}

/**
 * Read a rejection as the cancellation a signal asked for.
 * @param error - What an operation rejected with.
 * @param signal - The signal the operation was given.
 * @returns `undefined` when `error` is not the cancellation the signal asked for, otherwise the cleanup failures it carries (none for the bare reason).
 */
export function readCancellation(error: unknown, signal: AbortSignal | undefined): readonly unknown[] | undefined {
  if (signal?.aborted !== true) return undefined;
  if (error === signal.reason) return [];
  if (error instanceof AggregateError && error.cause === signal.reason) return error.errors;
  return undefined;
}
