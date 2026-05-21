// @vitest-environment jsdom
import { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { BusProvider } from '@makaio/ui-hooks';
import type { UiContextSnapshot } from '@makaio/contracts';
import type { WidgetProps } from '@makaio/ui-kernel';
import { ExtensionSubjects, KernelSubjects, type ExtensionInfo } from '@makaio/kernel';
import { frameworkStatusWidgetDefinition } from './StatusWidget.js';

const TEST_UI_CONTEXT: UiContextSnapshot = {
  level: 'root',
  values: {},
};

const BASE_PROPS: Omit<WidgetProps, 'size'> = {
  config: {},
  uiContext: TEST_UI_CONTEXT,
  updateConfig: () => {},
};

function renderStatusWidget(bus: IMakaioBus, size: WidgetProps['size']) {
  return render(
    createElement(BusProvider, {
      bus,
      children: createElement(frameworkStatusWidgetDefinition.component, {
        ...BASE_PROPS,
        size,
      }),
    }),
  );
}

/**
 * Build a minimal extension record for `ExtensionSubjects.list`.
 * @param overrides - Partial extension fields for the fixture.
 * @returns Extension info fixture.
 */
function makeExtensionInfo(overrides: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    displayName: 'Example Extension',
    enabled: true,
    name: 'example-extension',
    state: 'active',
    ...overrides,
  };
}

describe('StatusWidget', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    bus = createBusInstance();
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
  });

  it('renders the compact machine ID without loading extension state in small mode', async () => {
    let extensionListCalls = 0;
    const machineId = 'machine-abcdef1234567890';
    const expectedCompact = machineId.slice(0, 7);

    subscriptions.push(
      bus.on(KernelSubjects.isReady, (ctx) => {
        ctx.setResult({ ready: true, machineId });
      }),
    );
    subscriptions.push(
      bus.on(ExtensionSubjects.list, () => {
        extensionListCalls += 1;
        throw new Error('small mode should not request extension state');
      }),
    );

    renderStatusWidget(bus, 'small');

    await waitFor(() => {
      expect(screen.getByTestId('status-compact-row')).toBeInTheDocument();
      expect(screen.getByText(expectedCompact)).toBeInTheDocument();
    });
    expect(screen.queryByText(machineId)).toBeNull();
    expect(extensionListCalls).toBe(0);
  });

  it('reloads extension state after an initial snapshot failure once a stateChanged event arrives', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let listCalls = 0;

    subscriptions.push(
      bus.on(KernelSubjects.isReady, (ctx) => {
        ctx.setResult({ ready: true, machineId: 'machine-abcdef1234567890' });
      }),
    );
    subscriptions.push(
      bus.on(ExtensionSubjects.list, (ctx) => {
        listCalls += 1;
        if (listCalls === 1) {
          throw new Error('snapshot failed');
        }

        ctx.setResult({
          extensions: [makeExtensionInfo({ displayName: 'Recovered Extension', name: 'recovered-extension' })],
        });
      }),
    );

    try {
      renderStatusWidget(bus, 'large');

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('[StatusWidget] Failed to load extension status', expect.any(Error));
      });

      await bus.emit(ExtensionSubjects.stateChanged, {
        displayName: 'Recovered Extension',
        from: 'discovered',
        name: 'recovered-extension',
        to: 'active',
      });

      await waitFor(() => {
        expect(screen.getByText('Recovered Extension')).toBeInTheDocument();
      });
      expect(listCalls).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('refreshes the authoritative list when a new extension was not part of the last snapshot', async () => {
    let listCalls = 0;

    subscriptions.push(
      bus.on(KernelSubjects.isReady, (ctx) => {
        ctx.setResult({ ready: true, machineId: 'machine-abcdef1234567890' });
      }),
    );
    subscriptions.push(
      bus.on(ExtensionSubjects.list, (ctx) => {
        listCalls += 1;
        ctx.setResult({
          extensions:
            listCalls === 1
              ? [makeExtensionInfo({ displayName: 'Existing Extension', name: 'existing-extension' })]
              : [
                  makeExtensionInfo({ displayName: 'Existing Extension', name: 'existing-extension' }),
                  makeExtensionInfo({ displayName: 'New Extension', name: 'new-extension', state: 'failed' }),
                ],
        });
      }),
    );

    renderStatusWidget(bus, 'large');

    await waitFor(() => {
      expect(screen.getByText('Existing Extension')).toBeInTheDocument();
    });

    await bus.emit(ExtensionSubjects.stateChanged, {
      displayName: 'New Extension',
      error: 'Failed to initialize',
      from: 'initializing',
      name: 'new-extension',
      to: 'failed',
    });

    await waitFor(() => {
      expect(screen.getByText('New Extension')).toBeInTheDocument();
    });
    expect(listCalls).toBe(2);
  });
});
