/**
 * One asynchronous operation that every concurrent caller joins instead of
 * starting again: a teardown, a lazy open, a single-flight fetch.
 *
 * The shared promise is published before `start` runs. That order is the
 * reason this exists as a shared primitive rather than as a `??=` at each call
 * site. The anti-pattern
 *
 * ```typescript
 * this.closing ??= (async () => { await step(); })();
 * ```
 *
 * stores the promise only once the async body has returned its first await,
 * and the body's synchronous prefix runs before that: a step, an abort
 * listener, an event handler or a bus observer that calls back into the same
 * operation from the prefix finds nothing to join and starts a second run.
 * Here the reservation comes first, so a re-entrant call joins the run that is
 * already under way.
 *
 * A caller inside the operation must not await the shared promise: it settles
 * only after the work that is awaiting it, which no join can detect.
 *
 * The promise is retained once it settles, rejections included, until
 * {@link JoinedOperation.forget} (or the `forget` handed to `start`) releases
 * it. Retaining a rejection is what makes "at most once" honest for work that
 * would only fail the same way again; an operation that should retry after a
 * failure forgets itself in its own `start`.
 * @example
 * ```typescript
 * private readonly disposal = new JoinedOperation<void>();
 *
 * public dispose(): Promise<void> {
 *   return this.disposal.join(() => this.destroyAndDrain());
 * }
 * ```
 */
export class JoinedOperation<T> {
  private shared: Promise<T> | undefined;

  /**
   * The run callers currently join.
   * @returns The shared promise, or `undefined` when no run is retained.
   */
  public get current(): Promise<T> | undefined {
    return this.shared;
  }

  /**
   * Join the retained run, or publish a new one and start it.
   *
   * `start` runs synchronously inside the first call, after the shared promise
   * is published. A synchronous throw rejects the shared promise instead of
   * escaping, so every caller sees the failure the same way.
   * @param start - Begins the work. Receives a `forget` bound to this run: it
   * releases the run only while the run is still the retained one, so a late
   * settlement cannot discard a newer run that replaced it.
   * @returns The shared promise.
   */
  public join(start: (forget: () => void) => PromiseLike<T> | T): Promise<T> {
    if (this.shared !== undefined) return this.shared;
    const deferred = Promise.withResolvers<T>();
    const run = deferred.promise;
    this.shared = run;
    const forget = (): void => {
      if (this.shared === run) this.shared = undefined;
    };
    try {
      Promise.resolve(start(forget)).then(deferred.resolve, deferred.reject);
    } catch (error) {
      deferred.reject(error);
    }
    return run;
  }

  /** Release the retained run so the next {@link join} starts a new one. */
  public forget(): void {
    this.shared = undefined;
  }
}
