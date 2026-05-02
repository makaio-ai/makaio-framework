/**
 * Navigation Level Hook
 *
 * Reads the current navigation level from WindowContext state.
 * Use this to determine which view/layout to render.
 * @packageDocumentation
 */

import type { UiRuntimeNavigationLevel } from '@makaio/contracts';
import { useWindowContext } from '../state/window-context-store.js';

/**
 * Runtime navigation level from the current UI context snapshot.
 */
export type RuntimeNavigationLevel = UiRuntimeNavigationLevel;

/**
 * Reads the current navigation level from window context.
 * @returns The current navigation level from `uiContext.level`.
 * @example
 * ```tsx
 * const level = useNavigationLevel();
 * ```
 */
export function useNavigationLevel(): RuntimeNavigationLevel {
  return useWindowContext((state) => state.uiContext.level);
}
