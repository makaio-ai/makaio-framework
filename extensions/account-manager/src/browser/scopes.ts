/**
 * Widget scope registration for the account-manager browser extension.
 *
 * Declares the `'account-manager:analytics'` scope via module augmentation on
 * the shared `UiScopeMap`, then registers it at module evaluation time as a
 * side effect so it is available to any widget that references the scope
 * before the extension factory runs.
 *
 * Import this module as a side-effect import from the browser entry point:
 * ```typescript
 * import './scopes.js';
 * ```
 * @packageDocumentation
 */

import { widgetScopeRegistry } from '@makaio/ui-kernel';
import type { UiScope } from '@makaio/contracts';

declare module '@makaio/contracts' {
  interface UiScopeMap {
    'account-manager:analytics': true;
  }
}

const ANALYTICS_SCOPE_ID: UiScope = 'account-manager:analytics';

if (!widgetScopeRegistry.has(ANALYTICS_SCOPE_ID)) {
  widgetScopeRegistry.register(ANALYTICS_SCOPE_ID, {
    label: 'Analytics',
    description: 'Account-manager analytics page canvas',
  });
}
