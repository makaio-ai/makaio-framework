import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { HostSubjects } from '@makaio/contracts';
import { FRAMEWORK_FALLBACK_WINDOW, type WindowManagerState } from '@makaio/host-shared';
import { registerElectrobunWindowsBusHandlers } from './windows-bus-handlers.js';

describe('registerElectrobunWindowsBusHandlers', () => {
  const cleanups: Array<() => void> = [];
  let savedInitialWindow: string | undefined;

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    if (savedInitialWindow === undefined) {
      delete process.env['MAKAIO_INITIAL_WINDOW'];
    } else {
      process.env['MAKAIO_INITIAL_WINDOW'] = savedInitialWindow;
    }
  });

  it('opens the framework dashboard instead of the startup override', async () => {
    savedInitialWindow = process.env['MAKAIO_INITIAL_WINDOW'];
    process.env['MAKAIO_INITIAL_WINDOW'] = 'test-app:override';
    const createWindow = vi.fn<(options: { registrationId: string }) => number>(() => 42);

    cleanups.push(
      registerElectrobunWindowsBusHandlers(MakaioBus, {
        createWindow: (registrationId) => createWindow({ registrationId }),
        dashboardRegistrationId: FRAMEWORK_FALLBACK_WINDOW,
        findWindow: vi.fn<() => WindowManagerState | undefined>(() => undefined),
        focusAnyWindow: vi.fn<() => number | null>(() => null),
        focusWindow: vi.fn<() => boolean>(() => false),
        openDefaultWindow: () => createWindow({ registrationId: FRAMEWORK_FALLBACK_WINDOW }),
      }),
    );

    const result = await MakaioBus.request(HostSubjects.window.openDashboard, {});

    expect(result.windowId).toBe(42);
    expect(createWindow).toHaveBeenCalledWith({ registrationId: FRAMEWORK_FALLBACK_WINDOW });
  });

  it('opens the injected default window for app.focus when no window is open', async () => {
    savedInitialWindow = process.env['MAKAIO_INITIAL_WINDOW'];
    process.env['MAKAIO_INITIAL_WINDOW'] = 'test-app:override';
    const createWindow = vi.fn<(options: { registrationId: string }) => number>(() => 99);

    cleanups.push(
      registerElectrobunWindowsBusHandlers(MakaioBus, {
        createWindow: (registrationId) => createWindow({ registrationId }),
        dashboardRegistrationId: FRAMEWORK_FALLBACK_WINDOW,
        findWindow: vi.fn<() => WindowManagerState | undefined>(() => undefined),
        focusAnyWindow: vi.fn<() => number | null>(() => null),
        focusWindow: vi.fn<() => boolean>(() => false),
        openDefaultWindow: () => createWindow({ registrationId: FRAMEWORK_FALLBACK_WINDOW }),
      }),
    );

    const result = await MakaioBus.request(HostSubjects.app.focus, {});

    expect(result).toEqual({ focused: true, windowId: 99 });
    expect(createWindow).toHaveBeenCalledWith({ registrationId: FRAMEWORK_FALLBACK_WINDOW });
  });
});
