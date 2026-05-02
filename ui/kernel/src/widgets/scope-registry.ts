/**
 * Widget scope registry for managing custom widget scopes.
 *
 * Allows hosts and extensions to register custom scopes beyond the
 * framework-owned built-ins (`global`, `any`).
 * @packageDocumentation
 */

import type { UiScope } from '@makaio/contracts';

/** Widget scope type declared by the shared UI contribution contract. */
export type WidgetScope = UiScope;

/**
 * Widget scope definition.
 */
export interface WidgetScopeDefinition {
  /** Display label */
  label: string;
  /** Description for UI */
  description?: string;
}

/**
 * Widget scope registry implementation.
 *
 * Manages registration and lookup of widget scopes with subscription support.
 */
class WidgetScopeRegistryImpl {
  private scopes = new Map<UiScope, WidgetScopeDefinition>([
    ['global', { label: 'Global', description: 'Available in global UI contexts' }],
    ['any', { label: 'Any', description: 'Available in every UI context' }],
  ]);
  private listeners = new Set<() => void>();

  /**
   * Register a new widget scope.
   * @param scope - Scope identifier declared through `UiScopeMap`.
   * @param definition - Scope definition with label and description
   */
  public register(scope: UiScope, definition: WidgetScopeDefinition): void {
    if (this.scopes.has(scope)) {
      console.warn(`Widget scope '${scope}' already registered`);
      return;
    }
    this.scopes.set(scope, definition);
    this.notify();
  }

  /**
   * Check if a scope is registered.
   * @param scope - Scope identifier to check
   * @returns True if scope exists
   */
  public has(scope: UiScope): boolean {
    return this.scopes.has(scope);
  }

  /**
   * Get all registered scopes.
   * @returns Map of scope identifiers to definitions
   */
  public getAll(): Map<UiScope, WidgetScopeDefinition> {
    return new Map(this.scopes);
  }

  /**
   * Subscribe to scope registry changes.
   * @param listener - Callback function when scopes change
   * @returns Unsubscribe function
   */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }
}

/**
 * Global widget scope registry instance.
 */
export const widgetScopeRegistry = new WidgetScopeRegistryImpl();

/**
 * Returns true when a widget's `scope` (single value or array) matches
 * `targetScope`. When `includeAny` is true (the default), widgets scoped
 * to `'any'` also match — matching the canonical "available everywhere"
 * semantics used across surfaces.
 *
 * Hooks and other snapshot consumers can call this predicate directly instead
 * of re-implementing the same single-value-vs-array and `'any'` matching
 * rules locally.
 * @param scope - The widget's `scope` field (single value or array).
 * @param targetScope - The scope being looked up.
 * @param includeAny - When true, widgets scoped `'any'` also match. Defaults to true.
 * @returns Whether the widget's scope matches `targetScope`.
 */
export function widgetMatchesScope(
  scope: WidgetScope | readonly WidgetScope[],
  targetScope: WidgetScope,
  includeAny = true,
): boolean {
  const scopes = Array.isArray(scope) ? scope : [scope];
  return scopes.includes(targetScope) || (includeAny && scopes.includes('any'));
}
