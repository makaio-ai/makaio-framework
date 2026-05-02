/**
 * PageDefinitionRegistry - Unified registry for page definitions
 *
 * Central registry for all page definitions (built-in and plugin-provided).
 * Replaces NavigationRegistry for page-type targets while keeping it for
 * non-page targets (external links, commands, callbacks).
 *
 * Provides validation, default application, query filtering, and subscription
 * for reactive UI updates.
 * @packageDocumentation
 */

import type { SurfaceId } from './schemas.js';
import { RegistryBase } from '../utils/RegistryBase.js';
import type { PageDefinition, PageDefinitionQueryOptions, PageLevel } from './page-definition-types.js';

/**
 * Check if a page level matches a query level.
 *
 * Level filter follows "any includes everything" semantics:
 * - Pages with level='any' match all query levels
 * - Query level='any' matches all page levels
 * - Otherwise, levels must match exactly
 * @param pageLevel - The page's declared level
 * @param queryLevel - The level being queried for
 * @returns True if the page should be included in results
 */
function matchesLevel(pageLevel: PageLevel, queryLevel: PageLevel): boolean {
  if (pageLevel === 'any') return true;
  if (queryLevel === 'any') return true;
  return pageLevel === queryLevel;
}

/**
 * Check if a page is available on a given surface.
 *
 * Surface filter follows "omitted means all" semantics:
 * - Pages with no `surface` config are available on all surfaces
 * - Pages with `surface.surfaces` must include the queried surface ID
 * - Pages with `surface.requiredCapabilities` are NOT matched by ID alone
 *
 * Pages that declare only `requiredCapabilities` are excluded from SurfaceId-only
 * queries. Use `isPageVisibleOnSurface(page, surfaceDeclaration)` at the surface
 * runtime to include capability-gated pages with their full capability set.
 * @param page - The page definition to check
 * @param querySurface - The surface ID being queried for
 * @returns True if the page should be included in results
 */
function matchesSurface(page: PageDefinition, querySurface: SurfaceId): boolean {
  if (!page.surface) return true;
  if (page.surface.surfaces) {
    return page.surface.surfaces.includes(querySurface);
  }
  // Pages with only requiredCapabilities cannot be matched from a SurfaceId alone.
  return false;
}

/**
 * Filter a page-definition snapshot with the same semantics as registry.query().
 *
 * This keeps query logic reusable for hooks that must derive results from the
 * exact `useSyncExternalStore` snapshot they subscribed to, avoiding live-store
 * re-reads while still evaluating `when()` during render.
 * @param pages - Snapshot of page definitions to filter.
 * @param options - Query filters.
 * @returns Filtered pages in snapshot order.
 */
export function queryPageDefinitions(
  pages: ReadonlyArray<PageDefinition>,
  options: PageDefinitionQueryOptions = {},
): PageDefinition[] {
  const { mode, level, group, surface, includeHidden = false } = options;

  return pages.filter((page) => {
    if (mode && page.mode !== mode) return false;
    if (level && !matchesLevel(page.level, level)) return false;
    if (group && page.group !== group) return false;
    if (surface && !matchesSurface(page, surface)) return false;
    if (!includeHidden && page.when) {
      try {
        if (!page.when()) return false;
      } catch (error) {
        console.warn('[PageDefinitionRegistry] Page "when" callback threw, hiding page.', {
          pageId: page.id,
          error,
        });
        return false;
      }
    }
    return true;
  });
}

/**
 * Clone the optional surface metadata so callers cannot mutate registry state
 * through a shared array reference after registration.
 * @param surface - Surface metadata to copy, if present.
 * @returns A detached copy of the surface metadata, or `undefined`.
 */
function cloneSurfaceConfig(surface: PageDefinition['surface']): PageDefinition['surface'] {
  if (!surface) {
    return undefined;
  }

  return Object.freeze({
    ...surface,
    ...(surface.surfaces ? { surfaces: Object.freeze([...surface.surfaces]) } : {}),
    ...(surface.requiredCapabilities ? { requiredCapabilities: Object.freeze([...surface.requiredCapabilities]) } : {}),
  });
}

/**
 * Validate a page definition before registration.
 *
 * Checks:
 * - Non-empty id and name
 * - Valid mode ('switch' | 'peek' | 'cover')
 * - Non-empty level
 * - Component is a function
 * - `surface`, when present, specifies exactly one of `surfaces` or `requiredCapabilities`
 *   (empty object is meaningless; both fields set is ambiguous; empty arrays are rejected)
 * @param def - Page definition to validate
 * @throws Error if validation fails with descriptive message
 */
function validatePageDefinition(def: PageDefinition): void {
  if (!def.id || typeof def.id !== 'string') {
    throw new Error('PageDefinition must have a non-empty string id');
  }
  if (!def.name || typeof def.name !== 'string') {
    throw new Error(`PageDefinition "${def.id}" must have a non-empty name`);
  }
  if (def.mode !== 'switch' && def.mode !== 'peek' && def.mode !== 'cover') {
    throw new Error(`PageDefinition "${def.id}" must have mode 'switch', 'peek', or 'cover'`);
  }
  if (typeof def.level !== 'string' || def.level.trim().length === 0) {
    throw new Error(`PageDefinition "${def.id}" must have a non-empty level`);
  }
  if (typeof def.component !== 'function') {
    throw new Error(`PageDefinition "${def.id}" must have a component loader function`);
  }
  if (def.surface) {
    const surfaces = def.surface.surfaces;
    const requiredCapabilities = def.surface.requiredCapabilities;
    const hasSurfaces = surfaces !== undefined;
    const hasRequiredCapabilities = requiredCapabilities !== undefined;
    if (hasSurfaces === hasRequiredCapabilities) {
      throw new Error(
        `PageDefinition "${def.id}" surface must specify exactly one of "surfaces" or "requiredCapabilities"`,
      );
    }
    if (surfaces && surfaces.length === 0) {
      throw new Error(`PageDefinition "${def.id}" surface.surfaces must be a non-empty array`);
    }
    if (requiredCapabilities && requiredCapabilities.length === 0) {
      throw new Error(`PageDefinition "${def.id}" surface.requiredCapabilities must be a non-empty array`);
    }
  }
}

/**
 * Unified registry for page definitions.
 *
 * Manages all page definitions (built-in and plugin-provided) with:
 * - Validation on registration
 * - Default values for order and group
 * - Sorted caching (by order field)
 * - Query filtering by mode, level, group, visibility
 * - Subscription for reactive UI updates
 * @example
 * ```typescript
 * // Register a page
 * const cleanup = pageDefinitionRegistry.register({
 *   id: 'settings',
 *   name: 'Settings',
 *   mode: 'peek',
 *   level: 'any',
 *   component: () => import('./SettingsView.js').then(m => ({ default: m.SettingsView })),
 * });
 *
 * // Query pages
 * const peekPages = pageDefinitionRegistry.query({ mode: 'peek' });
 * const rootPages = pageDefinitionRegistry.query({ level: 'root' });
 *
 * // Subscribe to changes
 * const unsubscribe = pageDefinitionRegistry.subscribe(() => {
 *   console.log('Registry changed');
 * });
 * ```
 */
export class PageDefinitionRegistry extends RegistryBase<string, PageDefinition> {
  /**
   * Cached sorted array of all pages.
   * Invalidated on mutation.
   */
  private cachedAll: ReadonlyArray<PageDefinition> | null = null;

  /**
   * Register a page definition.
   *
   * Validates the definition, applies defaults for order and group,
   * and notifies subscribers.
   * @param definition - The page to register
   * @returns Cleanup function to unregister this page
   * @throws Error if page with same ID already exists
   * @throws Error if definition validation fails
   */
  public register(definition: PageDefinition): () => void {
    if (this.items.has(definition.id)) {
      throw new Error(`PageDefinition "${definition.id}" is already registered`);
    }

    validatePageDefinition(definition);

    // Apply defaults for optional fields and detach nested surface metadata
    // from caller-owned arrays so registry queries always reflect registry
    // mutations, not external object reuse.
    const normalized: PageDefinition = Object.freeze({
      order: 50,
      group: 'navigate',
      ...definition,
      surface: cloneSurfaceConfig(definition.surface),
    });

    this.items.set(normalized.id, normalized);
    this.invalidateCache();
    this.notify();

    // Capture normalized reference so a stale cleanup does not remove a newer
    // definition registered under the same id after an unregister/re-register.
    return () => {
      if (this.items.get(normalized.id) === normalized) {
        this.unregister(normalized.id);
      }
    };
  }

  /**
   * Get page definition by ID.
   * @param id - Page identifier
   * @returns Page definition or undefined if not registered
   */
  public get(id: string): PageDefinition | undefined {
    return this.items.get(id);
  }

  /**
   * Get all registered pages, sorted by order field.
   *
   * Results are cached until registry is mutated.
   * @returns Array of all page definitions, sorted by order (lower = first)
   */
  public getAll(): ReadonlyArray<PageDefinition> {
    if (!this.cachedAll) {
      this.cachedAll = Object.freeze(Array.from(this.items.values()).sort((a, b) => (a.order ?? 50) - (b.order ?? 50)));
    }
    return this.cachedAll;
  }

  /**
   * Query pages with filters.
   *
   * All filters are optional and combine with AND logic:
   * - mode: Exact match on page mode
   * - level: Matches level or 'any' (see matchesLevel)
   * - group: Exact match on navigation group
   * - surface: Matches pages available on the given surface (see matchesSurface)
   * - includeHidden: If false (default), exclude pages where when() returns false
   * @param options - Query filters
   * @returns Filtered pages, sorted by order
   * @example
   * ```typescript
   * // Get all peek mode pages
   * const peekPages = registry.query({ mode: 'peek' });
   *
   * // Get root-level pages (includes 'any' pages)
   * const rootPages = registry.query({ level: 'root' });
   *
   * // Get all pages including hidden ones
   * const allPages = registry.query({ includeHidden: true });
   * ```
   */
  public query(options: PageDefinitionQueryOptions = {}): PageDefinition[] {
    return queryPageDefinitions(this.getAll(), options);
  }

  /**
   * Unregister a page by ID.
   *
   * Removes the page and notifies subscribers.
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
   * Removes all pages and notifies subscribers.
   * Used primarily for testing or complete app teardown.
   */
  public clear(): void {
    this.items.clear();
    this.invalidateCache();
    this.notify();
  }

  /**
   * Invalidate internal caches.
   * Called after any mutation to force re-computation on next access.
   */
  private invalidateCache(): void {
    this.cachedAll = null;
  }
}

/**
 * Global page definition registry instance.
 *
 * Singleton registry used throughout the application.
 * Pages are registered at app startup via registerCorePages().
 */
export const pageDefinitionRegistry = new PageDefinitionRegistry();
