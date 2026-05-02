import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { widgetRegistry } from './WidgetRegistry.js';
import { WidgetSubjects } from './namespace.js';
import { subscribeToWidgetEvents } from './subscriptions.js';
import type { WidgetDefinition } from './types.js';

const TEST_WIDGET: WidgetDefinition = {
  allowMultiple: true,
  component: () => null,
  defaultConfig: {},
  defaultSize: 'medium',
  description: 'Subscription test widget',
  id: 'subscription-test-widget',
  name: 'Subscription Test Widget',
  scope: 'global',
  supportedSizes: ['medium'],
};

describe('subscribeToWidgetEvents', () => {
  afterEach(() => {
    widgetRegistry.clear();
    vi.clearAllMocks();
  });

  it('shares one bus subscription across multiple consumers and cleans up after the last one', async () => {
    const bus = createBusInstance();
    const onSpy = vi.spyOn(bus, 'on');

    const cleanupA = subscribeToWidgetEvents(bus);
    const cleanupB = subscribeToWidgetEvents(bus);

    expect(onSpy).toHaveBeenCalledTimes(3);

    cleanupA();
    await bus.emit(WidgetSubjects.register, TEST_WIDGET);
    expect(widgetRegistry.get(TEST_WIDGET.id)).toBeDefined();

    widgetRegistry.clear();
    cleanupB();
    await bus.emit(WidgetSubjects.register, TEST_WIDGET);
    expect(widgetRegistry.get(TEST_WIDGET.id)).toBeUndefined();
  });
});
