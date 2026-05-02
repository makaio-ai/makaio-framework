/**
 * Page Overlay Store - Global page overlay state
 *
 * Manages the state of the PageOverlay system for IDE-like navigation to pages
 * (Settings, Help, Plugin Config) as modal overlays that preserve workspace state.
 * This is ephemeral UI state that persists to sessionStorage for tab isolation.
 *
 * Persisted to sessionStorage:
 * - Tab survives refresh with overlay state preserved
 * - Each tab has its own overlay state
 * - Close tab = fresh start (no stale state)
 * @packageDocumentation
 */

import { createPersistedStore } from './create-persisted-store.js';

/**
 * Page overlay state management.
 */
export interface PageOverlayState {
  /** Currently displayed page ID (null = closed) */
  activePageId: string | null;
  /** Internal route within the page */
  internalRoute: string | null;
  /**
   * Open a page in the overlay.
   * @param pageId - ID of the page to open (e.g., 'settings', 'help')
   * @param route - Optional internal route within the page; defaults to null
   */
  openPage: (pageId: string, route?: string) => void;
  /** Close the overlay */
  close: () => void;
  /**
   * Navigate within the current page.
   * @param route - New internal route
   */
  navigate: (route: string) => void;
}

/**
 * Zustand store for PageOverlay state.
 *
 * Uses sessionStorage for tab-scoped persistence, ensuring each browser tab
 * maintains its own overlay state independently.
 * @example
 * ```tsx
 * function MyComponent() {
 *   const activePageId = usePageOverlayStore((s) => s.activePageId);
 *   const openPage = usePageOverlayStore((s) => s.openPage);
 *
 *   return (
 *     <button onClick={() => openPage('settings')}>
 *       Open Settings
 *     </button>
 *   );
 * }
 * ```
 */
export const usePageOverlayStore = createPersistedStore<PageOverlayState>(
  (set) => ({
    activePageId: null,
    internalRoute: null,
    openPage: (pageId, route) =>
      set({
        activePageId: pageId,
        internalRoute: route ?? null,
      }),
    close: () =>
      set({
        activePageId: null,
        internalRoute: null,
      }),
    navigate: (route) =>
      set((state) => ({
        internalRoute: route,
        // Preserve activePageId
        activePageId: state.activePageId,
      })),
  }),
  { name: 'makaio-page-overlay', storage: 'sessionStorage' },
);
