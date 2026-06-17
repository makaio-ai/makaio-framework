import type { Deferred } from './deferred.js';

/** Settled result from racing a deferred response against timeout and cancellation. */
export type DeferredRaceResult<T> =
  | { readonly status: 'resolved'; readonly value: T }
  | { readonly status: 'timed-out' }
  | { readonly status: 'cancelled' };

/**
 * Race a deferred response against timeout and abort signals.
 * @param deferred - Deferred response promise.
 * @param pending - Mutable at-most-once flag shared with response handlers.
 * @param signal - Cancellation signal for the execution.
 * @param timeoutMs - Optional timeout in milliseconds (`null` disables timeout).
 * @returns Settled race result.
 */
export async function raceDeferredResponse<T>(
  deferred: Deferred<T>,
  pending: { value: boolean },
  signal: AbortSignal,
  timeoutMs: number | null,
): Promise<DeferredRaceResult<T>> {
  const abortHandler = (): void => {
    if (!pending.value) return;
    pending.value = false;
    deferred.reject('cancelled');
  };
  signal.addEventListener('abort', abortHandler, { once: true });
  if (signal.aborted) abortHandler();

  const racePromises: Promise<T>[] = [deferred.promise];
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== null) {
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        if (!pending.value) return;
        pending.value = false;
        signal.removeEventListener('abort', abortHandler);
        reject('timed-out');
      }, timeoutMs);
    });
    racePromises.push(timeoutPromise);
  }

  try {
    const value = await Promise.race(racePromises);
    return { status: 'resolved', value };
  } catch (error) {
    return error === 'timed-out' ? { status: 'timed-out' } : { status: 'cancelled' };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', abortHandler);
  }
}
