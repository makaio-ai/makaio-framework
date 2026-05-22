import type { IMakaioBus } from '@makaio/bus-core';
import type { SubjectDefinition, HandlerForSubjectDefinition } from '@makaio/core';

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
 * `destroy()` is awaitable for services with async teardown, while remaining
 * safe to call without awaiting from synchronous call sites.
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
   * @returns Promise that resolves when initialization is complete
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
        await this.runCleanups();
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
   * @returns Promise that resolves after teardown completes
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

      try {
        await this.onDestroy?.();
      } catch (cleanupError) {
        this.logCleanupError(cleanupError);
      }

      await this.runCleanups();
      this._cleanups.length = 0;
    })();

    try {
      await this._destroyPromise;
    } finally {
      this._destroyPromise = null;
    }
  }

  /**
   * Register a bus handler and enqueue its unsubscribe function for teardown.
   *
   * Equivalent to `this._cleanups.push(this.bus.on(subject, handler))`.
   * @param subject - The subject definition to listen on
   * @param handler - Handler function for the subject
   */
  protected registerHandler<S extends SubjectDefinition>(subject: S, handler: HandlerForSubjectDefinition<S>): void {
    // Both casts are required: TypeScript cannot narrow IsChannel or
    // IsRequest on unresolved generic Subject. Channel-only guards are
    // enforced at the public bus API boundary where concrete subject
    // types are known; BaseService delegates through the typed interface.
    this._cleanups.push(this.bus.on(subject as never, handler as never));
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
   */
  protected onDestroy?(): void | Promise<void>;

  private async runCleanups(): Promise<void> {
    for (const fn of this._cleanups) {
      try {
        await fn();
      } catch (cleanupError) {
        this.logCleanupError(cleanupError);
      }
    }
  }

  private logCleanupError(cleanupError: unknown): void {
    const serviceWithLogger = this as { logger?: { error: (message: unknown, error?: unknown) => void } };
    if (serviceWithLogger.logger?.error) {
      serviceWithLogger.logger.error('Cleanup failed during service lifecycle', cleanupError);
      return;
    }
    console.error('Cleanup failed during service lifecycle', cleanupError);
  }
}
