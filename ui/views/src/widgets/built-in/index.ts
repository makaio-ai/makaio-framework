/**
 * Framework-owned built-in widget definitions.
 *
 * These widgets are always available in the registry regardless of which
 * extensions are loaded. Callers that render a tray canvas should pass
 * `FRAMEWORK_TRAY_LOCKED_WIDGET_IDS` to `useTrayLayout()` so that the
 * framework widgets are pinned at the top of the tray layout.
 * @packageDocumentation
 */

import { frameworkStatusWidgetDefinition } from './StatusWidget.js';
import { frameworkOpenDashboardWidgetDefinition } from './open-dashboard-widget.js';
import { WidgetRegistry } from '@makaio/ui-kernel';

export { frameworkStatusWidgetDefinition, frameworkOpenDashboardWidgetDefinition };

/** Framework-owned tray widgets in their pinned render order. */
export const FRAMEWORK_TRAY_WIDGET_DEFINITIONS = [
  frameworkStatusWidgetDefinition,
  frameworkOpenDashboardWidgetDefinition,
] as const;

/**
 * Widget IDs for the framework-owned tray widgets that must be pinned at the
 * top of the tray layout with `locked: true`.
 *
 * Pass this array directly to `useTrayLayout(FRAMEWORK_TRAY_LOCKED_WIDGET_IDS)`
 * in the tray surface so consumers do not need to hard-code string IDs.
 */
export const FRAMEWORK_TRAY_LOCKED_WIDGET_IDS = [
  ...FRAMEWORK_TRAY_WIDGET_DEFINITIONS.map((definition) => definition.id),
] as const;

/**
 * Registers all framework-owned built-in widgets with the provided registry.
 *
 * Host shells (e.g., the Electron renderer bootstrap) call this once at
 * startup. The returned cleanup function unregisters all framework built-ins,
 * allowing orderly teardown during hot-module replacement or test isolation.
 *
 * Do **not** invoke this as a module-load side effect — host shells wire it
 * explicitly so they retain control over registration lifetime.
 * @param registry - The widget registry to register the built-in widgets into.
 * @returns A cleanup function that unregisters all registered framework built-ins.
 */
export function registerFrameworkBuiltInWidgets(registry: WidgetRegistry): () => void {
  FRAMEWORK_TRAY_WIDGET_DEFINITIONS.forEach((definition) => {
    registry.register(definition);
  });

  return () => {
    FRAMEWORK_TRAY_WIDGET_DEFINITIONS.forEach((definition) => {
      registry.unregister(definition.id);
    });
  };
}
