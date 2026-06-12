/**
 * Shared teardown error handling for the dialect configs.
 *
 * Both dialect configs implement the `StorageDatabaseContext.cleanup()` contract
 * with the same collect-then-rethrow shape: every resource the context owns
 * gets a release attempt, failures are collected instead of aborting teardown,
 * and the collected failures surface loudly once teardown has reached the end.
 * @packageDocumentation
 */

/**
 * Append the rejection reasons of settled promises to a failure collection.
 * @param failures - Failure collection to append to.
 * @param results - Settlement results from `Promise.allSettled`.
 */
export function collectRejections(failures: unknown[], results: readonly PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
}

/**
 * Rethrow failures collected during a cleanup pass.
 *
 * A single failure is rethrown as-is (wrapped only when it is not an Error),
 * several failures are wrapped in an `AggregateError` so none of them is
 * silently dropped. No-op when the collection is empty.
 * @param failures - Rejection reasons collected during cleanup.
 * @param message - Message for the `AggregateError` wrapping multiple failures.
 */
export function rethrowCleanupFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 0) {
    return;
  }
  if (failures.length === 1) {
    const failure = failures[0];
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  throw new AggregateError(failures, message);
}
