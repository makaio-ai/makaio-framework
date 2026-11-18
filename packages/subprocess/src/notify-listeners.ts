/**
 * Invoke every listener registered when the dispatch starts, isolating each one.
 *
 * Dispatch iterates a snapshot of the set: a listener that unsubscribes, or that
 * closes the source and so clears the set, must not hide the value from the
 * listeners registered alongside it. A throwing listener is handed to
 * `onListenerError` and does not stop later listeners from running; listeners
 * typically run inside child-process event handlers, where an escaping
 * exception would become an uncaught exception.
 * @param listeners - Listeners to notify.
 * @param value - Value passed to each listener.
 * @param onListenerError - Receives whatever a listener threw.
 */
export function notifyListeners<T>(
  listeners: ReadonlySet<(value: T) => void>,
  value: T,
  onListenerError: (error: unknown) => void,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (error) {
      onListenerError(error);
    }
  }
}

/**
 * Invoke one observer of a lifecycle event, isolated like a listener.
 *
 * Observers such as `onDisconnected` are called from promise continuations and
 * stream handlers, where an escaping exception would become an unhandled
 * rejection or an uncaught exception that can terminate the host. The throw is
 * handed to `onObserverError` instead; an absent observer is a no-op.
 * @param observer - Observer to call, if any.
 * @param onObserverError - Receives whatever the observer threw.
 */
export function notifyObserver(observer: (() => void) | undefined, onObserverError: (error: unknown) => void): void {
  if (observer === undefined) return;
  notifyListeners(new Set([observer]), undefined, onObserverError);
}
