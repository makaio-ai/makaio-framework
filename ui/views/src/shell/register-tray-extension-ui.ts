import type { IMakaioBus } from '@makaio/bus-core';
import { registerWidget, unregisterWidget, runCleanupsInReverse, widgetMatchesScope } from '@makaio/ui-kernel';
import type { ExtensionBrowserContribution } from '@makaio/ui-kernel';

/**
 * Register only tray-scoped widgets from a browser contribution.
 *
 * The tray surface must stay isolated from page, onboarding, and non-tray
 * widget registration. Those surfaces belong to the main shell, not the tray
 * popover renderer.
 * @param bus - Bus used for widget registration events.
 * @param extensionName - Extension name used in diagnostics.
 * @param contribution - Browser contribution returned by the extension factory.
 * @returns Cleanup that unregisters all tray widgets registered from the contribution.
 */
export function registerTrayExtensionUI(
  bus: IMakaioBus,
  extensionName: string,
  contribution: ExtensionBrowserContribution,
): () => void {
  const cleanups: Array<() => void> = [];

  try {
    for (const definition of contribution.widgets ?? []) {
      if (!widgetMatchesScope(definition.scope, 'tray', false)) {
        continue;
      }

      if (registerWidget(bus, definition)) {
        cleanups.push(() => unregisterWidget(bus, definition.id));
      } else {
        console.warn(
          `[registerTrayExtensionUI] Widget "${definition.id}" from extension "${extensionName}" was already registered.`,
        );
      }
    }

    return () => runCleanupsInReverse(cleanups, `[registerTrayExtensionUI] ${extensionName}`);
  } catch (error) {
    runCleanupsInReverse(cleanups, `[registerTrayExtensionUI] ${extensionName}`);
    throw error;
  }
}
