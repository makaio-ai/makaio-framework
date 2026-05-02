/**
 * useWindowIdPages - Page definitions filtered by the current Electron window ID
 *
 * Composes {@link usePages} with the current window registration ID from
 * {@link useWindowContext} to produce a navigation-ready list of pages
 * that are relevant to this specific Electron window.
 *
 * When running as a standalone browser tab (no window ID), all pages are
 * returned unchanged so the hook degrades gracefully outside Electron.
 * @packageDocumentation
 */

import { useWindowContext } from '../state/window-context-store.js';
import { usePages } from './use-pages.js';
import type { ExecutablePage } from './use-pages.js';
import type { PageDefinitionQueryOptions } from '@makaio/ui-kernel';

/**
 * Check whether a page's `windowId` constraint includes the given window ID.
 *
 * Constraint semantics:
 * - `undefined` — no restriction, visible in all windows
 * - `string` — visible only when the registration ID matches exactly
 * - `string[]` — visible in any of the listed registration IDs
 * @param constraint - The page's `windowId` field
 * @param current - The active Electron window registration ID
 * @returns True if the page should be shown in the current window
 */
function matchesWindowId(constraint: string | string[] | undefined, current: string): boolean {
  if (constraint === undefined) return true;
  if (Array.isArray(constraint)) return constraint.includes(current);
  return constraint === current;
}

/**
 * Returns page definitions filtered by the current Electron window registration ID.
 *
 * Wraps {@link usePages} with an additional window ID filter derived from
 * {@link useWindowContext}. Pages that declare a `windowId` constraint are
 * only included when the constraint matches the current window. Pages without
 * a `windowId` constraint are always included.
 *
 * When no window ID is set (standalone browser), all pages pass through
 * unfiltered so the sidebar behaves identically to the pre-Electron behaviour.
 * @param options - Query options forwarded to {@link usePages} (mode, level, group, surface, includeHidden)
 * @returns Pages with execute and isActive callbacks, filtered for the current window
 * @example
 * ```typescript
 * function Sidebar() {
 *   const level = useNavigationLevel();
 *   const surface = window.__MAKAIO_MOBILE__ ? 'mobile' : 'web';
 *   const pages = useWindowIdPages({ level, surface });
 *
 *   // pages only contains entries valid for this Electron window
 * }
 * ```
 */
export function useWindowIdPages(options?: PageDefinitionQueryOptions): ExecutablePage[] {
  const windowId = useWindowContext((s) => s.windowId);
  const allPages = usePages(options);

  if (!windowId) return allPages;

  return allPages.filter((page) => matchesWindowId(page.windowId, windowId));
}
