// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedRendererConfig } from '../src/renderer/index.js';

const renderSpy = vi.fn();
const unmountSpy = vi.fn();
const createRootSpy = vi.fn(() => ({ render: renderSpy, unmount: unmountSpy }));
const preferencesCleanup = vi.fn();
const registerBrowserPreferencesStorage = vi.fn(() => preferencesCleanup);
const setWindowId = vi.fn();
const transportConstructor = vi.fn(function MockWebSocketClientTransport(
  this: object,
  options: { createWebSocket: (url: string) => unknown; url: string },
) {
  return { options };
});
const unregisterTransport = vi.fn();
const listeners = new Map<string, (ctx: { payload: Record<string, unknown> }) => void>();
const listenerCleanups = new Map<string, ReturnType<typeof vi.fn>>();
const request = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const registerTransport = vi.fn();
const registerNamespaces = vi.fn();
const RENDERER_BOOTSTRAP_TEST_TIMEOUT_MS = 20_000;

vi.mock('react-dom/client', () => ({
  createRoot: createRootSpy,
}));

vi.mock('@makaio/preferences/browser', () => ({
  registerBrowserPreferencesStorage,
}));

vi.mock('@makaio/ui-hooks', () => ({
  useWindowContext: {
    getState: () => ({
      setWindowId,
    }),
  },
}));

vi.mock('@makaio/kernel', () => ({
  BootNamespace: { name: 'kernel:boot' },
  BootSubjects: {
    complete: 'boot.complete',
    getState: 'boot.getState',
    progress: 'boot.progress',
    service: {
      starting: 'boot.service.starting',
    },
  },
  ExtensionNamespace: { name: 'kernel:extension' },
  KernelNamespace: { name: 'kernel' },
}));

vi.mock('@makaio/bus-core', async () => {
  const actual = await vi.importActual<typeof import('@makaio/bus-core')>('@makaio/bus-core');

  return {
    ...actual,
    MakaioBus: {
      ...actual.MakaioBus,
      connect,
      disconnect,
      on: vi.fn((subject: string, listener: (ctx: { payload: Record<string, unknown> }) => void) => {
        listeners.set(subject, listener);
        const cleanup = vi.fn();
        listenerCleanups.set(subject, cleanup);
        return cleanup;
      }),
      registerNamespaces,
      registerTransport,
      request,
    },
  };
});

vi.mock('@makaio/bus-transport-websocket', () => ({
  WebSocketClientTransport: transportConstructor,
}));

vi.mock('@makaio/ui-kernel', () => ({
  UiNamespace: { name: 'ui' },
  UiSubjects: { ready: 'ui.ready', navigate: 'ui.navigate' },
  WidgetNamespace: { name: 'widget' },
}));

vi.mock('@makaio/ui-views', () => ({
  ExtensionBrowserLoader: () => null,
  TrayView: () => null,
}));

function createConfig(overrides: Partial<NormalizedRendererConfig> = {}): NormalizedRendererConfig {
  return {
    bootComplete: false,
    busUrl: 'ws://localhost:6200/bus',
    projectId: 'project-123',
    windowId: 'test.surface:main',
    ...overrides,
  };
}

describe('shared renderer bootstrap', { timeout: RENDERER_BOOTSTRAP_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="loading-label">Idle</div><div id="root"></div>';
    request.mockReset();
    connect.mockReset();
    disconnect.mockReset();
    registerTransport.mockReset();
    registerNamespaces.mockReset();
    unregisterTransport.mockReset();
    registerBrowserPreferencesStorage.mockClear();
    preferencesCleanup.mockClear();
    setWindowId.mockClear();
    transportConstructor.mockClear();
    renderSpy.mockClear();
    unmountSpy.mockClear();
    createRootSpy.mockClear();
    listeners.clear();
    listenerCleanups.clear();
    registerTransport.mockReturnValue({ unregister: unregisterTransport });
  });

  afterEach(() => {
    window.dispatchEvent(new Event('unload'));
    vi.restoreAllMocks();
  });

  it('seeds window context, waits for boot completion, and mounts the shared App', async () => {
    request.mockResolvedValue({
      complete: false,
      completedCount: 1,
      currentService: null,
      totalCount: 3,
    });
    connect.mockResolvedValue(undefined);

    const { bootstrapRenderer } = await import('../src/renderer/bootstrap.js');
    const bootstrapPromise = bootstrapRenderer({
      config: createConfig(),
      logPrefix: 'electrobun-ui',
      surface: 'electrobun',
    });

    await waitFor(() => {
      expect(document.getElementById('loading-label')?.textContent).toBe('Loading services... (1/3)');
    });
    expect(setWindowId).toHaveBeenCalledWith('test.surface:main');
    expect(transportConstructor).toHaveBeenCalledWith({
      createWebSocket: expect.any(Function),
      url: 'ws://localhost:6200/bus',
    });
    expect(registerTransport).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);

    listeners.get('boot.progress')?.({
      payload: {
        completedCount: 2,
        currentService: 'Indexing',
        totalCount: 3,
      },
    });
    expect(document.getElementById('loading-label')?.textContent).toBe('Starting Indexing...');

    listeners.get('boot.complete')?.({ payload: {} });
    await bootstrapPromise;

    expect(registerBrowserPreferencesStorage).toHaveBeenCalledTimes(1);
    expect(createRootSpy).toHaveBeenCalledWith(document.getElementById('root'));
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById('loading-label')?.textContent).toBe('Starting workspace...');

    window.dispatchEvent(new Event('unload'));
    expect(preferencesCleanup).toHaveBeenCalledTimes(1);
    expect(unregisterTransport).toHaveBeenCalledTimes(1);
    expect(unmountSpy).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(listenerCleanups.get('boot.service.starting')).toHaveBeenCalledTimes(1);
    expect(listenerCleanups.get('boot.progress')).toHaveBeenCalledTimes(1);
    expect(listenerCleanups.get('boot.complete')).toHaveBeenCalledTimes(1);
  });

  it('registers renderer-owned namespaces before connecting to the bus', async () => {
    request.mockResolvedValue({
      complete: true,
      completedCount: 0,
      currentService: null,
      totalCount: 0,
    });
    connect.mockResolvedValue(undefined);

    const { startRenderer } = await import('../src/renderer/bootstrap.js');
    await startRenderer({
      config: createConfig(),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    expect(registerNamespaces).toHaveBeenCalledTimes(1);
    expect(registerNamespaces.mock.calls[0]?.[0].map((namespace: { name: string }) => namespace.name)).toEqual([
      'kernel:boot',
      'kernel:extension',
      'host',
      'kernel',
      'preferences',
      'toast',
      'ui',
      'widget',
    ]);
    expect(registerNamespaces.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);

    window.dispatchEvent(new Event('unload'));
  });

  it('tears down an in-flight boot wait when the page unloads', async () => {
    request.mockResolvedValue({
      complete: false,
      completedCount: 1,
      currentService: null,
      totalCount: 3,
    });
    connect.mockResolvedValue(undefined);

    const { bootstrapRenderer } = await import('../src/renderer/bootstrap.js');
    const bootstrapPromise = bootstrapRenderer({
      config: createConfig(),
      logPrefix: 'electrobun-ui',
      surface: 'electrobun',
    });

    await waitFor(() => {
      expect(document.getElementById('loading-label')?.textContent).toBe('Loading services... (1/3)');
    });

    window.dispatchEvent(new Event('unload'));
    await bootstrapPromise;

    expect(registerBrowserPreferencesStorage).not.toHaveBeenCalled();
    expect(createRootSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(unregisterTransport).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(listenerCleanups.get('boot.service.starting')).toHaveBeenCalledTimes(1);
    expect(listenerCleanups.get('boot.progress')).toHaveBeenCalledTimes(1);
    expect(listenerCleanups.get('boot.complete')).toHaveBeenCalledTimes(1);
  });

  it('converts bootstrap failures into splash UI state', async () => {
    request.mockResolvedValue({
      complete: true,
      completedCount: 0,
      currentService: null,
      totalCount: 0,
    });
    const error = new Error('connect failed');
    connect.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { startRenderer } = await import('../src/renderer/bootstrap.js');
    await startRenderer({
      config: createConfig({ projectId: null }),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    expect(consoleError).toHaveBeenCalledWith('[electron-ui] Bootstrap failed', error);
    expect(document.getElementById('loading-label')?.textContent).toBe('Unable to start Makaio');
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('seeds only window identity when the bootstrap config has no project', async () => {
    request.mockResolvedValue({
      complete: true,
      completedCount: 0,
      currentService: null,
      totalCount: 0,
    });
    connect.mockResolvedValue(undefined);

    const { startRenderer } = await import('../src/renderer/bootstrap.js');
    await startRenderer({
      config: createConfig({ projectId: null }),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    expect(setWindowId).toHaveBeenCalledWith('test.surface:main');
  });

  it('treats a missing normalized bus URL as a handled bootstrap failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { startRenderer } = await import('../src/renderer/bootstrap.js');

    await startRenderer({
      config: createConfig({ busUrl: '' }),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    expect(consoleError).toHaveBeenCalledWith(
      '[electron-ui] Bootstrap failed',
      expect.objectContaining({
        message: '[electron-ui] Bootstrap missing bus URL',
      }),
    );
    expect(document.getElementById('loading-label')?.textContent).toBe('Unable to start Makaio');
    expect(connect).not.toHaveBeenCalled();
    expect(registerTransport).not.toHaveBeenCalled();
  });

  it('cleans up the previous renderer lifecycle before a second bootstrap', async () => {
    request.mockResolvedValue({
      complete: true,
      completedCount: 0,
      currentService: null,
      totalCount: 0,
    });
    connect.mockResolvedValue(undefined);
    const { startRenderer } = await import('../src/renderer/bootstrap.js');
    await startRenderer({
      config: createConfig(),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    await startRenderer({
      config: createConfig(),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    expect(preferencesCleanup).toHaveBeenCalledTimes(1);
    expect(unregisterTransport).toHaveBeenCalledTimes(1);
    expect(unmountSpy).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(createRootSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects an in-place rebootstrap that tries to switch window context', async () => {
    request.mockResolvedValue({
      complete: true,
      completedCount: 0,
      currentService: null,
      totalCount: 0,
    });
    connect.mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { startRenderer } = await import('../src/renderer/bootstrap.js');
    await startRenderer({
      config: createConfig(),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    await startRenderer({
      config: createConfig({ projectId: null, windowId: 'test.surface:secondary' }),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    expect(consoleError).toHaveBeenCalledWith(
      '[electron-ui] Bootstrap failed',
      expect.objectContaining({
        message: '[electron-ui] Renderer bootstrap cannot switch window context in-place; reload the page instead',
      }),
    );
  });

  it('joins an in-flight bootstrap for the same renderer identity', async () => {
    request.mockResolvedValue({
      complete: false,
      completedCount: 0,
      currentService: null,
      totalCount: 1,
    });
    connect.mockResolvedValue(undefined);

    const { startRenderer } = await import('../src/renderer/bootstrap.js');
    const firstBootstrap = startRenderer({
      config: createConfig(),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });
    const secondBootstrap = startRenderer({
      config: createConfig(),
      logPrefix: 'electron-ui',
      surface: 'electron',
    });

    expect(registerTransport).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(listeners.has('boot.complete')).toBe(true);
    });
    listeners.get('boot.complete')?.({ payload: {} });
    await Promise.all([firstBootstrap, secondBootstrap]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(createRootSpy).toHaveBeenCalledTimes(1);
  });

  it('mounts after the boot timeout even when boot.getState never resolves', async () => {
    vi.useFakeTimers();

    try {
      request.mockImplementation(() => new Promise(() => undefined));
      connect.mockResolvedValue(undefined);

      const { bootstrapRenderer } = await import('../src/renderer/bootstrap.js');
      const bootstrapPromise = bootstrapRenderer({
        config: createConfig(),
        logPrefix: 'electron-ui',
        surface: 'electron',
      });

      await vi.advanceTimersByTimeAsync(15_000);
      await bootstrapPromise;

      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('loading-label')?.textContent).toBe('Starting workspace...');
    } finally {
      vi.useRealTimers();
    }
  });
});
