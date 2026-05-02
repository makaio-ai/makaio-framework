// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
let currentBus: IMakaioBus | null = null;

const UiSubjects = { ready: 'ui.ready', navigate: 'ui.navigate' };

vi.mock('@makaio/ui-kernel', () => ({
  UiSubjects,
}));

vi.mock('@makaio/ui-hooks', () => ({
  BusProvider: ({ bus, children }: { bus: IMakaioBus; children: ReactNode }) => {
    currentBus = bus;
    return <>{children}</>;
  },
  useBus: () => {
    if (!currentBus) {
      throw new Error('BusProvider has not been initialized');
    }

    return currentBus;
  },
}));

vi.mock('@makaio/ui-views', () => ({
  ExtensionBrowserLoader: () => <div>Shared renderer shell</div>,
}));

describe('shared renderer App', () => {
  afterEach(() => {
    cleanup();
    currentBus = null;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('emits ui.ready once in StrictMode for the provided surface and renders the shared shell', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const bus = { emit } as Pick<IMakaioBus, 'emit'> as IMakaioBus;
    const { App } = await import('../src/renderer/App.js');

    render(
      <StrictMode>
        <App bus={bus} surface="electron" />
      </StrictMode>,
    );

    expect(screen.getByText('Shared renderer shell')).toBeDefined();

    await waitFor(() => {
      expect(emit).toHaveBeenCalledTimes(1);
    });

    expect(emit).toHaveBeenCalledWith(UiSubjects.ready, {
      surface: 'electron',
      timestamp: expect.any(Number),
    });
  });

  it('parameterizes the ui.ready surface literal', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const bus = { emit } as Pick<IMakaioBus, 'emit'> as IMakaioBus;
    const { App } = await import('../src/renderer/App.js');

    render(<App bus={bus} surface="electrobun" />);

    await waitFor(() => {
      expect(emit).toHaveBeenCalledTimes(1);
    });

    expect(emit).toHaveBeenCalledWith(UiSubjects.ready, {
      surface: 'electrobun',
      timestamp: expect.any(Number),
    });
  });

  it('re-emits ui.ready after a real unmount and later remount of the same surface', async () => {
    vi.useFakeTimers();

    try {
      const emit = vi.fn().mockResolvedValue(undefined);
      const bus = { emit } as Pick<IMakaioBus, 'emit'> as IMakaioBus;
      const { App } = await import('../src/renderer/App.js');

      const firstRender = render(<App bus={bus} surface="electron" />);
      await Promise.resolve();
      expect(emit).toHaveBeenCalledTimes(1);

      firstRender.unmount();
      await vi.runAllTimersAsync();

      render(<App bus={bus} surface="electron" />);
      await Promise.resolve();
      expect(emit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows an immediate same-surface remount after explicit cleanup reset', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const bus = { emit } as Pick<IMakaioBus, 'emit'> as IMakaioBus;
    const { App, resetReadySurface } = await import('../src/renderer/App.js');

    const firstRender = render(<App bus={bus} surface="electron" />);
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);

    firstRender.unmount();
    resetReadySurface('electron');

    render(<App bus={bus} surface="electron" />);
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
