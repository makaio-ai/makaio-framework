import pTimeout from 'p-timeout';

/**
 * Normalize unknown abort reasons to an Error for consistent throwing.
 * @param reason - AbortSignal reason
 * @returns Error instance representing abort reason
 */
export function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === 'string') {
    return new Error(reason);
  }
  return new Error('Request aborted');
}

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
  if (timeout !== 0) {
    return pTimeout(operation, { milliseconds: timeout, signal });
  }

  if (!signal) {
    return operation;
  }

  if (signal.aborted) {
    throw toAbortError(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
