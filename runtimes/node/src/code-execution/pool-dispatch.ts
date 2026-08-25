/** Result of dispatching one task to the worker pool. */
export type PoolDispatchResult =
  | { readonly kind: 'completed'; readonly value: unknown; readonly teardown?: Promise<void> }
  | { readonly kind: 'aborted'; readonly teardown?: Promise<void> }
  | { readonly kind: 'failed'; readonly error: unknown; readonly teardown?: Promise<void> };

/**
 * Recognize the rejection a worker pool produces for an aborted run.
 * @param error - Rejection returned by Piscina.
 * @returns Whether the rejection represents cancellation.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Recognize Piscina's own rejection while it terminates a worker thread.
 * @param error - Rejection returned by Piscina.
 * @returns Whether the rejection was caused by pool teardown.
 */
export function isPoolTeardownError(error: unknown): boolean {
  return isAbortError(error) || (error instanceof Error && error.message === 'Terminating worker thread');
}
