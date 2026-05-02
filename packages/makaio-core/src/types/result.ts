/**
 * Result types for optional request handling.
 *
 * Used by requestOptional to distinguish between "handler returned data"
 * and "no handler was registered".
 */

/**
 * Discriminated union for optional request results.
 *
 * - `handled: true` - A handler was found and returned data
 * - `handled: false` - No handler was registered for the subject
 * @example
 * ```typescript
 * const result = await bus.requestOptional(Subjects.getData, { id: '123' });
 * if (result.handled) {
 *   console.debug('Got data:', result.data);
 * } else {
 *   console.debug('No handler registered for getData');
 * }
 * ```
 */
export type OptionalResult<T> = { handled: true; data: T } | { handled: false };
