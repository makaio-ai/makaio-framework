/**
 * Lightweight deferred promise pair.
 *
 * Encapsulates a Promise together with its `resolve` and `reject` callbacks so
 * they can be called from outside the Promise constructor body without relying
 * on definite-assignment assertions.
 * @typeParam T - The resolved value type.
 * @typeParam R - The rejection reason type (defaults to `string | Error`).
 */
export interface Deferred<T, R = string | Error> {
  /** The underlying promise. */
  readonly promise: Promise<T>;
  /** Resolve the promise with `value`. */
  readonly resolve: (value: T) => void;
  /** Reject the promise with `reason`. */
  readonly reject: (reason: R) => void;
}

/**
 * Create a {@link Deferred} promise pair.
 * @typeParam T - The resolved value type.
 * @typeParam R - The rejection reason type (defaults to `string | Error`).
 * @returns A deferred promise with external resolve/reject handles.
 */
export function buildDeferred<T, R = string | Error>(): Deferred<T, R> {
  let resolve!: (value: T) => void;
  let reject!: (reason: R) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej as (reason: R) => void;
  });
  return { promise, resolve, reject };
}
