/**
 * Window Context Store - Tab-scoped UI context state
 *
 * Persisted to sessionStorage for tab isolation:
 * - Tab A and Tab B can hold different host UI context snapshots
 * - Refresh survives within tab
 * - Close tab = fresh start (inherits from AppContext defaults)
 *
 * This is the primary store for the host UI context snapshot that framework
 * hooks and contributed UI consume.
 * @packageDocumentation
 */

import type { UiContextSnapshot } from '@makaio/contracts';
import { createPersistedStore } from './create-persisted-store.js';

/** Framework fallback context when no host has selected a narrower context. */
export const defaultUiContext: UiContextSnapshot = {
  level: 'root',
  values: {},
};

/**
 * Clone a UI context snapshot at the store boundary.
 *
 * Host context snapshots are readonly by contract, but callers often assemble
 * them from mutable host state. The store owns its copy so later caller-side
 * mutation cannot silently rewrite the active tab context.
 * @param uiContext - UI context snapshot crossing into store ownership.
 * @returns Store-owned UI context snapshot.
 */
function cloneUiContext(uiContext: UiContextSnapshot): UiContextSnapshot {
  return {
    level: uiContext.level,
    values: { ...uiContext.values },
  };
}

export interface WindowContextState {
  /**
   * The qualified desktop window registration ID for this tab, when the page is
   * hosted inside a desktop shell (`{packageName}:{windowId}`). Null when
   * running as a standalone browser tab.
   *
   * Set once during bootstrap from host-local runtime config. Never changes for
   * the lifetime of the tab. Not persisted — always re-derived from the host
   * config on each page load.
   */
  windowId: string | null;

  /** Current host UI context snapshot for this tab. */
  uiContext: UiContextSnapshot;

  /**
   * ID of the pane that most recently received user focus.
   * Transient — not persisted. Resets to `null` on page load.
   */
  activePaneId: string | null;

  /**
   * Set the window registration ID (called once during bootstrap).
   *
   * Should only be called by the bootstrap function before React renders.
   * After the first non-null write, subsequent calls with a different value
   * are silently ignored — the ID is immutable for the tab's lifetime.
   * Re-setting the same value (e.g. HMR re-bootstrap) is a no-op.
   * @param id - The qualified desktop window registration ID, or null for standalone browser.
   */
  setWindowId: (id: string | null) => void;

  /**
   * Set the active host UI context snapshot.
   * @param uiContext - UI context snapshot to store for this tab.
   */
  setUiContext: (uiContext: UiContextSnapshot) => void;

  /**
   * Sets the active pane.
   *
   * Called by PaneContainer on focus or pointer-down capture.
   * @param id - Pane ID, or null to clear.
   */
  setActivePaneId: (id: string | null) => void;

  /** Clear the UI context back to the framework root context. */
  clearUiContext: () => void;
}

/**
 * Tab-scoped window context store.
 *
 * Use this for navigation state and window-specific overrides:
 * - Which host UI context is active in THIS window
 * - Model/adapter overrides for THIS window
 *
 * Navigation level is read directly from `uiContext.level`.
 */
export const useWindowContext = createPersistedStore<WindowContextState>(
  (set) => ({
    windowId: null,
    uiContext: cloneUiContext(defaultUiContext),
    activePaneId: null,

    setWindowId: (id) =>
      set((state) => {
        // windowId is immutable for the tab's lifetime. Allow the first write
        // (null → any) and idempotent re-writes (same value after HMR), but
        // silently ignore attempts to change a non-null ID to a different value.
        if (state.windowId !== null && state.windowId !== id) {
          return {};
        }
        return { windowId: id };
      }),

    setUiContext: (uiContext) => set({ uiContext: cloneUiContext(uiContext), activePaneId: null }),

    setActivePaneId: (id) => set({ activePaneId: id }),

    clearUiContext: () => set({ uiContext: cloneUiContext(defaultUiContext), activePaneId: null }),
  }),
  {
    name: 'makaio-window-context',
    storage: 'sessionStorage',
    // windowId is always re-derived from host runtime config on page load; do not persist it.
    partialize: (state) => ({
      uiContext: state.uiContext,
    }),
  },
);
