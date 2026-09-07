import pTimeout from 'p-timeout';
import { toAbortError } from '../../errors/index.js';

/**
 * Await an operation with timeout and optional AbortSignal support.
 *
 * Special case: when `timeout` is `0`, timeout enforcement is disabled, but
 * `signal` cancellation still applies if provided.
 * @param operation - Operation promise to await
 * @param timeout - Timeout in milliseconds; `0` disables automatic timeout
 * @param signal - Optional AbortSignal for cancellation
 * @returns The resolved operation value
 */
export async function awaitWithTimeoutAndSignal<T>(
  operation: Promise<T>,
  timeout: number,
  signal?: AbortSignal,
): Promise<T> {
  let removeAbortListener: (() => void) | undefined;
  const cancellable = signal
    ? new Promise<T>((resolve, reject) => {
        // Observe the operation even when already aborted or when cancellation wins.
        operation.then(resolve, reject);
        const onAbort = (): void => reject(toAbortError(signal.reason));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      })
    : operation;

  // Invalid timeout options can reject before p-timeout observes this promise.
  void cancellable.catch(() => undefined);

  try {
    // p-timeout owns deadlines only; cancellation has one representation in every mode.
    return timeout === 0 ? await cancellable : await pTimeout(cancellable, { milliseconds: timeout });
  } finally {
    removeAbortListener?.();
  }
}
