import { describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { widgetRegistry } from './WidgetRegistry.js';
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
    const bus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMakaioBus;
    const definition = {
      ...createDefinition('activatable'),
      activate: { pageId: 'settings' },
    };

    expect(registerWidget(bus, definition)).toBe(true);

    expect(bus.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        activate: { pageId: 'settings' },
      }),
    );
    widgetRegistry.clear();
  });

  it('logs register emit failures instead of leaving unhandled rejections', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = {
      emit: vi.fn().mockRejectedValue(new Error('register failed')),
    } as unknown as IMakaioBus;

    expect(registerWidget(bus, createDefinition('register-failure'))).toBe(true);
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
    const bus = {
      emit: vi.fn().mockRejectedValue(new Error('unregister failed')),
    } as unknown as IMakaioBus;

    widgetRegistry.register(createDefinition('unregister-failure'));
    expect(unregisterWidget(bus, 'unregister-failure')).toBe(true);
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      '[widget-register] Failed to emit unregister for "unregister-failure":',
      expect.any(Error),
    );
    widgetRegistry.clear();
    errorSpy.mockRestore();
  });
});
