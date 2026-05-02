import type { IMakaioBus } from '@makaio/bus-core';
import { WidgetSubjects } from './namespace.js';
import { widgetRegistry } from './WidgetRegistry.js';
import type { WidgetDefinition, WidgetScope } from './types.js';
import type { WidgetDefinitionPayload } from './schemas.js';

interface ActiveWidgetSubscription {
  cleanup: () => void;
  refCount: number;
}

const activeWidgetSubscriptions = new WeakMap<IMakaioBus, ActiveWidgetSubscription>();

/**
 * Subscribe to widget bus events.
 *
 * Wires bus events to the internal widget registry.
 * Call once at app startup after bus is ready.
 * @param bus - Bus instance
 * @returns Cleanup function to unsubscribe all handlers
 */
export function subscribeToWidgetEvents(bus: IMakaioBus): () => void {
  const existingSubscription = activeWidgetSubscriptions.get(bus);
  if (existingSubscription) {
    existingSubscription.refCount += 1;
    return () => {
      existingSubscription.refCount -= 1;
      if (existingSubscription.refCount === 0) {
        existingSubscription.cleanup();
        activeWidgetSubscriptions.delete(bus);
      }
    };
  }

  const cleanups: Array<() => void> = [];

  // Handle widget registration
  cleanups.push(
    bus.on(WidgetSubjects.register, (ctx) => {
      const definition = ctx.payload as WidgetDefinition;

      // Skip if already registered (idempotent)
      if (widgetRegistry.has(definition.id)) {
        return;
      }

      widgetRegistry.register(definition);
    }),
  );

  // Handle widget unregistration
  cleanups.push(
    bus.on(WidgetSubjects.unregister, (ctx) => {
      widgetRegistry.unregister(ctx.payload.widgetId);
    }),
  );

  // Handle list request
  cleanups.push(
    bus.on(WidgetSubjects.list, (ctx) => {
      const { scope } = ctx.payload;
      // Cast at boundary: Zod schema validates string, internal API expects WidgetScope
      const widgets = scope ? widgetRegistry.getByScope(scope as WidgetScope) : Array.from(widgetRegistry.getAll());

      ctx.setResult({ widgets: widgets as WidgetDefinitionPayload[] });
    }),
  );

  const cleanup = () => cleanups.forEach((fn) => fn());
  const activeSubscription: ActiveWidgetSubscription = {
    cleanup,
    refCount: 1,
  };
  activeWidgetSubscriptions.set(bus, activeSubscription);

  return () => {
    activeSubscription.refCount -= 1;
    if (activeSubscription.refCount === 0) {
      cleanup();
      activeWidgetSubscriptions.delete(bus);
    }
  };
}
