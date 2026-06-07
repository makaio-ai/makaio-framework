/**
 * Create an AbortSignal that aborts when either input signal aborts.
 * @param outer - The execution-level abort signal.
 * @param inner - The node-local abort signal.
 * @returns A combined signal that aborts on the first trigger.
 */
export function linkSignals(outer: AbortSignal, inner: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([outer, inner]);
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  outer.addEventListener('abort', abort, { once: true });
  inner.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
