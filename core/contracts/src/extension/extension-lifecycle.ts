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

/**
 * Minimal lifecycle shape accepted as an extension service.
 *
 * BaseService satisfies this interface, but plain service classes can also
 * participate in extension startup when they expose the same lifecycle.
 */
export interface ExtensionServiceLifecycle {
  /** Initialize the service when startup work is not constructor-owned. */
  init?(): Promise<void> | void;
  /** Destroy the service and release resources when teardown is required. */
  destroy?(): Promise<void> | void;
  /**
   * Called after the extension reaches active state.
   *
   * Returns zero or more {@link ExtensionWarning} entries describing integration
   * health issues the user may want to act on. An empty array (or omitting the
   * hook entirely) signals that the extension is fully healthy.
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
