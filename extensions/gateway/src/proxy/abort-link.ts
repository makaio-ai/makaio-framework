/**
 * Composition of the per-request client abort signal with the long-lived
 * runtime shutdown signal.
 *
 * An upstream `fetch` must be cancelled when *either* the client disconnects or
 * the runtime begins shutting down; otherwise a graceful shutdown blocks behind
 * in-flight upstream requests that nobody is waiting for any more.
 *
 * **Why not `AbortSignal.any`:** composing against a signal that lives as long
 * as the process permanently retains one dependant-signal registration per call
 * on that source, and the registrations are only released when the source
 * itself aborts. On a gateway that is one leaked registration per proxied
 * request. {@link linkAbortSignals} instead uses ordinary listeners that the
 * caller releases when the request settles.
 * @packageDocumentation
 */

/** A short-lived composed signal together with its listener-release handle. */
export interface LinkedAbortSignal {
  /** Signal that aborts when either source signal aborts. */
  readonly signal: AbortSignal;
  /**
   * Detach both listeners.
   *
   * Must be called exactly once, when the request settles, so no registration
   * outlives the request on the long-lived shutdown signal. Safe to call after
   * the composed signal has already aborted.
   */
  readonly release: () => void;
}

/**
 * Compose a per-request client signal and a long-lived shutdown signal into one
 * releasable abort signal.
 *
 * If either source has already aborted, the returned signal is aborted before
 * it is handed back, so a caller that links after shutdown began never starts
 * an upstream request.
 * @param clientSignal - Abort signal of the incoming client request.
 * @param shutdownSignal - Runtime shutdown signal, alive for the whole process.
 * @returns The composed signal plus a `release` handle for the caller's
 *   `finally` block.
 */
export function linkAbortSignals(clientSignal: AbortSignal, shutdownSignal: AbortSignal): LinkedAbortSignal {
  const controller = new AbortController();

  const onClientAbort = (): void => controller.abort(clientSignal.reason);
  const onShutdownAbort = (): void => controller.abort(shutdownSignal.reason);

  const release = (): void => {
    clientSignal.removeEventListener('abort', onClientAbort);
    shutdownSignal.removeEventListener('abort', onShutdownAbort);
  };

  if (clientSignal.aborted) {
    controller.abort(clientSignal.reason);
    return { signal: controller.signal, release };
  }
  if (shutdownSignal.aborted) {
    controller.abort(shutdownSignal.reason);
    return { signal: controller.signal, release };
  }

  clientSignal.addEventListener('abort', onClientAbort, { once: true });
  shutdownSignal.addEventListener('abort', onShutdownAbort, { once: true });

  return { signal: controller.signal, release };
}
