import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createBusInstance } from '@makaio/bus-core';
import { pageDefinitionRegistry } from '../pages/PageDefinitionRegistry.js';
import { pageRegistry } from '../pages/PageRegistry.js';
import * as widgetRegisterModule from '../widgets/register.js';
import { widgetRegistry } from '../widgets/WidgetRegistry.js';
import { registerExtensionUI } from './registration-utils.js';
import type { ExtensionBrowserContribution } from './types.js';

const StubComponent = () => null;

describe('registerExtensionUI', () => {
  afterEach(() => {
    pageDefinitionRegistry.clear();
    pageRegistry.clear();
    widgetRegistry.clear();
  });

  it('registers and unregisters page and widget contributions together', () => {
    const bus = createBusInstance();
    const contribution: ExtensionBrowserContribution = {
      pages: [
        {
          defaultContent: {
            main: [
              {
                content: { type: 'widget', widgetId: 'status-widget' },
                instanceId: 'status-widget-default',
                mandatory: true,
              },
            ],
          },
          id: 'dashboard',
          name: 'Dashboard',
          route: '/dashboard',
          scope: 'global',
          slots: [
            {
              acceptsSizes: ['medium', 'large'],
              id: 'main',
              maxColumns: 4,
              minColumnWidth: 240,
              name: 'Main',
            },
          ],
        },
      ],
      widgets: [
        {
          allowMultiple: false,
          component: StubComponent,
          defaultSize: 'medium',
          description: 'Framework status widget',
          id: 'status-widget',
          name: 'Status Widget',
          scope: 'global',
          supportedSizes: ['medium', 'large'],
        },
      ],
    };

    const unregisterAll = registerExtensionUI(bus, 'framework-shell', contribution);

    expect(pageRegistry.get('dashboard')).toBeDefined();
    expect(widgetRegistry.get('status-widget')).toBeDefined();

    unregisterAll();

    expect(pageRegistry.get('dashboard')).toBeUndefined();
    expect(widgetRegistry.get('status-widget')).toBeUndefined();
  });

  it('registers and unregisters pageDefinitions into pageDefinitionRegistry', () => {
    const bus = createBusInstance();
    const contribution: ExtensionBrowserContribution = {
      pageDefinitions: [
        {
          id: 'ext:analytics',
          name: 'Analytics',
          mode: 'switch',
          level: 'any',
          component: async () => ({ default: StubComponent }),
        },
      ],
    };

    const unregisterAll = registerExtensionUI(bus, 'ext', contribution);

    expect(pageDefinitionRegistry.get('ext:analytics')).toBeDefined();
    expect(pageDefinitionRegistry.get('ext:analytics')!.name).toBe('Analytics');

    unregisterAll();

    expect(pageDefinitionRegistry.get('ext:analytics')).toBeUndefined();
  });

  it('returns a no-op cleanup function for empty contributions', () => {
    const bus = createBusInstance();

    const unregisterAll = registerExtensionUI(bus, 'empty-extension', {});
    expect(typeof unregisterAll).toBe('function');
    expect(() => unregisterAll()).not.toThrow();
  });

  it('keeps widget registration idempotent when the widget id is already owned', () => {
    const bus = createBusInstance();
    widgetRegistry.register({
      allowMultiple: false,
      component: StubComponent,
      defaultSize: 'medium',
      description: 'Existing widget',
      id: 'status-widget',
      name: 'Existing Widget',
      scope: 'global',
      supportedSizes: ['medium'],
    });

    const unregisterAll = registerExtensionUI(bus, 'framework-shell', {
      widgets: [
        {
          allowMultiple: false,
          component: StubComponent,
          defaultSize: 'medium',
          description: 'Duplicate widget',
          id: 'status-widget',
          name: 'Duplicate Widget',
          scope: 'global',
          supportedSizes: ['medium'],
        },
      ],
    });

    // Calling unregisterAll on a no-registration result should be safe
    expect(() => unregisterAll()).not.toThrow();
    expect(widgetRegistry.get('status-widget')?.name).toBe('Existing Widget');
  });

  it('rolls back earlier registrations when a later registration throws', () => {
    const bus = createBusInstance();
    const pageDefinitionRegisterSpy = spyOn(pageDefinitionRegistry, 'register').mockImplementation(() => {
      throw new Error('boom');
    });

    try {
      expect(() =>
        registerExtensionUI(bus, 'framework-shell', {
          pages: [
            {
              defaultContent: {
                main: [
                  {
                    content: { type: 'widget', widgetId: 'status-widget' },
                    instanceId: 'status-widget-default',
                    mandatory: true,
                  },
                ],
              },
              id: 'dashboard',
              name: 'Dashboard',
              route: '/dashboard',
              scope: 'global',
              slots: [
                {
                  acceptsSizes: ['medium', 'large'],
                  id: 'main',
                  maxColumns: 4,
                  minColumnWidth: 240,
                  name: 'Main',
                },
              ],
            },
          ],
          pageDefinitions: [
            {
              component: async () => ({ default: StubComponent }),
              id: 'status-page',
              level: 'any',
              mode: 'peek',
              name: 'Status',
            },
          ],
        }),
      ).toThrow('boom');
    } finally {
      pageDefinitionRegisterSpy.mockRestore();
    }

    expect(pageRegistry.get('dashboard')).toBeUndefined();
    expect(pageDefinitionRegistry.get('status-page')).toBeUndefined();
  });

  it('runs rollback cleanups in reverse order and suppresses cleanup failures', () => {
    const bus = createBusInstance();
    const cleanupOrder: string[] = [];
    const pageCleanupError = new Error('page cleanup failed');
    const pageRegisterSpy = spyOn(pageRegistry, 'register').mockImplementation(() => {
      return () => {
        cleanupOrder.push('page');
        throw pageCleanupError;
      };
    });
    const pageDefinitionRegisterSpy = spyOn(pageDefinitionRegistry, 'register').mockImplementation(() => {
      return () => {
        cleanupOrder.push('pageDefinition');
      };
    });
    const registerWidgetSpy = spyOn(widgetRegisterModule, 'registerWidget').mockImplementation(() => {
      throw new Error('widget registration failed');
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() =>
        registerExtensionUI(bus, 'framework-shell', {
          pages: [
            {
              defaultContent: {
                main: [
                  {
                    content: { type: 'widget', widgetId: 'status-widget' },
                    instanceId: 'status-widget-default',
                    mandatory: true,
                  },
                ],
              },
              id: 'dashboard',
              name: 'Dashboard',
              route: '/dashboard',
              scope: 'global',
              slots: [
                {
                  acceptsSizes: ['medium', 'large'],
                  id: 'main',
                  maxColumns: 4,
                  minColumnWidth: 240,
                  name: 'Main',
                },
              ],
            },
          ],
          pageDefinitions: [
            {
              component: async () => ({ default: StubComponent }),
              id: 'status-page',
              level: 'any',
              mode: 'peek',
              name: 'Status',
            },
          ],
          widgets: [
            {
              allowMultiple: false,
              component: StubComponent,
              defaultSize: 'medium',
              description: 'Framework status widget',
              id: 'status-widget',
              name: 'Status Widget',
              scope: 'global',
              supportedSizes: ['medium', 'large'],
            },
          ],
        }),
      ).toThrow('widget registration failed');

      expect(cleanupOrder).toEqual(['pageDefinition', 'page']);
      expect(errorSpy).toHaveBeenCalledWith('[registerExtensionUI] framework-shell Cleanup failed:', pageCleanupError);
    } finally {
      pageRegisterSpy.mockRestore();
      pageDefinitionRegisterSpy.mockRestore();
      registerWidgetSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
