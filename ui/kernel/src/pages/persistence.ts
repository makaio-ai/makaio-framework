/**
 * Page layout persistence helpers.
 * @packageDocumentation
 */

import type { UiScope } from '@makaio/contracts';

export interface PageLayoutPersistenceContext {
  /** UI scope for this persisted layout. */
  readonly scope: UiScope;
  /** Optional host context identifier within the scope. */
  readonly contextId?: string | null;
}

/**
 * Build preference key for page layout.
 * @param pageId - Page identifier
 * @param context - Generic UI context identity.
 * @returns Preference key context string
 */
export function buildPageLayoutKey(pageId: string, context: PageLayoutPersistenceContext): string {
  const suffix =
    context.contextId !== null && context.contextId !== undefined
      ? `${context.scope}:${context.contextId}`
      : context.scope;
  return `page-layout:${pageId}:${suffix}`;
}

/**
 * Preference categories for page-related data.
 */
export const PAGE_PREFERENCE_CATEGORIES = {
  /** User's slot content customizations */
  layout: 'page-layout',
  /** User's collapsed/expanded slot states */
  slotState: 'page-slot-state',
  /** User's edit mode preferences */
  editMode: 'page-edit-mode',
} as const;
