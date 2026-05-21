/**
 * Typed extension service tokens.
 *
 * Extension tokens pair a runtime extension name with the service type the
 * extension exposes. Consumers import an extension-owned token instead of
 * repeating string literals at service lookup call sites.
 */

/**
 * Typed token for retrieving an extension service from an extension context.
 *
 * The type parameter is intentionally phantom: the runtime uses {@link name}
 * while TypeScript carries the expected service type through `getService`.
 * @typeParam T - Service type exposed by the extension.
 */
export interface ExtensionToken<T = unknown> {
  /** Extension name registered with the runtime coordinator. */
  readonly name: string;
  /** Phantom marker for the token's service type. */
  readonly __service?: T;
}

/**
 * Create a typed extension service token.
 * @param name - Extension name registered with the runtime coordinator.
 * @returns Frozen token carrying the extension name and service type.
 */
export function extensionToken<T>(name: string): ExtensionToken<T> {
  return Object.freeze({ name }) as ExtensionToken<T>;
}
