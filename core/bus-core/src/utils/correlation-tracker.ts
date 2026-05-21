/**
 * Correlation tracker for request-response matching.
 *
 * Manages pending requests with timeout handling and automatic cleanup.
 */

import { TimeoutError } from '../errors/index.js';

/**
 * Pending request metadata.
 */
interface PendingRequest {
  /**
   * Resolve function for the pending promise.
   */
  resolve: (result: unknown) => void;

  /**
   * Reject function for the pending promise.
   */
  reject: (error: Error) => void;

  /**
   * Timeout ID for automatic rejection.
   * `undefined` when `timeout === 0` (no automatic timeout).
   */
  timeoutId: NodeJS.Timeout | undefined;

  /**
   * Optional abort listener cleanup callback.
   */
  removeAbortListener?: () => void;
}

/**
 * Tracks correlation IDs for request-response matching.
 *
 * Provides automatic timeout handling and cleanup for pending requests.
 * @example
 * ```typescript
 * const tracker = new CorrelationTracker();
 *
 * // Track a request with 5 second timeout
 * const promise = tracker.track('correlation-123', 5000);
 *
 * // Later, resolve when response arrives
 * tracker.resolve('correlation-123', { data: 'result' });
 *
 * // Or reject on error
 * tracker.reject('correlation-123', new Error('Failed'));
 * ```
 */
export class CorrelationTracker {
  private pending: Map<string, PendingRequest>;

  private static readonly DEFAULT_ABORT_MESSAGE = 'Request aborted';

  /**
   * Create a new correlation tracker.
   */
  public constructor() {
    this.pending = new Map();
  }

  /**
   * Track a pending request.
   *
   * Returns a promise that resolves when the response arrives or rejects on timeout.
   * When `timeout` is `0`, no automatic timeout is set — the promise stays open
   * until `resolve()` or `reject()` is called externally (e.g. by the caller's
   * own `AbortSignal` or `pTimeout` wrapper).
   * @param correlationId - Correlation ID for the request
   * @param timeout - Timeout in milliseconds; `0` means no automatic timeout
   * @param signal - Optional AbortSignal to cancel and cleanup the pending entry
   * @returns Promise that resolves with the response result
   */
  public track(correlationId: string, timeout: number, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(this.getAbortError(signal));
        return;
      }

      // When timeout === 0, skip the timer entirely — the entry stays pending
      // until the caller resolves or rejects it (or cleanup() is called).
      const timeoutId =
        timeout === 0
          ? undefined
          : setTimeout(() => {
              const pending = this.pending.get(correlationId);
              if (pending === undefined) {
                return;
              }

              clearTimeout(pending.timeoutId);
              pending.removeAbortListener?.();
              this.pending.delete(correlationId);
              pending.reject(new TimeoutError(correlationId, timeout));
            }, timeout);

      // Store pending request first so abort handling can always find it.
      this.pending.set(correlationId, {
        resolve,
        reject,
        timeoutId,
        removeAbortListener: undefined,
      });

      if (signal) {
        const onAbort = (): void => {
          this.reject(correlationId, this.getAbortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        const removeAbortListener = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
        const pending = this.pending.get(correlationId);
        if (pending) {
          pending.removeAbortListener = removeAbortListener;
        }
      }

      // Handle abort that races between initial check, map insertion, and listener setup.
      if (signal?.aborted) {
        this.reject(correlationId, this.getAbortError(signal));
      }
    });
  }

  /**
   * Convert AbortSignal reasons into Error instances while preserving reason detail.
   * @param signal - Abort signal associated with the pending request.
   * @returns Normalized abort error preserving the original reason when available.
   */
  private getAbortError(signal: AbortSignal): Error {
    const { reason } = signal;

    if (reason instanceof Error) {
      return reason;
    }

    if (reason === undefined) {
      return new Error(CorrelationTracker.DEFAULT_ABORT_MESSAGE);
    }

    // AbortSignal.reason can be any value. Keep non-Error details in cause.
    const message = typeof reason === 'string' ? reason : CorrelationTracker.DEFAULT_ABORT_MESSAGE;
    return new Error(message, { cause: reason });
  }

  /**
   * Resolve a pending request.
   *
   * Clears the timeout and removes the request from tracking.
   * @param correlationId - Correlation ID for the request
   * @param result - Response result
   */
  public resolve(correlationId: string, result: unknown): void {
    const pending = this.pending.get(correlationId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    pending.removeAbortListener?.();
    this.pending.delete(correlationId);
    pending.resolve(result);
  }

  /**
   * Reject a pending request.
   *
   * Clears the timeout and removes the request from tracking.
   * @param correlationId - Correlation ID for the request
   * @param error - Error to reject with
   */
  public reject(correlationId: string, error: Error): void {
    const pending = this.pending.get(correlationId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    pending.removeAbortListener?.();
    this.pending.delete(correlationId);
    pending.reject(error);
  }

  /**
   * Cancel a pending request and remove its correlation entry.
   * @param correlationId - Correlation ID for the request
   * @param error - Optional cancellation error
   */
  public cancel(correlationId: string, error?: Error): void {
    this.reject(correlationId, error ?? new Error('Request aborted'));
  }

  /**
   * Clean up all pending requests.
   *
   * Clears all timeouts and rejects all pending requests with a disconnection error.
   */
  public cleanup(): void {
    for (const [_correlationId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.removeAbortListener?.();
      pending.reject(new Error('Transport disconnected'));
    }

    this.pending.clear();
  }
}
