/**
 * PageRegistry - Central registry for page declarations.
 *
 * Follows the same pattern as WidgetRegistry, ViewRegistry, PanelRegistry.
 */

import { RegistryBase } from '../utils/RegistryBase.js';
import { widgetScopeRegistry } from '../widgets/scope-registry.js';
import type { PageDeclaration, PageLevel, SlotId } from './types.js';

/**
 * Validate a page declaration before registration.
 * @param declaration - Page declaration to validate
 */
function validateDeclaration(declaration: PageDeclaration): void {
  if (!widgetScopeRegistry.has(declaration.scope)) {
    console.warn(
      `[PageRegistry] Page "${declaration.id}" uses unregistered scope "${declaration.scope}". ` +
        'Consider registering it via widgetScopeRegistry.',
    );
  }

  const slotIds = new Set(declaration.slots.map((slot) => slot.id));

  for (const slotId of Object.keys(declaration.defaultContent)) {
    if (!slotIds.has(slotId as SlotId)) {
      throw new Error(
        `Page "${declaration.id}" has defaultContent for slot "${slotId}" ` + 'but slot is not declared in slots array',
      );
    }
  }

  if (slotIds.size !== declaration.slots.length) {
    throw new Error(`Page "${declaration.id}" has duplicate slot IDs`);
  }

  for (const slot of declaration.slots) {
    if (slot.minColumnWidth <= 0) {
      throw new Error(`Slot "${slot.id}" in page "${declaration.id}" has invalid minColumnWidth (must be > 0)`);
    }
    if (slot.maxColumns <= 0) {
      throw new Error(`Slot "${slot.id}" in page "${declaration.id}" has invalid maxColumns (must be > 0)`);
    }
    if (slot.acceptsSizes.length === 0) {
      throw new Error(`Slot "${slot.id}" in page "${declaration.id}" has empty acceptsSizes array`);
    }
  }

  for (const [slotId, placements] of Object.entries(declaration.defaultContent)) {
    if (!placements) continue;

    for (const placement of placements) {
      if (!placement.instanceId) {
        throw new Error(`Page "${declaration.id}" slot "${slotId}" has placement missing instanceId`);
      }
      if (placement.content.type === 'widget' && !placement.content.widgetId) {
        throw new Error(`Page "${declaration.id}" slot "${slotId}" has widget placement with empty widgetId`);
      }
      if (placement.content.type === 'view' && !placement.content.viewId) {
        throw new Error(`Page "${declaration.id}" slot "${slotId}" has view placement with empty viewId`);
      }
    }
  }
}

/**
 * Registry for managing page declarations.
 */
export class PageRegistry extends RegistryBase<string, PageDeclaration> {
  private cachedAll: ReadonlyArray<PageDeclaration> | null = null;

  /**
   * Register a page declaration.
   * @param declaration - The page to register
   * @returns Cleanup function to unregister
   * @throws If page with same ID already exists, route is already registered, or declaration is invalid
   */
  public register(declaration: PageDeclaration): () => void {
    if (this.items.has(declaration.id)) {
      throw new Error(`Page "${declaration.id}" is already registered`);
    }

    if (declaration.route !== undefined) {
      for (const existing of this.items.values()) {
        if (existing.route === declaration.route) {
          throw new Error(`Route "${declaration.route}" is already registered by page "${existing.id}"`);
        }
      }
    }

    validateDeclaration(declaration);
    this.items.set(declaration.id, declaration);
    this.invalidateCache();
    this.notify();

    // Capture declaration reference so a stale cleanup does not remove a newer
    // declaration registered under the same id after an unregister/re-register.
    return () => {
      if (this.items.get(declaration.id) === declaration) {
        this.unregister(declaration.id);
      }
    };
  }

  /**
   * Get page by ID.
   * @param id - Page identifier
   * @returns Page declaration or undefined
   */
  public get(id: string): PageDeclaration | undefined {
    return this.items.get(id);
  }

  /**
   * Get all registered pages.
   *
   * Result is cached and invalidated on any mutation. The returned array is
   * frozen to prevent callers from mutating the registry's internal cache.
   * @returns Frozen snapshot array of all page declarations
   */
  public getAll(): ReadonlyArray<PageDeclaration> {
    if (this.cachedAll === null) {
      this.cachedAll = Object.freeze(Array.from(this.items.values()));
    }
    return this.cachedAll;
  }

  /**
   * Get all pages that have routes (for router integration).
   * @returns Array of routable page declarations
   */
  public getRoutablePages(): PageDeclaration[] {
    return this.getAll().filter((page) => page.route !== undefined);
  }

  /**
   * Get pages by scope.
   * @param scope - Widget scope to filter by
   * @param includeAny - Include pages with 'any' scope (default: true)
   * @returns Filtered pages
   */
  public getByScope(scope: PageDeclaration['scope'], includeAny = true): PageDeclaration[] {
    return this.getAll().filter((page) => page.scope === scope || (includeAny && page.scope === 'any'));
  }

  /**
   * Get pages by navigation level.
   * @param level - Navigation level to filter by
   * @param includeAny - Include pages with 'any' level (default: true)
   * @returns Filtered pages
   */
  public getByLevel(level: PageLevel, includeAny = true): PageDeclaration[] {
    return this.getAll().filter(
      (page) => page.level === level || (includeAny && (page.level === 'any' || page.level === undefined)),
    );
  }

  /**
   * Unregister a page by ID.
   * @param id - Page identifier
   * @returns True if page was unregistered, false if not found
   */
  public unregister(id: string): boolean {
    const result = this.items.delete(id);
    if (result) {
      this.invalidateCache();
      this.notify();
    }
    return result;
  }

  /**
   * Clear all registered pages.
   *
   * No-ops silently when the registry is already empty, avoiding a
   * spurious subscriber notification.
   */
  public clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.invalidateCache();
    this.notify();
  }

  /**
   * Invalidate internal caches.
   */
  private invalidateCache(): void {
    this.cachedAll = null;
  }
}

/** Global page registry instance */
export const pageRegistry = new PageRegistry();
