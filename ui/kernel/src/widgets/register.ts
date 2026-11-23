import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/contracts';
import { WidgetSubjects } from './namespace.js';
import { widgetRegistry } from './WidgetRegistry.js';
import type { WidgetDefinition } from './types.js';

/**
 * Register a widget with the widget system.
 *
 * Registers the widget in the local registry and emits a local bus event for
 * any active observers.
 * @param call - Context of the call registering the widget
 * @param bus - Bus instance
 * @param definition - Widget definition including component
 * @returns `true` when this call acquired the widget ID
 */
export function registerWidget(call: CallContext, bus: IMakaioBus, definition: WidgetDefinition): boolean {
  const didRegister = widgetRegistry.register(definition);
  if (!didRegister) {
    return false;
  }

  // WidgetSubjects.register is marked as localSubject() - never goes to transports
  bus
    .emit(call, WidgetSubjects.register, {
      id: definition.id,
      name: definition.name,
      scope: definition.scope,
      description: definition.description,
      supportedSizes: definition.supportedSizes,
      defaultSize: definition.defaultSize,
      component: definition.component,
      defaultConfig: definition.defaultConfig,
      allowMultiple: definition.allowMultiple,
      activate: definition.activate,
    })
    .catch((error) => {
      console.error(`[widget-register] Failed to emit register for "${definition.id}":`, error);
    });
  return true;
}

/**
 * Register multiple widgets at once.
 * @param call - Context of the call registering the widgets
 * @param bus - Bus instance
 * @param definitions - Array of widget definitions
 * @returns IDs that were newly registered by this call
 */
export function registerWidgets(
  call: CallContext,
  bus: IMakaioBus,
  definitions: readonly WidgetDefinition[],
): string[] {
  return definitions.flatMap((definition) => (registerWidget(call, bus, definition) ? [definition.id] : []));
}

/**
 * Unregister a widget by ID.
 * @param call - Context of the call unregistering the widget
 * @param bus - Bus instance
 * @param widgetId - Widget ID to unregister
 * @returns `true` when the widget existed and was removed
 */
export function unregisterWidget(call: CallContext, bus: IMakaioBus, widgetId: string): boolean {
  const didUnregister = widgetRegistry.unregister(widgetId);
  if (!didUnregister) {
    return false;
  }

  // WidgetSubjects.unregister is marked as localSubject() - never goes to transports
  bus.emit(call, WidgetSubjects.unregister, { widgetId }).catch((error) => {
    console.error(`[widget-register] Failed to emit unregister for "${widgetId}":`, error);
  });
  return true;
}
