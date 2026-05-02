/* @vitest-environment jsdom */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createBusInstance } from '@makaio/bus-core';
import { BusProvider } from '@makaio/ui-hooks';
import { pageDefinitionRegistry, pageRegistry, widgetRegistry } from '@makaio/ui-kernel';
import { TrayView } from '../tray-view.js';

vi.mock('@makaio/ui-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/ui-hooks')>();
  return {
    ...actual,
    loadExtensionBrowserContributions: vi.fn(async (options) => {
      const contribution = {
        widgets: [
          {
            component: () => createElement('div', { 'data-testid': 'loaded-from-extension' }),
            defaultSize: 'small',
            id: 'test-extension:tray-widget',
            name: 'Extension Tray Widget',
            scope: 'tray',
            supportedSizes: ['small'],
          },
          {
            component: () => createElement('div', { 'data-testid': 'non-tray-widget' }),
            defaultSize: 'small',
            id: 'test-extension:dashboard-widget',
            name: 'Extension Dashboard Widget',
            scope: 'global',
            supportedSizes: ['small'],
          },
        ],
        pages: [
          {
            defaultContent: {},
            id: 'test-extension:page',
            name: 'Hidden From Tray',
            scope: 'global',
            slots: [],
          },
        ],
        pageDefinitions: [
          {
            component: async () => ({ default: () => createElement('div') }),
            id: 'test-extension:hidden-definition',
            level: 'any',
            mode: 'switch',
            name: 'Hidden Definition',
          },
        ],
      };

      const cleanup = options.registerExtensionUI(options.bus, 'test-extension', contribution);

      return {
        cleanups: [cleanup],
        errorMessage: null,
        shell: null,
        state: 'ready',
      };
    }),
  };
});

function renderTrayView() {
  const bus = createBusInstance();
  return render(
    createElement(BusProvider, {
      bus,
      children: createElement(TrayView),
    }),
  );
}

describe('TrayView extension contribution loading', () => {
  afterEach(() => {
    pageDefinitionRegistry.clear();
    pageRegistry.clear();
    widgetRegistry.clear();
  });

  it('renders tray widgets contributed by browser extensions', async () => {
    renderTrayView();

    await waitFor(() => {
      expect(screen.getByTestId('loaded-from-extension')).toBeInTheDocument();
    });
  });

  it('unregisters extension-contributed tray widgets on unmount', async () => {
    const { unmount } = renderTrayView();

    await waitFor(() => {
      expect(widgetRegistry.has('test-extension:tray-widget')).toBe(true);
    });

    unmount();

    expect(widgetRegistry.has('test-extension:tray-widget')).toBe(false);
  });

  it('does not register non-tray browser contributions into the tray renderer', async () => {
    renderTrayView();

    await waitFor(() => {
      expect(widgetRegistry.has('test-extension:tray-widget')).toBe(true);
    });

    expect(widgetRegistry.has('test-extension:dashboard-widget')).toBe(false);
    expect(pageDefinitionRegistry.get('test-extension:hidden-definition')).toBeUndefined();
    expect(pageRegistry.get('test-extension:page')).toBeUndefined();
  });
});
