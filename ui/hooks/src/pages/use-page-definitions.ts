/**
 * usePageDefinitions - Reactive hook for querying page definitions
 *
 * Subscribes to PageDefinitionRegistry for automatic updates when pages
 * are registered/unregistered. Used by sidebar, slash command UI, and
 * navigation components.
 * @packageDocumentation
 */

import { useCallback, useSyncExternalStore } from 'react';
import { pageDefinitionRegistry, queryPageDefinitions } from '@makaio/ui-kernel';
import type { PageDefinition, PageDefinitionQueryOptions } from '@makaio/ui-kernel';

/**
 * Reactive hook for querying page definitions.
 *
 * Subscribes to registry changes and automatically updates when pages
 * are registered or unregistered. Returns filtered and sorted results
 * based on query options.
 * @param options - Filter by mode, level, group, or visibility
 * @returns Filtered, sorted page definitions
 * @example
 * ```typescript
 * function Sidebar() {
 *   // Get all peek mode pages for Quick Access section
 *   const peekPages = usePageDefinitions({ mode: 'peek' });
 *
 *   // Get all switch mode pages for Navigate section
 *   const switchPages = usePageDefinitions({ mode: 'switch' });
 *
 *   return (
 *     <aside>
 *       <section>
 *         <h3>Navigate</h3>
 *         {switchPages.map(page => <SidebarItem key={page.id} page={page} />)}
 *       </section>
 *       <section>
 *         <h3>Quick Access</h3>
 *         {peekPages.map(page => <SidebarItem key={page.id} page={page} />)}
 *       </section>
 *     </aside>
 *   );
 * }
 * ```
 */
export function usePageDefinitions(options?: PageDefinitionQueryOptions): PageDefinition[] {
  const subscribe = useCallback((callback: () => void) => pageDefinitionRegistry.subscribe(callback), []);
  const getSnapshot = useCallback(() => pageDefinitionRegistry.getAll(), []);
  const allPages = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return queryPageDefinitions(allPages, options);
}
