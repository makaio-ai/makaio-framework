/**
 * Reconnection utilities for `WebSocketClientTransport`.
 *
 * Pure helpers for exponential-backoff timing used by the reconnect loop
 * inside `WebSocketClientTransport`. Kept separate so the main transport
 * module stays focused on the `BusTransport` contract.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reconnection configuration for `WebSocketClientTransport`.
 *
 * Controls exponential-backoff timing. Pass `false` to the parent options to
 * disable automatic reconnection entirely.
 */
export interface WebSocketClientTransportReconnectOptions {
  /**
   * Base delay in milliseconds for the first reconnect attempt.
   * The effective minimum is 100 ms regardless of the value specified.
   * @defaultValue 1000
   */
  baseMs?: number;
  /**
   * Maximum delay cap in milliseconds.
   * @defaultValue 10000
   */
  maxMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default reconnect configuration applied when `autoReconnect` is not `false`
 * and no explicit values are supplied.
 */
export const DEFAULT_AUTO_RECONNECT: Required<WebSocketClientTransportReconnectOptions> = {
  baseMs: 1000,
  maxMs: 10_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute an exponential-backoff delay.
 *
 * The effective minimum delay is 100 ms regardless of `baseMs`.
 * @param attempt - Zero-based attempt counter
 * @param baseMs - Base delay in milliseconds
 * @param maxMs - Maximum delay cap in milliseconds
 * @returns Delay in milliseconds
 */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const base = Math.max(baseMs, 100);
  const max = Math.max(maxMs, base);
  return Math.min(base * Math.pow(2, attempt), max);
}

/**
 * Sleep for `ms` milliseconds, resolving early when `signal` aborts.
 * @param ms - Duration to sleep
 * @param signal - AbortSignal that cancels the sleep
 * @returns Promise that resolves when the sleep completes or the signal fires
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}
