/**
 * Tests for registerHostNavigationHandler.
 *
 * Uses an isolated bus instance (createBusInstance + createBusContext) so
 * tests are independent of the global MakaioBus singleton state.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createBusContext, createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { UiSubjects } from '@makaio/ui-kernel';
import type { WindowManagerState } from '../src/window-session.js';
import type { WindowRegistry } from '@makaio/kernel';
import { registerHostNavigationHandler } from '../src/navigation-handler.js';
import { buildTestRegistry } from './fixtures.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a minimal window-manager stub with controllable list/focus behaviour.
 * @param windows - Initial window list returned by listWindows
 * @returns Stub satisfying the INavigationWindowManager seam
 */
function createWindowManagerStub(windows: WindowManagerState[] = []) {
  return {
    listWindows: mock<() => WindowManagerState[]>(() => windows),
    focusWindow: mock<(windowId: number) => boolean>(() => true),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('registerHostNavigationHandler', () => {
  let bus: IMakaioBus;
  let windowRegistry: WindowRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    bus = createBusInstance({ context: createBusContext() });
    windowRegistry = buildTestRegistry();
  });

  afterEach(() => {
    cleanup?.();
  });

  it('creates a new window for a recognised URL with an empty window list', async () => {
    const createWindow = mock(() => 1);
    const windowManager = createWindowManagerStub();

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    const result = await bus.request(UiSubjects.navigate, {
      url: '/apps/test-app.editor/main?projectId=abc-123',
    });

    expect(createWindow).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith({
      registrationId: 'test-app.editor:main',
      params: { projectId: 'abc-123' },
    });
    expect(result).toEqual({ action: 'opened' });
  });

  it('focuses an existing window when a matching window is already open', async () => {
    const createWindow = mock(() => 42);
    const existingWindow: WindowManagerState = {
      windowId: 42,
      registrationId: 'test-app.editor:main',
      params: { projectId: 'abc-123' },
      visible: true,
      focused: false,
    };
    const windowManager = createWindowManagerStub([existingWindow]);

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    const result = await bus.request(UiSubjects.navigate, {
      url: '/apps/test-app.editor/main?projectId=abc-123',
    });

    expect(windowManager.focusWindow).toHaveBeenCalledOnce();
    expect(windowManager.focusWindow).toHaveBeenCalledWith(42);
    expect(createWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'focused' });
  });

  it('focuses an existing singleton window for a singleton registration', async () => {
    const createWindow = mock(() => 7);
    const existingWindow: WindowManagerState = {
      windowId: 7,
      registrationId: 'test-app.monitor:main',
      visible: true,
      focused: false,
    };
    const windowManager = createWindowManagerStub([existingWindow]);

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    const result = await bus.request(UiSubjects.navigate, { url: '/apps/test-app.monitor/main' });

    expect(windowManager.focusWindow).toHaveBeenCalledOnce();
    expect(windowManager.focusWindow).toHaveBeenCalledWith(7);
    expect(createWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'focused' });
  });

  it('opens a new window when only a session-bound window of the same type is open', async () => {
    // Regression test: a request for a window with no params must NOT focus a
    // session-bound window of the same type — it must open a fresh paramless window.
    const createWindow = mock(() => 99);
    const sessionBoundWindow: WindowManagerState = {
      windowId: 5,
      registrationId: 'test-app.editor:main',
      params: { sessionId: 'existing-session' },
      visible: true,
      focused: true,
    };
    const windowManager = createWindowManagerStub([sessionBoundWindow]);

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    const result = await bus.request(UiSubjects.navigate, { url: '/apps/test-app.editor/main' });

    expect(createWindow).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith({
      registrationId: 'test-app.editor:main',
      params: undefined,
    });
    expect(windowManager.focusWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'opened' });
  });

  it('focuses a window with the matching sessionId', async () => {
    const createWindow = mock(() => 55);
    const matchingWindow: WindowManagerState = {
      windowId: 55,
      registrationId: 'test-app.editor:main',
      params: { sessionId: 'session-456' },
      visible: true,
      focused: false,
    };
    const windowManager = createWindowManagerStub([matchingWindow]);

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    const result = await bus.request(UiSubjects.navigate, {
      url: '/apps/test-app.editor/main?sessionId=session-456',
    });

    expect(windowManager.focusWindow).toHaveBeenCalledOnce();
    expect(windowManager.focusWindow).toHaveBeenCalledWith(55);
    expect(createWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'focused' });
  });

  it('resolves /apps/:packageName/:windowId routes via registry', async () => {
    const createWindow = mock(() => 1);
    const windowManager = createWindowManagerStub();

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    const result = await bus.request(UiSubjects.navigate, { url: '/apps/test-app.dashboard/main' });

    expect(createWindow).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({ registrationId: 'test-app.dashboard:main' }));
    expect(result).toEqual({ action: 'opened' });
  });

  it('falls through for ambiguous /apps/:packageName routes without an explicit window id', async () => {
    const createWindow = mock(() => 1);
    const windowManager = createWindowManagerStub();

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    const fallbackCleanup = bus.on(
      UiSubjects.navigate,
      (ctx) => {
        ctx.setResult({ action: 'navigated' });
      },
      { priority: 0 },
    );

    try {
      const result = await bus.request(UiSubjects.navigate, { url: '/apps/unknown-package' });

      expect(createWindow).not.toHaveBeenCalled();
      expect(windowManager.focusWindow).not.toHaveBeenCalled();
      expect(result).toEqual({ action: 'navigated' });
    } finally {
      fallbackCleanup();
    }
  });

  it('falls through to lower-priority handlers for unrecognised URLs', async () => {
    const createWindow = mock(() => 1);
    const windowManager = createWindowManagerStub();

    cleanup = registerHostNavigationHandler(bus, { createWindow, windowManager, windowRegistry });

    // Register a fallback handler at lower priority to capture the fall-through.
    const fallbackCleanup = bus.on(
      UiSubjects.navigate,
      (ctx) => {
        ctx.setResult({ action: 'navigated' });
      },
      { priority: 0 },
    );

    try {
      const result = await bus.request(UiSubjects.navigate, { url: '/unknown' });

      expect(createWindow).not.toHaveBeenCalled();
      expect(windowManager.focusWindow).not.toHaveBeenCalled();
      expect(result).toEqual({ action: 'navigated' });
    } finally {
      fallbackCleanup();
    }
  });
});
