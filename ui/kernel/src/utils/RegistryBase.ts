/**
 * RegistryBase - Base class for implementing registries with subscription support
 *
 * Provides:
 * - Map-based storage for items
 * - Subscription mechanism for notifications
 * - Protected methods for mutation notifications
 *
 * Subclasses define their own public API while using the base infrastructure.
 * @packageDocumentation
 */

/**
 * Base class for registries with subscription support.
 *
 * Provides storage and notification infrastructure.
 * Subclasses are free to define their own public API without
 * signature constraints.
 * @example
 * ```ts
 * class MyRegistry extends RegistryBase<string, MyType> {
 *   public register(item: MyType): void {
 *     this.items.set(item.id, item);
 *     this.notify();
 *   }
 *
 *   public get(id: string): MyType | undefined {
 *     return this.items.get(id);
 *   }
 * }
 * ```
 */
export class RegistryBase<TKey, TValue> {
  /**
   * Internal storage map.
   * Subclasses can access this directly to implement their API.
   */
  protected items = new Map<TKey, TValue>();

  /**
   * Internal set of subscription listeners.
   */
  private listeners = new Set<() => void>();

  /**
   * Subscribe to registry mutations.
   * @param listener - Callback to invoke on mutations
   * @returns Unsubscribe function
   * @example
   * ```ts
   * const unsubscribe = registry.subscribe(() => {
   *   console.log('Registry changed');
   * });
   * ```
   */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all subscribers of a mutation.
   *
   * Iterates all listeners unconditionally so that a throwing listener cannot
   * prevent delivery to subsequent subscribers. The first error encountered is
   * re-thrown after the full iteration completes.
   * @example
   * ```ts
   * public register(item: MyType): void {
   *   this.items.set(item.id, item);
   *   this.notify(); // Notify subscribers
   * }
   * ```
   */
  protected notify(): void {
    let firstError: unknown = undefined;
    let hadError = false;

    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        if (!hadError) {
          firstError = error;
          hadError = true;
        }
      }
    });

    if (hadError) {
      throw firstError;
    }
  }

  /**
   * Check if an item is registered.
   * @param key - Item key
   * @returns True if item exists
   */
  public has(key: TKey): boolean {
    return this.items.has(key);
  }

  /**
   * Get number of registered items.
   * @returns Count of items
   */
  public size(): number {
    return this.items.size;
  }
}
