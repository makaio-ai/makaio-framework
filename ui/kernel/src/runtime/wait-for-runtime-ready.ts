/**
 * Runtime boot readiness waiter for browser surfaces.
 *
 * Provides {@link createRuntimeReadyWaiter}, which synchronises a browser
 * surface with the Makaio runtime boot sequence before attempting to load
 * extension bundles.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { KernelSubjects } from '@makaio/kernel';

/**
 * Result produced when the runtime readiness promise settles.
 *
 * - `'ready'`     — runtime booted successfully
 * - `'cancelled'` — waiter was cleaned up before readiness (e.g. React unmount)
 * - `'timeout'`   — runtime did not become ready within the allowed window
 */
export type RuntimeReadyWaitResult = 'ready' | 'cancelled' | 'timeout';

/**
 * Readiness waiter handle for runtime boot synchronisation.
 */
export interface RuntimeReadyWaiter {
  /**
   * Cancel the waiter and resolve the `ready` promise with `'cancelled'`.
   *
   * Idempotent — safe to call multiple times.
   */
  cleanup: () => void;

  /**
   * Promise that resolves when the runtime is ready, the waiter is cancelled,
   * or the timeout window expires.
   *
   * Resolves with `'ready'`, `'cancelled'`, or `'timeout'`. May reject if the
   * readiness probe itself fails (e.g. transport error) — callers should
   * wrap in try/catch.
   */
  ready: Promise<RuntimeReadyWaitResult>;
}

/** Default timeout for the runtime readiness wait (ms). */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * Wait for the Makaio runtime to finish booting.
 *
 * Subscribes to `kernel.ready` before probing `kernel.isReady` so callers do
 * not miss the one-shot event while the RPC is in flight.  When the readiness
 * RPC is unavailable, this falls back to the event path for pre-boot callers.
 *
 * A timeout ensures the waiter never hangs indefinitely — if the runtime does
 * not become ready within `timeoutMs`, the promise resolves with `'timeout'`
 * so the caller can show an error UI instead of spinning forever.
 *
 * Cleanup is idempotent — `bus.on()` returns an unsubscribe function that is
 * safe to call multiple times.  Both the event handler and the RPC success path
 * call `cleanup()`, and the consumer may call it again on unmount; all three
 * are no-ops after the first invocation.
 * @param bus - Bus used for readiness queries and subscriptions.
 * @param timeoutMs - Maximum wait before resolving `'timeout'`. Defaults to 30 s.
 * @returns Cleanup for the ready listener and a promise that resolves at readiness.
 */
export function createRuntimeReadyWaiter(bus: IMakaioBus, timeoutMs = DEFAULT_READY_TIMEOUT_MS): RuntimeReadyWaiter {
  let settled = false;
  let resolveReady!: (result: RuntimeReadyWaitResult) => void;
  let rejectReady!: (error: Error) => void;
  let unsubscribe = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const readyPromise = new Promise<RuntimeReadyWaitResult>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = (error) => reject(error);
  });

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const settleReady = (): void => {
    if (settled) return;
    settled = true;
    clearTimer();
    unsubscribe();
    resolveReady('ready');
  };

  const cancelReady = (): void => {
    if (settled) return;
    settled = true;
    clearTimer();
    unsubscribe();
    resolveReady('cancelled');
  };

  const timeoutReady = (): void => {
    if (settled) return;
    settled = true;
    clearTimer();
    unsubscribe();
    resolveReady('timeout');
  };

  const failReady = (error: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimer();
    unsubscribe();
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  };

  // Arm timeout before subscribing — guarantees every path terminates.
  if (timeoutMs > 0) {
    timer = setTimeout(timeoutReady, timeoutMs);
  }

  unsubscribe = bus.on(KernelSubjects.ready, () => {
    settleReady();
  });

  void (async () => {
    try {
      const result = await bus.requestOptional(KernelSubjects.isReady, {});
      if (settled) return;

      if (result.handled && result.data.ready) {
        settleReady();
      }
    } catch (err) {
      // requestOptional already absorbs NoHandlerError (returns handled:false).
      // Any error reaching here is a transport/timeout failure, not "kernel
      // not booted yet". Waiting for a one-shot event after that can hang
      // forever if kernel.ready already fired before this waiter mounted.
      failReady(new Error('[waitForRuntimeReady] Readiness probe failed', { cause: err }));
    }
  })();

  return { cleanup: cancelReady, ready: readyPromise };
}
