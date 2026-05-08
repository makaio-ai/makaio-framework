/**
 * usePageComponent - Resolve lazy-loaded page components
 *
 * Looks up page definitions and wraps their component loaders in React.lazy()
 * for Suspense support. Memoizes per pageId to avoid re-creating lazy components.
 * @packageDocumentation
 */

import { useCallback, useMemo, lazy, type ComponentType, useSyncExternalStore } from 'react';
import { pageDefinitionRegistry } from '@makaio/ui-kernel';
import type { PageDefinition, PageComponentProps } from '@makaio/ui-kernel';

/**
 * Resolve a lazy-loaded page component by ID.
 *
 * Returns the component wrapped in React.lazy() for Suspense support,
 * along with the full page definition for metadata access.
 *
 * Memoized per pageId to avoid re-creating lazy components on every render.
 * @param pageId - Page identifier, or `null` when no page is active.
 *   A `null` value is treated the same as "not found" and returns `undefined`.
 * @param reloadKey - Optional key that forces React.lazy wrapper recreation
 *   for retrying failed dynamic imports.
 * @returns Object with Component and definition, or undefined if not registered
 *   or if pageId is null
 * @example
 * ```typescript
 * function PageOverlayView() {
 *   const activePageId = usePageOverlayStore((s) => s.activePageId);
 *   const resolved = usePageComponent(activePageId);
 *
 *   if (!resolved) {
 *     return null;
 *   }
 *
 *   const { Component, definition } = resolved;
 *
 *   return (
 *     <PageOverlay title={definition.name}>
 *       <Suspense fallback={<LoadingSpinner />}>
 *         <Component />
 *       </Suspense>
 *     </PageOverlay>
 *   );
 * }
 * ```
 */
export function usePageComponent(
  pageId: string | null,
  reloadKey = 0,
):
  | {
      Component: ComponentType<PageComponentProps>;
      definition: PageDefinition;
    }
  | undefined {
  // We cannot early-return before useSyncExternalStore() without violating the
  // Rules of Hooks. The null-page path therefore swaps in a no-op subscriber
  // and undefined snapshot so no real registry subscription is created.
  const subscribe = useCallback(
    (callback: () => void) => {
      if (pageId === null) {
        return () => undefined;
      }
      return pageDefinitionRegistry.subscribe(callback);
    },
    [pageId],
  );
  const getSnapshot = useCallback(() => {
    if (pageId === null) {
      return undefined;
    }
    return pageDefinitionRegistry.get(pageId);
  }, [pageId]);

  const definition = useSyncExternalStore<PageDefinition | undefined>(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => {
    if (!definition) {
      return undefined;
    }

    // Wrap the component loader in React.lazy for Suspense support.
    // `reloadKey` deliberately recreates the wrapper after an import/render
    // failure so an overlay Retry button can issue a fresh attempt.
    const Component = lazy(definition.component);

    return { Component, definition };
  }, [definition, reloadKey]);
}
