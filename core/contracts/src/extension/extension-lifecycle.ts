import type { ExtensionWarning } from './extension-warning.js';

declare const extensionIdentityBrand: unique symbol;

/**
 * Opaque extension identity minted by the runtime coordinator.
 *
 * This identity proves which loaded extension is calling runtime-owned seams
 * such as future direct channels. Extension code receives it through
 * {@link ExtensionContext.identity}; external callers cannot construct one
 * without a type assertion.
 */
export interface ExtensionIdentity {
  /** Extension name associated with this identity. */
  readonly extensionName: string;
  /** Opaque brand preventing structural construction. */
  readonly [extensionIdentityBrand]: true;
}

/** Options the host passes to {@link ExtensionServiceLifecycle.init}. */
export interface ExtensionInitOptions {
  /**
   * Aborted when the host cancels the start (a stop request that arrives while
   * extensions are still starting). A service whose `init()` waits for something
   * outside the process (a child process's readiness, a peer's reply) should end
   * that wait when the signal aborts and release what it has started, so that
   * the host's shutdown is not held up by the remainder of the wait. A service
   * that ignores it keeps the host waiting for the `init()` to settle.
   */
  readonly signal?: AbortSignal;
}

/**
 * Minimal lifecycle shape accepted as an extension service.
 *
 * BaseService satisfies this interface, but plain service classes can also
 * participate in extension startup when they expose the same lifecycle.
 */
export interface ExtensionServiceLifecycle {
  /**
   * Initialize the service when startup work is not constructor-owned.
   *
   * Messages sent from here use the context from `ctx.bus.own('start')`.
   * @param options - What the host offers the start; see {@link ExtensionInitOptions}.
   */
  init?(options?: ExtensionInitOptions): Promise<void> | void;
  /**
   * Destroy the service and release resources when teardown is required.
   *
   * Messages sent from here use the context from `ctx.bus.own('stop')`.
   */
  destroy?(): Promise<void> | void;
  /**
   * Longest time, in milliseconds, the host should wait for this extension to
   * stop: the whole of its teardown (its contributions' stop, {@link destroy}
   * and the release of its storage handlers) counts against this one window.
   *
   * Declare it when the service owns work that legitimately takes longer than
   * the host's default window, such as several child processes that are stopped
   * one after the other, and derive it from the limits the service enforces
   * itself. When the window closes first (the host adds a little scheduling
   * headroom to the declared value, so a stop that uses all of it is not cut
   * off), the host reports the extension as not stopped by name and goes on with
   * the next one, so a stuck extension cannot consume the time of the others.
   * Omitted, the host's default window applies, which is one bounded stop of one
   * child process. Must be a non-negative finite number: a service declaring
   * anything else fails its start.
   */
  readonly stopBudgetMs?: number;
  /**
   * Called after the extension reaches active state.
   *
   * Returns zero or more {@link ExtensionWarning} entries describing integration
   * health issues the user may want to act on. An empty array (or omitting the
   * hook entirely) signals that the extension is fully healthy.
   * The hook runs inside a host lifecycle step whose context cannot cross to
   * the extension's carrier. Implementations that send messages mint
   * `own('observer')` on their own bus.
   * @returns Active health warnings, or an empty array when the extension is healthy.
   */
  checkHealth?(): Promise<ExtensionWarning[]> | ExtensionWarning[];
}

/**
 * Service shape returned by {@link MakaioExtension.create}.
 *
 * Any class that extends `BaseService` satisfies this interface structurally
 * because `BaseService` exposes the same lifecycle methods.
 */
export type ExtensionService = ExtensionServiceLifecycle;
