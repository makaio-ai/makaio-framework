/**
 * Lightweight deferred promise pair.
 *
 * Encapsulates a Promise together with its `resolve` and `reject` callbacks so
 * they can be called from outside the Promise constructor body without relying
 * on definite-assignment assertions.
 * @typeParam T - The resolved value type.
 */
export interface Deferred<T> {
  /** The underlying promise. */
  readonly promise: Promise<T>;
  /** Resolve the promise with `value`. */
  readonly resolve: (value: T) => void;
  /** Reject the promise with `reason`. */
  readonly reject: (reason: string) => void;
}

/**
 * Create a {@link Deferred} promise pair.
 * @typeParam T - The resolved value type.
 * @returns A deferred promise with external resolve/reject handles.
 */
export function buildDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: string) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
