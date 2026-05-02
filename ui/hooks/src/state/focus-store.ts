/**
 * Focus Store - Tab-scoped focus context for web/app
 *
 * Persisted to sessionStorage for tab isolation:
 * - Each tab maintains its own focus context
 * - Refresh survives within tab
 * - Close tab = fresh start (no stale context)
 *
 * Focus Contexts are composable widget layouts that adapt the UI to the current task.
 * @packageDocumentation
 */

import type { FocusContextLayout } from '../types/widget-layout.js';
import { createPersistedStore } from './create-persisted-store.js';

/**
 * Focus context ID - the preset context identifiers
 *
 * These are the built-in focus contexts available in the web/app interface.
 * For cross-package API contracts (slash commands, etc.), use FocusContext from \@makaio/contracts.
 * @deprecated FocusContext is being phased out. This store is kept for behavior parity
 * but should be removed after the focus-context-deprecation cleanup plan lands.
 * TODO(focus-context-deprecation): remove when FocusContext is deleted.
 */
export type FocusContextId = 'onboarding' | 'chat' | 'git' | 'review' | 'planning' | 'settings' | 'dashboard';

/**
 * Full Focus Context object with widget layout
 *
 * Represents a complete focus context with its widget arrangement.
 * System-provided contexts have preset IDs, while user-created contexts
 * can have custom IDs.
 */
export interface FocusContextObject {
  /** Unique identifier for this focus context */
  id: FocusContextId | string;
  /** Display name for this context */
  name: string;
  /** Whether this is a system preset or user-created */
  isPreset?: boolean;
  /** Widget arrangement for this context (optional) */
  layout?: FocusContextLayout;
  /** Context-aware quick prompt suggestions (optional) */
  quickPromptSuggestions?: string[];
}

/**
 * Normalized focus context state - always stores the full object
 * @deprecated FocusContext is being phased out. This store is kept for behavior parity
 * but should be removed after the focus-context-deprecation cleanup plan lands.
 * TODO(focus-context-deprecation): remove when FocusContext is deleted.
 */
export interface FocusState {
  /** Active focus context with full object (web/app only) */
  activeFocus: FocusContextObject;
  /**
   * Set active focus by ID (looks up from presets).
   * @param focusId - Preset focus context ID to activate.
   */
  setActiveFocus: (focusId: FocusContextId) => void;
  /**
   * Set active focus with full context object.
   * @param context - Full focus context object to activate.
   */
  setActiveFocusContext: (context: FocusContextObject) => void;
  /**
   * Update widget layout for current focus context.
   * @param layout - New layout to apply to the active focus context.
   */
  setFocusContextLayout: (layout: FocusContextLayout) => void;
  /** Get widget layout for current focus context */
  getFocusContextLayout: () => FocusContextLayout | undefined;
}

/**
 * NOTE(framework-boundary): These presets encode host-specific focus modes
 * (chat/git/review/planning) and prompt copy. They belong in a host-owned
 * host policy seam, not the framework. Deferred under TODO(focus-context-deprecation)
 * — already tagged \@deprecated; full lift happens alongside the focus-context refactor.
 *
 * Default focus context presets
 *
 * System-provided contexts with standard configurations.
 * @deprecated FocusContext is being phased out. This preset record is kept for behavior
 * parity but should be removed after the focus-context-deprecation cleanup plan lands.
 * TODO(focus-context-deprecation): remove when FocusContext is deleted.
 */
const FOCUS_CONTEXT_PRESETS: Record<FocusContextId, FocusContextObject> = {
  onboarding: {
    id: 'onboarding',
    name: 'Welcome',
    isPreset: true,
  },
  chat: {
    id: 'chat',
    name: 'Chat',
    isPreset: true,
    quickPromptSuggestions: [
      'Help me understand this code',
      'What are the key files in this project?',
      'Explain the architecture',
    ],
  },
  git: {
    id: 'git',
    name: 'Git',
    isPreset: true,
    quickPromptSuggestions: ['Show recent commits', 'What changed in this branch?', 'Create a new branch'],
  },
  review: {
    id: 'review',
    name: 'Code Review',
    isPreset: true,
    quickPromptSuggestions: ['Review this pull request', 'Show file differences', 'Add review comments'],
  },
  planning: {
    id: 'planning',
    name: 'Planning',
    isPreset: true,
    quickPromptSuggestions: ['Break down this task', 'Create implementation plan', 'Estimate complexity'],
  },
  settings: {
    id: 'settings',
    name: 'Settings',
    isPreset: true,
  },
  dashboard: {
    id: 'dashboard',
    name: 'Dashboard',
    isPreset: true,
    quickPromptSuggestions: ['Show recent projects', 'Open a workspace', 'Create a new project'],
  },
};

/**
 * Initial focus state — the production bootstrap value.
 *
 * Exported so tests can reset the store to exactly the same state the production
 * code starts from, without duplicating the fixture inline.
 * @deprecated FocusContext is being phased out. Remove alongside the store.
 * TODO(focus-context-deprecation): remove when FocusContext is deleted.
 */
export const INITIAL_FOCUS_STATE: Pick<FocusState, 'activeFocus'> = {
  activeFocus: FOCUS_CONTEXT_PRESETS.chat,
};

/**
 * Focus Store with Zustand state management
 *
 * Uses sessionStorage for tab-scoped persistence.
 * @deprecated FocusContext is being phased out. This store is kept for behavior parity
 * but should be removed after the focus-context-deprecation cleanup plan lands.
 * TODO(focus-context-deprecation): remove when FocusContext is deleted.
 */
export const useFocusStore = createPersistedStore<FocusState>(
  (set, get) => ({
    activeFocus: INITIAL_FOCUS_STATE.activeFocus,

    setActiveFocus: (focusId) => {
      const preset = FOCUS_CONTEXT_PRESETS[focusId];
      if (!preset) {
        console.error(`[focusStore] Unknown focus preset id: ${focusId}`);
        return;
      }
      set({ activeFocus: preset });
    },

    setActiveFocusContext: (context) => {
      set({ activeFocus: context });
    },

    setFocusContextLayout: (layout) => {
      const { activeFocus } = get();
      set({
        activeFocus: {
          ...activeFocus,
          layout,
        },
      });
    },

    getFocusContextLayout: () => {
      return get().activeFocus.layout;
    },
  }),
  { name: 'makaio-focus', storage: 'sessionStorage' },
);
