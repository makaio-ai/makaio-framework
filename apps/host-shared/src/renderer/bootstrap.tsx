/// <reference types="vite/client" />

import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MakaioBus } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import type { WebSocketLike } from '@makaio/bus-transport-websocket';
import type { UiReadyEvent } from '@makaio/ui-kernel';
import { registerBrowserPreferencesStorage } from '@makaio/preferences/browser';
import { BootSubjects } from '@makaio/kernel';
import { useWindowContext } from '@makaio/ui-hooks';
import { App, resetReadySurface } from './App.js';

/**
 * Normalized host renderer config consumed by the shared browser bootstrap.
 */
export interface NormalizedRendererConfig {
  /** WebSocket URL of the bus server. */
  readonly busUrl: string;
  /** Qualified window registration ID, or null for standalone browser tabs. */
  readonly windowId: string | null;
  /** Initial project selection derived from host runtime config. */
  readonly projectId: string | null;
  /** When true, skip the service-boot wait and mount immediately. */
  readonly bootComplete: boolean;
}

/**
 * Shared host renderer bootstrap options.
 */
export interface RendererBootstrapOptions {
  /** Normalized host-local config. */
  readonly config: NormalizedRendererConfig;
  /** Surface identifier emitted by the shared App. */
  readonly surface: UiReadyEvent['surface'];
  /** Prefix used for bootstrap diagnostics. */
  readonly logPrefix: string;
}

/** Maximum time to wait for service boot before mounting React anyway. */
const BOOT_TIMEOUT_MS = 15_000;
let activeRendererCleanup: (() => void) | null = null;
let activeRendererIdentity: { readonly projectId: string | null; readonly windowId: string | null } | null = null;
let activeBootstrapIdentity: { readonly projectId: string | null; readonly windowId: string | null } | null = null;
let activeBootstrapPromise: Promise<void> | null = null;

/**
 * Compare two renderer identities for bootstrap compatibility.
 * @param left - First renderer identity.
 * @param right - Second renderer identity.
 * @returns True when both identities describe the same window context.
 */
function isSameRendererIdentity(
  left: { readonly projectId: string | null; readonly windowId: string | null },
  right: { readonly projectId: string | null; readonly windowId: string | null },
): boolean {
  return left.windowId === right.windowId && left.projectId === right.projectId;
}

/**
 * Update the loading label shown in index.html's static splash.
 * @param text - Status message to display.
 */
function setLoadingLabel(text: string): void {
  console.info(`[state] ${text}`);
  document.getElementById('loading-label')?.replaceChildren(text);
}

/**
 * Seed window-scoped framework state before React mounts.
 * @param config - Normalized renderer config.
 */
function seedWindowContext(config: NormalizedRendererConfig): void {
  const state = useWindowContext.getState();
  state.setWindowId(config.windowId);
}

/**
 * Reject an in-place rebootstrap that tries to switch to a different window context.
 *
 * The shared renderer may restart during HMR or retry flows, but it still
 * represents a single desktop window for the lifetime of the page. Switching
 * to a different window or project requires a full page reload so the tab-scoped
 * stores can reinitialize consistently.
 * @param config - Normalized renderer config for the incoming bootstrap attempt.
 * @param logPrefix - Prefix used for bootstrap diagnostics.
 */
function assertRendererIdentity(config: NormalizedRendererConfig, logPrefix: string): void {
  if (activeRendererIdentity === null) {
    return;
  }

  if (activeRendererIdentity.windowId !== config.windowId || activeRendererIdentity.projectId !== config.projectId) {
    throw new Error(`[${logPrefix}] Renderer bootstrap cannot switch window context in-place; reload the page instead`);
  }
}

/**
 * Register browser-side preferences storage for the renderer lifecycle.
 * @param bus - Renderer bus singleton.
 * @returns Cleanup that unregisters the browser preferences handlers.
 */
function registerPreferencesStorageLifecycle(bus: IMakaioBus): () => void {
  return registerBrowserPreferencesStorage(bus);
}

/**
 * Adapt the browser WebSocket into the transport's duck-typed interface.
 * @param url - WebSocket URL.
 * @returns WebSocketLike wrapper backed by the browser WebSocket.
 */
function createBrowserWebSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);

  return {
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    addEventListener(event, listener) {
      socket.addEventListener(event, listener as EventListener);
    },
    removeEventListener(event, listener) {
      socket.removeEventListener(event, listener as EventListener);
    },
    get readyState() {
      return socket.readyState;
    },
  };
}

interface BootPromiseHandle {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/**
 * Create a promise that resolves when `boot.complete` fires or a timeout expires.
 *
 * Settles at most once: the first call to `settle()` tears down all listeners
 * and further calls are no-ops. `resolvePromise()` must be called alongside
 * `settle()` to fulfill the returned promise.
 * @param bus - Connected bus instance to subscribe on.
 * @param logPrefix - Prefix used for timeout diagnostics.
 * @param signal - Abort signal that resolves the wait when bootstrap is torn down.
 * @returns Promise and manual resolve handle for early completion.
 */
function createBootPromise(bus: IMakaioBus, logPrefix: string, signal?: AbortSignal): BootPromiseHandle {
  let resolvePromise: () => void = () => undefined;
  const cleanups: Array<() => void> = [];
  let settled = false;

  const settle = (): void => {
    if (settled) {
      return;
    }

    settled = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
  };

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  const abortHandler = (): void => {
    settle();
    resolvePromise();
  };

  if (signal?.aborted) {
    abortHandler();
    return {
      promise,
      resolve: abortHandler,
    };
  }

  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', abortHandler));
  }

  const timer = setTimeout(() => {
    console.warn(`[${logPrefix}] Boot timeout - mounting React`);
    settle();
    resolvePromise();
  }, BOOT_TIMEOUT_MS);
  cleanups.push(() => clearTimeout(timer));

  cleanups.push(
    bus.on(BootSubjects.service.starting, (ctx) => {
      if (!settled) {
        setLoadingLabel(`Starting ${ctx.payload.displayName}...`);
      }
    }),
  );

  cleanups.push(
    bus.on(BootSubjects.progress, (ctx) => {
      if (settled) {
        return;
      }

      const { currentService, completedCount, totalCount } = ctx.payload;
      const label = currentService
        ? `Starting ${currentService}...`
        : `Loading services... (${completedCount}/${totalCount})`;
      setLoadingLabel(label);
    }),
  );

  cleanups.push(
    bus.on(BootSubjects.complete, () => {
      settle();
      resolvePromise();
    }),
  );

  return {
    promise,
    resolve: () => {
      settle();
      resolvePromise();
    },
  };
}

/**
 * Wait for service boot to finish, showing progress in the splash label.
 * @param bus - Connected bus instance to query and subscribe on.
 * @param logPrefix - Prefix used for timeout diagnostics.
 * @param signal - Abort signal that resolves the wait when bootstrap is torn down.
 * @returns Promise that resolves when service boot completes or times out.
 */
async function waitForServiceBoot(bus: IMakaioBus, logPrefix: string, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = createBootPromise(bus, logPrefix, signal);

  void bus
    .request(BootSubjects.getState, {})
    .then((state) => {
      if (signal?.aborted) {
        return;
      }

      if (state.complete) {
        resolve();
        return;
      }

      if (state.currentService) {
        setLoadingLabel(`Starting ${state.currentService}...`);
      } else if (state.totalCount > 0) {
        setLoadingLabel(`Loading services... (${state.completedCount}/${state.totalCount})`);
      }
    })
    .catch(() => {
      // boot.getState may not be available yet. Fall through and wait for events.
    });

  await promise;
}

/**
 * Dispose the active renderer lifecycle when the page unloads, hot reloads, or reboots.
 * @returns Cleanup callback that tears down the current renderer lifecycle.
 */
function createRendererCleanup(): (cleanup: () => void) => () => void {
  return (cleanup) => {
    let disposed = false;
    const dispose = (): void => {
      if (disposed) {
        return;
      }

      disposed = true;
      activeRendererCleanup = null;
      activeRendererIdentity = null;
      cleanup();
    };

    const handleUnload = (): void => {
      dispose();
    };

    window.addEventListener('unload', handleUnload, { once: true });

    import.meta.hot?.dispose(() => {
      window.removeEventListener('unload', handleUnload);
      dispose();
    });

    return () => {
      window.removeEventListener('unload', handleUnload);
      dispose();
    };
  };
}

/**
 * Bootstrap the shared host renderer.
 * @param options - Shared bootstrap options.
 * @returns Promise that resolves once the renderer has mounted.
 */
export async function bootstrapRenderer(options: RendererBootstrapOptions): Promise<void> {
  const { config, logPrefix, surface } = options;
  const rendererIdentity = {
    projectId: config.projectId,
    windowId: config.windowId,
  };
  const bootstrapAbortController = new AbortController();

  assertRendererIdentity(config, logPrefix);
  activeRendererCleanup?.();
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Root element not found');
  }

  if (!config.busUrl) {
    throw new Error(`[${logPrefix}] Bootstrap missing bus URL`);
  }

  let transportRegistration: { unregister: () => void } | null = null;
  let preferencesCleanup: (() => void) | null = null;
  let reactRoot: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
  let disposed = false;

  const rollback = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    bootstrapAbortController.abort();
    preferencesCleanup?.();
    reactRoot?.unmount();
    resetReadySurface(surface);
    transportRegistration?.unregister();
    try {
      MakaioBus.disconnect();
    } catch (error) {
      console.warn(`[${logPrefix}] Renderer cleanup disconnect failed`, error);
    }
    activeRendererCleanup = null;
    activeRendererIdentity = null;
  };

  activeRendererCleanup = createRendererCleanup()(rollback);

  setLoadingLabel('Connecting to bus...');

  seedWindowContext(config);
  activeRendererIdentity = rendererIdentity;

  const transport = new WebSocketClientTransport({
    url: config.busUrl,
    createWebSocket: createBrowserWebSocket,
  });

  try {
    transportRegistration = MakaioBus.registerTransport(transport);
    await MakaioBus.connect();

    if (bootstrapAbortController.signal.aborted) {
      return;
    }

    if (config.bootComplete) {
      setLoadingLabel('Starting workspace...');
    } else {
      setLoadingLabel('Loading services...');
      await waitForServiceBoot(MakaioBus, logPrefix, bootstrapAbortController.signal);
      if (bootstrapAbortController.signal.aborted) {
        return;
      }
      setLoadingLabel('Starting workspace...');
    }

    if (bootstrapAbortController.signal.aborted) {
      return;
    }

    preferencesCleanup = registerPreferencesStorageLifecycle(MakaioBus);
    reactRoot = createRoot(root);

    reactRoot.render(
      <StrictMode>
        <App bus={MakaioBus} surface={surface} />
      </StrictMode>,
    );
  } catch (error) {
    if (disposed) {
      return;
    }
    rollback();
    throw error;
  }
}

/**
 * Start the shared host renderer and convert bootstrap failures into splash UI.
 * @param options - Shared bootstrap options.
 * @returns Promise that always resolves after failure handling runs.
 */
export async function startRenderer(options: RendererBootstrapOptions): Promise<void> {
  const rendererIdentity = {
    projectId: options.config.projectId,
    windowId: options.config.windowId,
  };

  if (activeBootstrapPromise !== null) {
    if (activeBootstrapIdentity !== null && isSameRendererIdentity(activeBootstrapIdentity, rendererIdentity)) {
      await activeBootstrapPromise;
      return;
    }

    console.error(
      `[${options.logPrefix}] Bootstrap failed`,
      new Error(
        `[${options.logPrefix}] Renderer bootstrap cannot switch window context in-place; reload the page instead`,
      ),
    );
    setLoadingLabel('Unable to start Makaio');
    return;
  }

  const bootstrapPromise = (async () => {
    try {
      await bootstrapRenderer(options);
    } catch (error) {
      console.error(`[${options.logPrefix}] Bootstrap failed`, error);
      setLoadingLabel('Unable to start Makaio');
    } finally {
      activeBootstrapIdentity = null;
      activeBootstrapPromise = null;
    }
  })();

  activeBootstrapIdentity = rendererIdentity;
  activeBootstrapPromise = bootstrapPromise;
  await bootstrapPromise;
}
