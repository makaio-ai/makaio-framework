import { RegistryBase } from '../utils/RegistryBase.js';
import { widgetMatchesScope } from './scope-registry.js';
import { eraseWidgetConfig, type WidgetDefinition, type WidgetScope } from './types.js';

/**
 * Registry for managing widget definitions.
 *
 * Extends {@link RegistryBase} for Map-based storage and subscription support.
 * Domain-specific methods handle scoped queries, cache invalidation, and
 * duplicate-safe registration semantics.
 */
export class WidgetRegistry extends RegistryBase<string, WidgetDefinition> {
  private cachedAll: ReadonlyArray<WidgetDefinition> | null = null;

  /**
   * Register a widget definition.
   *
   * Returns `false` without throwing when the widget ID is already present,
   * preserving idempotent registration semantics.
   * @param definition - Concretely-typed widget definition
   * @returns `true` when this call acquired the widget ID; `false` on duplicate
   */
  public register<TConfig extends Record<string, unknown>>(definition: WidgetDefinition<TConfig>): boolean {
    if (this.items.has(definition.id)) {
      return false;
    }

    this.items.set(definition.id, eraseWidgetConfig(definition));
    this.cachedAll = null;
    this.notify();
    return true;
  }

  /**
   * Register multiple widget definitions at once.
   * @param definitions - Array of widget definitions to register
   */
  public registerAll(definitions: readonly WidgetDefinition[]): void {
    definitions.forEach((definition) => this.register(definition));
  }

  /**
   * Get a single widget definition by ID.
   * @param widgetId - Widget identifier
   * @returns Widget definition or `undefined` if not registered
   */
  public get(widgetId: string): WidgetDefinition | undefined {
    return this.items.get(widgetId);
  }

  /**
   * Get all registered widget definitions.
   *
   * Result is cached and invalidated on any mutation. The returned array is
   * frozen to prevent callers from mutating the registry's internal cache.
   * @returns Frozen snapshot array of all widget definitions
   */
  public getAll(): ReadonlyArray<WidgetDefinition> {
    if (this.cachedAll === null) {
      this.cachedAll = Object.freeze(Array.from(this.items.values()));
    }

    return this.cachedAll;
  }

  /**
   * Get widget definitions available in a given scope.
   * @param scope - Target scope to filter by
   * @param includeAny - When `true` (default), also include widgets with `"any"` scope
   * @returns Filtered array of widget definitions
   */
  public getByScope(scope: WidgetScope, includeAny = true): WidgetDefinition[] {
    return this.getAll().filter((widget) => widgetMatchesScope(widget.scope, scope, includeAny));
  }

  /**
   * Unregister a widget by ID.
   * @param widgetId - Widget identifier to remove
   * @returns `true` when the widget existed and was removed; `false` otherwise
   */
  public unregister(widgetId: string): boolean {
    const removed = this.items.delete(widgetId);

    if (removed) {
      this.cachedAll = null;
      this.notify();
    }

    return removed;
  }

  /**
   * Remove all registered widget definitions.
   *
   * No-ops silently when the registry is already empty.
   */
  public clear(): void {
    if (this.items.size === 0) {
      return;
    }

    this.items.clear();
    this.cachedAll = null;
    this.notify();
  }
}

/** Global widget registry instance */
export const widgetRegistry = new WidgetRegistry();
