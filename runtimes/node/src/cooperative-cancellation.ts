import { BusAbortError, isRequestCancellation } from '@makaio/bus-core';

/**
 * Recognize local cancellation without hiding a concurrent, unrelated failure.
 * @param error - Exception raised by the local operation.
 * @param signal - Cancellation signal supplied to that operation.
 * @returns Whether the exception represents cooperative cancellation.
 */
export function isCooperativeCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  // Bus wrappers retain provenance; the local DOM convention must not accept a foreign cause.
  if (error instanceof BusAbortError) return isRequestCancellation(error, signal);
  if (signal?.aborted !== true) return false;
  if (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError')) return true;
  // Node filesystem and timer APIs wrap the supplied reason rather than throwing it directly.
  return (
    error instanceof Error &&
    error.name === 'AbortError' &&
    'code' in error &&
    error.code === 'ABORT_ERR' &&
    Object.is(error.cause, signal.reason)
  );
}
