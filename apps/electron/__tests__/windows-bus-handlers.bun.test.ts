/**
 * Tests for registerWindowsBusHandlers.
 *
 * Uses an isolated bus instance (createBusInstance + createBusContext) so
 * tests are independent of the global MakaioBus singleton state.
 * Dependencies are plain function stubs — no WindowManager instance required.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createBusContext, createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { HostSchemas, HostSubjects } from '@makaio/contracts';
import type { WindowState } from '@makaio/host-shared';
import { registerWindowsBusHandlers, type WindowsBusHandlerDeps } from '../src/main/windows-bus-handlers.js';

const DASHBOARD_REGISTRATION_ID = 'framework-shell:main';

/**
 * Minimal valid WindowState for test stubs.
 * @param windowId - Electron BrowserWindow id
 * @param registrationId - Package-qualified window registration ID
 */
function makeWindowState(windowId: number, registrationId: string): WindowState {
  return { windowId, registrationId, visible: true, focused: false };
}

/**
 * Creates a minimal deps stub with controllable window management behaviour.
 * @param existingWindow - When provided, `findWindow` returns this entry to
 *   simulate an already-open window.
 * @param focusedWindowId - The window ID returned by `focusAnyWindow`, or null
 *   if no windows exist (default 7).
 * @param onRestoreFromBackground - Optional callback injected into deps.
 * @returns Stub satisfying the {@link WindowsBusHandlerDeps} interface.
 */
function createDepStub(
  existingWindow?: WindowState,
  focusedWindowId: number | null = 7,
  onRestoreFromBackground?: () => void,
): {
  deps: WindowsBusHandlerDeps;
  createWindow: ReturnType<typeof mock<(registrationId: string) => number>>;
  findWindow: ReturnType<typeof mock<(registrationId: string) => WindowState | undefined>>;
  focusWindow: ReturnType<typeof mock<(windowId: number) => boolean>>;
  focusAnyWindow: ReturnType<typeof mock<() => number | null>>;
  openDefaultWindow: ReturnType<typeof mock<() => number>>;
} {
  const createWindow = mock<(registrationId: string) => number>(() => 42);
  const findWindow = mock<(registrationId: string) => WindowState | undefined>((id: string) =>
    existingWindow && existingWindow.registrationId === id ? existingWindow : undefined,
  );
  const focusWindow = mock<(windowId: number) => boolean>(() => true);
  const focusAnyWindow = mock<() => number | null>(() => focusedWindowId);
  const openDefaultWindow = mock<() => number>(() => 99);

  return {
    deps: {
      createWindow,
      dashboardRegistrationId: DASHBOARD_REGISTRATION_ID,
      findWindow,
      focusWindow,
      focusAnyWindow,
      openDefaultWindow,
      onRestoreFromBackground,
    },
    createWindow,
    findWindow,
    focusWindow,
    focusAnyWindow,
    openDefaultWindow,
  };
}

describe('registerWindowsBusHandlers', () => {
  let bus: IMakaioBus;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    bus = createBusInstance({ context: createBusContext() });
    cleanup = undefined;
  });

  afterEach(() => {
    cleanup?.();
  });

  it('creates a new window when none is open for the dashboard registration', async () => {
    const { deps, createWindow } = createDepStub(undefined);

    cleanup = registerWindowsBusHandlers(bus, deps);

    const result = await bus.request(HostSubjects.window.openDashboard, {});

    expect(createWindow).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith(DASHBOARD_REGISTRATION_ID);
    expect(result.windowId).toBe(42);
  });

  it('focuses the existing window instead of creating a duplicate', async () => {
    const existingWindow = makeWindowState(7, DASHBOARD_REGISTRATION_ID);
    const { deps, createWindow, focusWindow } = createDepStub(existingWindow);

    cleanup = registerWindowsBusHandlers(bus, deps);

    const result = await bus.request(HostSubjects.window.openDashboard, {});

    expect(focusWindow).toHaveBeenCalledOnce();
    expect(focusWindow).toHaveBeenCalledWith(7);
    expect(createWindow).not.toHaveBeenCalled();
    expect(result.windowId).toBe(7);
  });

  it('falls through to createWindow when focusWindow returns false', async () => {
    const existingWindow = makeWindowState(7, DASHBOARD_REGISTRATION_ID);
    const { deps, createWindow, focusWindow } = createDepStub(existingWindow);
    focusWindow.mockReturnValue(false);

    cleanup = registerWindowsBusHandlers(bus, deps);

    const result = await bus.request(HostSubjects.window.openDashboard, {});

    expect(focusWindow).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith(DASHBOARD_REGISTRATION_ID);
    expect(result.windowId).toBe(42);
  });

  it("response shape matches the HostSchemas['window.openDashboard'] contract (number branch)", async () => {
    const { deps } = createDepStub(undefined);
    cleanup = registerWindowsBusHandlers(bus, deps);

    const result = await bus.request(HostSubjects.window.openDashboard, {});

    const parsed = HostSchemas['window.openDashboard'].response.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(typeof parsed.data.windowId).toBe('number');
    }
  });

  it("response shape matches the HostSchemas['window.openDashboard'] contract (null branch)", async () => {
    const { deps } = createDepStub(undefined);
    deps.createWindow = mock(() => {
      throw new Error('Unknown registration');
    });
    cleanup = registerWindowsBusHandlers(bus, deps);

    const result = await bus.request(HostSubjects.window.openDashboard, {});

    const parsed = HostSchemas['window.openDashboard'].response.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.windowId).toBeNull();
    }
  });

  it('returns { windowId: null } when focusWindow throws', async () => {
    const existingWindow = makeWindowState(7, DASHBOARD_REGISTRATION_ID);
    const { deps } = createDepStub(existingWindow);
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    deps.focusWindow = mock(() => {
      throw new Error('Window destroyed');
    });

    try {
      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.window.openDashboard, {});

      const parsed = HostSchemas['window.openDashboard'].response.safeParse(result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.windowId).toBeNull();
      }
      expect(consoleError).toHaveBeenCalledWith(
        '[registerWindowsBusHandlers] Failed to open dashboard window:',
        'Window destroyed',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('teardown unregisters both handlers so subsequent requests go unhandled', async () => {
    const { deps } = createDepStub(undefined);
    const unregister = registerWindowsBusHandlers(bus, deps);

    // Confirm both handlers work before teardown
    await bus.request(HostSubjects.window.openDashboard, {});
    await bus.request(HostSubjects.app.focus, {});

    // Teardown
    unregister();
    cleanup = undefined;

    // After teardown there are no handlers — both requests should throw
    await expect(bus.request(HostSubjects.window.openDashboard, {})).rejects.toThrow();
    await expect(bus.request(HostSubjects.app.focus, {})).rejects.toThrow();
  });

  describe('app.focus', () => {
    it('focuses the most recent window and returns its ID when windows are open', async () => {
      const existingWindow = makeWindowState(7, DASHBOARD_REGISTRATION_ID);
      const { deps, focusAnyWindow } = createDepStub(existingWindow);

      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.app.focus, {});

      expect(focusAnyWindow).toHaveBeenCalledOnce();
      expect(result.focused).toBe(true);
      expect(result.windowId).toBe(7);
    });

    it('returns the focused window ID even when no dashboard window is registered', async () => {
      const { deps, focusAnyWindow } = createDepStub(undefined, 99);

      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.app.focus, {});

      expect(focusAnyWindow).toHaveBeenCalledOnce();
      expect(result.focused).toBe(true);
      expect(result.windowId).toBe(99);
    });

    it('opens the default window when no windows are open', async () => {
      const { deps, focusAnyWindow, openDefaultWindow } = createDepStub(undefined, null);

      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.app.focus, {});

      expect(focusAnyWindow).toHaveBeenCalledOnce();
      expect(openDefaultWindow).toHaveBeenCalledOnce();
      expect(result.focused).toBe(true);
      expect(result.windowId).toBe(99);
    });

    it('returns { focused: false, windowId: null } when openDefaultWindow throws', async () => {
      const { deps, openDefaultWindow } = createDepStub(undefined, null);
      openDefaultWindow.mockImplementation(() => {
        throw new Error('Registry error');
      });

      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.app.focus, {});

      expect(result.focused).toBe(false);
      expect(result.windowId).toBeNull();
    });

    it('returns { focused: false, windowId: null } when onRestoreFromBackground throws', async () => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
      const onRestoreFromBackground = mock<() => void>(() => {
        throw new Error('Dock restore failed');
      });
      const { deps, focusAnyWindow, openDefaultWindow } = createDepStub(undefined, null, onRestoreFromBackground);

      try {
        cleanup = registerWindowsBusHandlers(bus, deps);

        const result = await bus.request(HostSubjects.app.focus, {});

        expect(onRestoreFromBackground).toHaveBeenCalledOnce();
        expect(focusAnyWindow).not.toHaveBeenCalled();
        expect(openDefaultWindow).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledWith(
          '[registerWindowsBusHandlers] Failed to focus app window:',
          'Dock restore failed',
        );
        expect(result.focused).toBe(false);
        expect(result.windowId).toBeNull();
      } finally {
        consoleError.mockRestore();
      }
    });

    it('calls onRestoreFromBackground before opening the default window when no windows are open', async () => {
      const onRestoreFromBackground = mock<() => void>();
      const { deps, openDefaultWindow } = createDepStub(undefined, null, onRestoreFromBackground);

      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.app.focus, {});

      expect(onRestoreFromBackground).toHaveBeenCalledOnce();
      // restore must be called before the window is opened
      expect(onRestoreFromBackground.mock.invocationCallOrder[0]).toBeLessThan(
        openDefaultWindow.mock.invocationCallOrder[0],
      );
      expect(result.focused).toBe(true);
      expect(result.windowId).toBe(99);
    });

    it('calls onRestoreFromBackground even when an existing window is focused', async () => {
      const onRestoreFromBackground = mock<() => void>();
      const { deps } = createDepStub(undefined, 7, onRestoreFromBackground);

      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.app.focus, {});

      expect(onRestoreFromBackground).toHaveBeenCalledOnce();
      expect(result.focused).toBe(true);
      expect(result.windowId).toBe(7);
    });

    it("response shape matches the HostSchemas['app.focus'] contract", async () => {
      const existingWindow = makeWindowState(7, DASHBOARD_REGISTRATION_ID);
      const { deps } = createDepStub(existingWindow);
      cleanup = registerWindowsBusHandlers(bus, deps);

      const result = await bus.request(HostSubjects.app.focus, {});

      const parsed = HostSchemas['app.focus'].response.safeParse(result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.focused).toBe(true);
        expect(typeof parsed.data.windowId).toBe('number');
      }
    });
  });
});
