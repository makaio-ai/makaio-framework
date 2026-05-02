/**
 * App Context Store - Cross-tab application defaults
 *
 * Persisted to localStorage for cross-tab sharing:
 * - Changes here affect new windows/tabs
 * - Existing windows keep their overrides (via selectionStore)
 * - Used for user-level defaults that should persist across sessions
 * @packageDocumentation
 */

import type { AgentSelection } from '@makaio/contracts';
import { createPersistedStore } from './create-persisted-store.js';
import { parsePersistedAgentSelection } from '../utils/persisted-agent-selection.js';

export interface AppContextState {
  /** Default agent selection for new windows (null = use system default) */
  defaultSelection: AgentSelection | null;

  /** Set the default selection for new windows */
  setDefaultSelection: (selection: AgentSelection | null) => void;
}

/**
 * Merge a persisted app-context payload into the current in-memory state.
 *
 * The merge stays conservative: absent or invalid persisted selections leave
 * the live state untouched instead of blanking it out during hydration.
 * @param persistedState - Raw persisted payload from storage.
 * @param currentState - Current in-memory state.
 * @returns Merged app-context state.
 */
export function mergePersistedAppContextState(persistedState: unknown, currentState: AppContextState): AppContextState {
  if (persistedState !== null && typeof persistedState === 'object' && 'defaultSelection' in persistedState) {
    const rawDefaultSelection = (persistedState as Record<string, unknown>).defaultSelection;
    if (rawDefaultSelection === null || rawDefaultSelection === undefined) {
      return currentState;
    }

    const defaultSelection = parsePersistedAgentSelection(rawDefaultSelection);
    if (defaultSelection === null) {
      return currentState;
    }

    return {
      ...currentState,
      defaultSelection,
    };
  }

  return currentState;
}

/**
 * Cross-tab application context store.
 *
 * Use this for user-level defaults that should:
 * - Persist across browser sessions
 * - Apply to newly opened windows/tabs
 * - Be overridable per-window via useSelectionStore
 * @example
 * ```tsx
 * const { defaultSelection, setDefaultSelection } = useAppContext();
 *
 * // Update default for new windows
 * setDefaultSelection({ kind: 'adapter', adapterName: 'claude-code', model: 'opus' });
 * ```
 */
export const useAppContext = createPersistedStore<AppContextState>(
  (set) => ({
    defaultSelection: null,
    setDefaultSelection: (selection) => set({ defaultSelection: selection }),
  }),
  {
    name: 'makaio-app-context',
    storage: 'localStorage',
    merge: mergePersistedAppContextState,
  },
);
