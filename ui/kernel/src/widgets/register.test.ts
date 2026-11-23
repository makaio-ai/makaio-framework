import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { widgetRegistry } from './WidgetRegistry.js';
import { WidgetSubjects } from './namespace.js';
import { registerWidget, unregisterWidget } from './register.js';
import type { WidgetDefinition } from './types.js';

const StubComponent = () => null;

function createDefinition(id: string): WidgetDefinition {
  return {
    allowMultiple: false,
    component: StubComponent,
    defaultSize: 'medium',
    description: `Widget ${id}`,
    id,
    name: `Widget ${id}`,
    scope: 'global',
    supportedSizes: ['medium'],
  };
}

describe('widget register helpers', () => {
  it('emits activation metadata when registering an activatable widget', () => {
    const bus = createBusInstance();
    const emitSpy = vi.spyOn(bus, 'emit');
    const call = createTestCall();
    const definition = {
      ...createDefinition('activatable'),
      activate: { pageId: 'settings' },
    };

    expect(registerWidget(call, bus, definition)).toBe(true);

    expect(emitSpy).toHaveBeenCalledWith(
      call,
      WidgetSubjects.register,
      expect.objectContaining({
        activate: { pageId: 'settings' },
      }),
    );
    widgetRegistry.clear();
  });

  it('logs register emit failures instead of leaving unhandled rejections', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = createBusInstance();
    vi.spyOn(bus, 'emit').mockRejectedValueOnce(new Error('register failed'));

    expect(registerWidget(createTestCall(), bus, createDefinition('register-failure'))).toBe(true);
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      '[widget-register] Failed to emit register for "register-failure":',
      expect.any(Error),
    );
    widgetRegistry.clear();
    errorSpy.mockRestore();
  });

  it('logs unregister emit failures instead of leaving unhandled rejections', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = createBusInstance();
    vi.spyOn(bus, 'emit').mockRejectedValueOnce(new Error('unregister failed'));

    widgetRegistry.register(createDefinition('unregister-failure'));
    expect(unregisterWidget(createTestCall(), bus, 'unregister-failure')).toBe(true);
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      '[widget-register] Failed to emit unregister for "unregister-failure":',
      expect.any(Error),
    );
    widgetRegistry.clear();
    errorSpy.mockRestore();
  });
});
