import type { IMakaioBus } from '@makaio/bus-core';
import { runCleanupsInReverse } from './cleanup-stack.js';
import { pageDefinitionRegistry } from '../pages/PageDefinitionRegistry.js';
import { pageRegistry } from '../pages/PageRegistry.js';
import { registerWidget, unregisterWidget } from '../widgets/register.js';
import type { ExtensionBrowserContribution } from './types.js';

/**
 * Register framework-level extension UI contributions.
 *
 * Phase 1 of the framework UI split keeps the contribution contract narrow but
 * fully functional: page declarations populate the page registry, page
 * definitions populate the page definition registry, and widgets are mirrored
 * through the widget bus-backed registration flow.
 *
 * Registration is treated as transactional: if a later step throws, already-
 * registered items are unwound in reverse order before the error propagates.
 *
 * The returned `unregisterAll` function tears down all successful registrations
 * in reverse order (last-registered first), matching standard stack-teardown
 * conventions. Callers must invoke it exactly once when the extension unloads.
 * @param bus - Bus used to publish widget registration events.
 * @param extensionName - Unique extension name for diagnostics.
 * @param contribution - Browser contribution returned by the extension factory.
 * @returns A single cleanup function that undoes all successful registrations in reverse order.
 */
export function registerExtensionUI(
  bus: IMakaioBus,
  extensionName: string,
  contribution: ExtensionBrowserContribution,
): () => void {
  const cleanups: Array<() => void> = [];

  try {
    if (contribution.pages) {
      for (const page of contribution.pages) {
        cleanups.push(pageRegistry.register(page));
      }
    }

    if (contribution.pageDefinitions) {
      for (const definition of contribution.pageDefinitions) {
        cleanups.push(pageDefinitionRegistry.register(definition));
      }
    }

    if (contribution.widgets) {
      contribution.widgets.forEach((definition) => {
        if (registerWidget(bus, definition)) {
          cleanups.push(() => unregisterWidget(bus, definition.id));
        } else {
          console.warn(
            `[registerExtensionUI] Widget "${definition.id}" from extension "${extensionName}" was already registered.`,
          );
        }
      });
    }

    return () => runCleanupsInReverse(cleanups, `[registerExtensionUI] ${extensionName}`);
  } catch (error) {
    runCleanupsInReverse(cleanups, `[registerExtensionUI] ${extensionName}`);
    throw error;
  }
}
