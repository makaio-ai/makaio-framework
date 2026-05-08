/**
 * Accounts page declaration.
 *
 * Exports the {@link accountsPageDefinition} navigation definition for the
 * accounts management page. This page opens as a fullscreen overlay (`sheet`
 * mode) via the `SheetOverlay` renderer in `FrameworkShell`.
 *
 * No `PageDeclaration` (slot layout) is needed — sheet-mode pages do not use
 * the `WidgetCanvas`/`PageRenderer` system.
 * @packageDocumentation
 */

import type { PageDefinition } from '@makaio/ui-kernel';
import AccountsIcon from './accounts-icon.js';

/** Shared page ID for the accounts management page. */
export const ACCOUNTS_PAGE_ID = 'account-manager:accounts';

/**
 * Navigation definition for the accounts management page.
 *
 * Registered in {@link pageDefinitionRegistry}. Provides the lazy-loaded
 * component, sidebar icon, and navigation mode so the page is routable and
 * renderable by the shell's overlay system.
 *
 * Mode `sheet` opens the page as a fullscreen overlay that preserves the
 * workspace state underneath. The `WidgetGrid` triggers this overlay via
 * `usePageOverlayStore.openPage` when the dashboard accounts widget is
 * clicked.
 */
export const accountsPageDefinition: PageDefinition = {
  id: ACCOUNTS_PAGE_ID,
  name: 'Accounts',
  description: 'Manage accounts, switch providers, and rename',
  icon: AccountsIcon,
  mode: 'sheet',
  level: 'any',
  component: () => import('./accounts-page.js'),
  group: 'analytics',
  order: 10,
};
