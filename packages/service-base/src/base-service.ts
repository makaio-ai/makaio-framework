import type { IMakaioBus, OnOptions } from '@makaio/bus-core';
import type { SubjectDefinition, HandlerForSubjectDefinition } from '@makaio/core';
import { getErrorString } from '@makaio/utils';

/**
 * Abstract base class for Makaio bus services.
 *
 * Owns the init/destroy lifecycle boilerplate — idempotency guards,
 * cleanup array, and handler teardown — so concrete services only
 * implement `onInit()` and optionally `onDestroy()`.
 *
 * Usage pattern:
 * ```typescript
 * class MyService extends BaseService {
 *   constructor(bus: IMakaioBus) { super(bus); }
 *
 *   protected async onInit(): Promise<void> {
 *     this.registerHandler(MySubjects.foo, (ctx) => { ... });
 *     this.addCleanup(() => someExternalResource.close());
 *   }
 *
 *   protected async onDestroy(): Promise<void> {
 *     // Only needed for cleanup beyond handler unsubscription
 *   }
 * }
 * ```
 *
 * `destroy()` reports an unclean teardown by rejecting, so every call site must
 * await it or attach an explicit handler. Under Node's default
 * `--unhandled-rejections=throw` an un-awaited rejection terminates the process
 * or worker thread, so a fire-and-forget `destroy()` is not a logged warning but
 * a crash.
 *
 * Repeated callers share the one teardown, and therefore its rejection: a
 * teardown that failed stays failed, and a caller that retries it is told so
 * rather than being told the service drained cleanly. `init()` inherits that
 * rejection, so a service that could not release its resources deliberately
 * cannot be rebuilt on top of them.
 */
export abstract class BaseService {
  private readonly _cleanups: Array<() => void | Promise<void>> = [];
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _destroyPromise: Promise<void> | null = null;

  /**
   * @param bus - Bus instance used for registering handlers
   */
  protected constructor(protected readonly bus: IMakaioBus) {}

  /**
   * Whether the service has been successfully initialized.
   *
   * Returns `true` after `init()` completes and before `destroy()` is called.
   * @returns `true` if initialized, `false` otherwise
   */
  public get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Initialize the service.
   *
   * Delegates to `onInit()` once; subsequent calls are no-ops (idempotent).
   *
   * A call made after a teardown started waits for it, and inherits its
   * failure: re-initializing over a service that could not release its
   * resources would build a second lifecycle on top of the first. Because a
   * failed teardown is retained rather than forgotten, that inheritance is
   * permanent — deliberately, since nothing afterwards proves the resources it
   * leaked were ever released.
   * @returns Promise that resolves when initialization is complete
   * @throws The `onInit()` failure, or the failure of a preceding teardown
   */
  public async init(): Promise<void> {
    if (this._destroyPromise) {
      await this._destroyPromise;
    }
    if (this._initialized) return;
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      try {
        await this.onInit();
        this._initialized = true;
      } catch (error) {
        // The initialization failure is what the caller asked about, so the
        // secondary failures of unwinding a half-built service are reported
        // rather than substituted for it.
        for (const cleanupError of await this.runCleanups()) this.logCleanupError(cleanupError);
        this._cleanups.length = 0;
        throw error;
      } finally {
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  /**
   * Destroy the service and unsubscribe all registered handlers.
   *
   * Calls the optional `onDestroy()` hook before running cleanups, then
   * resets the initialized flag. Safe to call multiple times (idempotent).
   *
   * Teardown is best-effort but never silent: a failing `onDestroy()` does not
   * skip cleanups, and a failing cleanup does not skip the ones after it. Once
   * everything has been attempted, all collected failures are rejected together
   * as a single `AggregateError`. Callers that own the process lifecycle must
   * treat that rejection as an unclean shutdown rather than a completed one.
   *
   * Repeated callers share the one teardown, and therefore its rejection. Only a
   * clean teardown is forgotten, so a service that was destroyed and initialized
   * again can be destroyed again; a failed one keeps rejecting every later
   * caller, including {@link BaseService.init}.
   * @returns Promise that resolves after teardown completes
   * @throws An AggregateError when `onDestroy()` or any cleanup failed
   */
  public async destroy(): Promise<void> {
    if (this._destroyPromise) {
      return this._destroyPromise;
    }
    this._destroyPromise = (async () => {
      if (this._initPromise) {
        try {
          await this._initPromise;
        } catch {
          return;
        }
      }
      if (!this._initialized) return;

      this._initialized = false;

      const failures: unknown[] = [];
      try {
        await this.onDestroy?.();
      } catch (destroyError) {
        failures.push(destroyError);
      }

      failures.push(...(await this.runCleanups()));
      this._cleanups.length = 0;

      if (failures.length > 0) {
        // The member messages are inlined because the aggregate is what a host
        // logs and what a coordinator records against an extension entry;
        // without them both would report only that teardown failed.
        const detail = failures.map((failure) => getErrorString(failure)).join('; ');
        throw new AggregateError(failures, `Service '${this.constructor.name}' failed to tear down cleanly: ${detail}`);
      }
    })();

    await this._destroyPromise;
    // Reached only by a clean teardown: the await above rethrows a failed one
    // and leaves it in place, so every later caller — `init()` included — shares
    // the rejection instead of being told the service drained cleanly. A clean
    // teardown is forgotten so a re-initialized service can be destroyed again.
    this._destroyPromise = null;
  }

  /**
   * Register a bus handler and enqueue its unsubscribe function for teardown.
   *
   * Equivalent to `this._cleanups.push(this.bus.on(subject, handler, options))`.
   * @param subject - The subject definition to listen on
   * @param handler - Handler function for the subject
   * @param options - Optional handler filter and dispatch priority
   */
  protected registerHandler<S extends SubjectDefinition>(
    subject: S,
    handler: HandlerForSubjectDefinition<S>,
    options?: OnOptions,
  ): void {
    // Both casts are required: TypeScript cannot narrow IsChannel or
    // IsRequest on unresolved generic Subject. Channel-only guards are
    // enforced at the public bus API boundary where concrete subject
    // types are known; BaseService delegates through the typed interface.
    this._cleanups.push(this.bus.on(subject as never, handler as never, options));
  }

  /**
   * Enqueue an arbitrary cleanup function to be called on `destroy()`.
   *
   * Use for non-handler resources (timers, external subscriptions, etc.).
   * @param fn - Function to invoke during teardown
   */
  protected addCleanup(fn: () => void | Promise<void>): void {
    this._cleanups.push(fn);
  }

  /**
   * Service initialization hook.
   *
   * Called once by `init()`. Register bus handlers via `registerHandler()`
   * and other cleanup resources via `addCleanup()` here.
   * @returns Promise or void — async is allowed
   */
  protected abstract onInit(): Promise<void> | void;

  /**
   * Optional service teardown hook.
   *
   * Called by `destroy()` before automatic handler unsubscription.
   * Implement only when there are resources beyond bus handlers to clean up
   * (e.g., stopping trackers, clearing maps, releasing external handles).
   *
   * Throwing here does not cancel cleanup: registered cleanups still run, and
   * the failure is aggregated with theirs into the rejection `destroy()`
   * produces. Only throw for teardown a caller must treat as unclean.
   */
  protected onDestroy?(): void | Promise<void>;

  /**
   * Run every registered cleanup, collecting rather than raising failures.
   *
   * A cleanup that throws must not prevent the ones registered after it from
   * running, so failures are returned to the caller, which decides whether to
   * report or aggregate them.
   * @returns Failures thrown by cleanups, in registration order
   */
  private async runCleanups(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const fn of this._cleanups) {
      try {
        await fn();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    return failures;
  }

  /**
   * Report a cleanup failure observed while unwinding a failed initialization.
   * @param cleanupError - Failure thrown by a cleanup during unwinding
   */
  private logCleanupError(cleanupError: unknown): void {
    const serviceWithLogger = this as { logger?: { error: (message: unknown, error?: unknown) => void } };
    if (serviceWithLogger.logger?.error) {
      serviceWithLogger.logger.error('Cleanup failed while unwinding a failed initialization', cleanupError);
      return;
    }
    console.error('Cleanup failed while unwinding a failed initialization', cleanupError);
  }
}
