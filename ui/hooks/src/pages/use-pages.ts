/**
 * usePages - Convenience hook combining page definitions with navigation actions
 *
 * Returns page definitions augmented with execute callbacks that do the right
 * thing based on page mode:
 * - peek mode: Opens page overlay via pageOverlayStore
 * - cover mode: Opens page overlay via pageOverlayStore (full viewport)
 * - switch mode: Changes focus context via focusStore
 * @packageDocumentation
 */

import { useCallback } from 'react';
import { usePageOverlayStore } from '../state/page-overlay-store.js';
import { useFocusStore, type FocusContextId } from '../state/focus-store.js';
import { usePageDefinitions } from './use-page-definitions.js';
import { isOverlayMode } from '@makaio/ui-kernel';
import type { PageDefinition, PageDefinitionQueryOptions } from '@makaio/ui-kernel';

/**
 * Page definition augmented with navigation action and active state.
 *
 * Returned by {@link usePages}. Guarantees both `execute` and `isActive`
 * are always defined, unlike the base `PageDefinition` where `isActive`
 * is optional.
 *
 * `isActive` is a plain boolean evaluated at render time. Consumers must
 * not cache `ExecutablePage` objects across renders — re-read from the hook
 * on each render to get the current active state.
 */
export interface ExecutablePage extends Omit<PageDefinition, 'isActive'> {
  /** Execute the page's navigation action (open overlay or switch focus). */
  execute: () => void;
  /**
   * Whether this page is currently active.
   *
   * Evaluated at render time from the current store state. Always defined.
   * Re-read the hook on each render to observe changes.
   */
  isActive: boolean;
}

/**
 * Convenience hook combining page definitions with navigation actions.
 *
 * Returns page definitions with an execute function for each:
 * - Peek mode pages: execute opens the page overlay
 * - Switch mode pages: execute changes the focus context (if focusContext is set)
 *
 * Used by sidebar, command palette, and other navigation UI to handle
 * page activation consistently.
 * @param options - Filter options (mode, level, group, includeHidden)
 * @returns Pages with execute and isActive callbacks
 * @example
 * ```typescript
 * function Sidebar() {
 *   const peekPages = usePages({ mode: 'peek' });
 *   const switchPages = usePages({ mode: 'switch' });
 *
 *   return (
 *     <aside>
 *       <section>
 *         <h3>Navigate</h3>
 *         {switchPages.map(page => (
 *           <button key={page.id} onClick={page.execute}>
 *             {page.name}
 *           </button>
 *         ))}
 *       </section>
 *       <section>
 *         <h3>Quick Access</h3>
 *         {peekPages.map(page => (
 *           <button key={page.id} onClick={page.execute}>
 *             {page.name}
 *           </button>
 *         ))}
 *       </section>
 *     </aside>
 *   );
 * }
 * ```
 */
export function usePages(options?: PageDefinitionQueryOptions): ExecutablePage[] {
  const definitions = usePageDefinitions(options);
  const openPage = usePageOverlayStore((state) => state.openPage);
  const activePageId = usePageOverlayStore((state) => state.activePageId);
  const setActiveFocus = useFocusStore((state) => state.setActiveFocus);
  const activeFocusId = useFocusStore((state) => state.activeFocus.id);

  // Create execute callback based on page mode
  const createExecute = useCallback(
    (page: PageDefinition) => {
      if (isOverlayMode(page.mode)) {
        // Both peek and cover open via overlay store
        return () => openPage(page.id);
      } else {
        // Switch mode: change focus context if defined
        return () => {
          if (page.focusContext) {
            // TODO(focus-context-deprecation): cast is safe because focusContext
            // values must be valid FocusContextId presets for switch-mode pages.
            setActiveFocus(page.focusContext as FocusContextId);
          }
          // If no focusContext, this is a no-op (page might handle navigation differently)
        };
      }
    },
    [openPage, setActiveFocus],
  );

  // Augment each page definition with execute callback and current isActive boolean.
  // Computing isActive as a plain boolean (not a closure) prevents stale-capture bugs:
  // the value is evaluated from the current store state during this render, and
  // consumers simply read page.isActive without needing to call it.
  return definitions.map((page) => {
    let isActive: boolean;
    if (page.isActive) {
      // PageDefinition may supply its own isActive predicate — call it now.
      isActive = page.isActive();
    } else if (isOverlayMode(page.mode)) {
      isActive = activePageId === page.id;
    } else if (page.focusContext) {
      isActive = activeFocusId === page.focusContext;
    } else {
      isActive = false;
    }
    return {
      ...page,
      execute: createExecute(page),
      isActive,
    };
  });
}
