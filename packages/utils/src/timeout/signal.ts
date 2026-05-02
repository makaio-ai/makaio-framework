/**
 * An AbortSignal paired with a cleanup handle for its backing timer.
 */
export interface TimeoutSignal {
  /** AbortSignal that aborts when the timeout elapses. */
  signal: AbortSignal;
  /** Cancel the backing timer before it fires, preventing the abort. */
  clear: () => void;
}

/**
 * Create an `AbortSignal` that aborts after `timeoutMs` milliseconds.
 *
 * Always call {@link TimeoutSignal.clear} in a `finally` block to prevent
 * the timer from leaking when the guarded operation completes before the
 * timeout elapses.
 * @param timeoutMs - Timeout duration in milliseconds.
 * @returns A {@link TimeoutSignal} containing the signal and a `clear` callback.
 * @example
 * ```typescript
 * const timeout = createTimeoutSignal(5_000);
 * try {
 *   const response = await fetch(url, { signal: timeout.signal });
 * } finally {
 *   timeout.clear();
 * }
 * ```
 */
export function createTimeoutSignal(timeoutMs: number): TimeoutSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}
