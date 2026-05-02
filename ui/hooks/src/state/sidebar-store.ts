/**
 * Sidebar Store - Sidebar collapsed state per navigation level
 *
 * Persisted to localStorage so sidebar state survives browser restart.
 * Keyed by navigation level (hub, project, workstream, worktree) so users can
 * keep different collapsed states per shell context.
 * @packageDocumentation
 */

import type { RuntimeNavigationLevel } from '../navigation/use-navigation-level.js';
import { createPersistedStore } from './create-persisted-store.js';

/**
 * Per-level collapsed state record.
 */
type CollapsedByLevel = Partial<Record<RuntimeNavigationLevel, boolean>>;

export interface SidebarState {
  /** Collapsed state keyed by navigation level */
  collapsedByLevel: CollapsedByLevel;

  /**
   * Check if sidebar is collapsed at a given navigation level.
   * @param level - Navigation level to check
   * @returns True if collapsed (defaults to false)
   */
  isCollapsed: (level: RuntimeNavigationLevel) => boolean;

  /**
   * Toggle sidebar collapsed state for a navigation level.
   * @param level - Navigation level to toggle
   */
  toggle: (level: RuntimeNavigationLevel) => void;

  /**
   * Set sidebar collapsed state for a navigation level.
   * @param level - Navigation level to set
   * @param collapsed - Whether the sidebar should be collapsed
   */
  setCollapsed: (level: RuntimeNavigationLevel, collapsed: boolean) => void;
}

/**
 * Return a new partial state with the given level's collapsed flag set.
 * Keeps the rest of `collapsedByLevel` intact via a shallow spread.
 * @param state - Current sidebar state.
 * @param level - Navigation level whose collapsed flag is being updated.
 * @param collapsed - New collapsed value for the level.
 * @returns Partial state with the updated `collapsedByLevel` map.
 */
function withCollapsedLevel(
  state: Pick<SidebarState, 'collapsedByLevel'>,
  level: RuntimeNavigationLevel,
  collapsed: boolean,
): Pick<SidebarState, 'collapsedByLevel'> {
  return {
    collapsedByLevel: {
      ...state.collapsedByLevel,
      [level]: collapsed,
    },
  };
}

/**
 * Sidebar state store.
 *
 * Provides per-navigation-level collapse persistence via localStorage.
 * @example
 * ```tsx
 * const isCollapsed = useSidebarStore((s) => s.isCollapsed(level));
 * const toggle = useSidebarStore((s) => s.toggle);
 *
 * return (
 *   <button onClick={() => toggle(level)}>
 *     {isCollapsed ? 'Expand' : 'Collapse'}
 *   </button>
 * );
 * ```
 */
export const useSidebarStore = createPersistedStore<SidebarState>(
  (set, get) => ({
    collapsedByLevel: {},

    isCollapsed: (level) => get().collapsedByLevel[level] ?? false,

    toggle: (level) => set((state) => withCollapsedLevel(state, level, !(state.collapsedByLevel[level] ?? false))),

    setCollapsed: (level, collapsed) => set((state) => withCollapsedLevel(state, level, collapsed)),
  }),
  { name: 'makaio-sidebar', storage: 'localStorage' },
);
