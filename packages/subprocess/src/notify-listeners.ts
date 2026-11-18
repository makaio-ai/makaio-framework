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
