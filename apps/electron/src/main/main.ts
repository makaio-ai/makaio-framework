/* eslint max-lines: ["error", { "max": 700 }] */
/**
 * Electron main-process composition root.
 *
 * Mirrors the CLI serve composition root (`framework/apps/cli/src/serve.ts`)
 * with desktop chrome layered on top. Creates the HTTP server, delegates all
 * service/adapter/plugin wiring to {@link bootMakaioRuntime}, then wires
 * Electron-specific concerns: windows, tray, notifications, session
 * persistence.
 *
 * The bus server runs in-process — there is no external daemon, no health
 * polling, no disconnect recovery. The renderer connects via WebSocket to
 * `ws://127.0.0.1:<port>/bus`.
 *
 * Desktop chrome bus handlers are extracted to `bus-handlers.ts` to keep this
 * file within the `max-lines` limit while centralising startup/shutdown
 * dependency order here.
 * @packageDocumentation
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { app, BrowserWindow, screen } from 'electron';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { MakaioBus } from '@makaio/bus-core';
import {
  waitForServerListening,
  resolveListeningPort,
  buildNodeRuntimeOptions,
  bootMakaioRuntime,
  NodeFrameworkModuleResolver,
  NoopFrameworkModuleResolver,
  type MakaioRuntime,
  type CoreBootOptions,
  type FrameworkModuleResolver,
  normalizeNodeHostCapabilities,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
} from '@makaio/runtime-node';
import { HostSubjects } from '@makaio/contracts';
import { TrayMenuSubjects, type TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import { LocalNotificationSubjects } from '@makaio/services-core/local-notification/namespace';
import {
  FRAMEWORK_FALLBACK_WINDOW,
  loadWindowSession,
  resolveInitialCustomData,
  resolveInitialWindowState,
  saveWindowSession,
} from '@makaio/host-shared';
import { applySelectedDesktopRuntimeConfig } from '@makaio/host-shared/desktop-runtime-config';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { WindowManager } from './window-manager.js';
import type { CreateWindowOptions } from './window-manager.js';
import { showBootErrorWindow } from './boot-error.js';
import { createTray } from './tray.js';
import { initTrayPopover } from './tray-popover.js';
import { registerAllBusHandlers } from './bus-handlers.js';
import { ElectronNotificationProvider } from './providers/electron-notification-provider.js';
import { resolveDevHostOptions, buildDevHostRuntimeOptions } from './dev-host-options.js';

/** Default TCP port for the in-process bus HTTP server. */
const DEFAULT_PORT = 6252;
const WINDOW_SESSION_SCOPE = 'electron';

const IS_DEV = process.env['NODE_ENV'] !== 'production' && !app.isPackaged;

/**
 * Package root directory.
 *
 * In dev mode (tsx), `import.meta.dirname` is `src/main/` — two levels below
 * the package root. In production (esbuild bundle at `dist/main.mjs`),
 * it is `dist/` — one level below.
 */
const PKG_ROOT = IS_DEV ? path.join(import.meta.dirname, '..', '..') : path.join(import.meta.dirname, '..');

/**
 * Build host-selected desktop runtime options before runtime config overlay.
 * @param makaioHome - Resolved Makaio home directory.
 * @returns Runtime options selected by dev-host or config-backed discovery.
 */
async function buildDesktopBaseRuntimeOptions(makaioHome: string): Promise<Partial<CoreBootOptions>> {
  const devHost = IS_DEV ? resolveDevHostOptions(process.env, { baseDir: resolveWorkspaceRoot(PKG_ROOT) }) : undefined;
  if (IS_DEV && devHost) return buildDevHostRuntimeOptions(devHost, makaioHome);
  return buildNodeRuntimeOptions({ makaioHome, env: process.env });
}

/**
 * Resolve the framework module resolver selected for Electron boot.
 * @param runtimeOptions - Runtime options after desktop config overlay.
 * @returns Resolver allowed for the current environment.
 */
function resolveDesktopFrameworkModuleResolver(
  runtimeOptions: Pick<Partial<CoreBootOptions>, 'frameworkModuleResolver'>,
): FrameworkModuleResolver {
  return (
    runtimeOptions.frameworkModuleResolver ??
    (IS_DEV
      ? new NoopFrameworkModuleResolver()
      : new NodeFrameworkModuleResolver(path.join(process.resourcesPath, 'framework', 'dist')))
  );
}

// ── Single-instance lock ──────────────────────────────────────────────────────
// In production the CLI launcher connects to a known instance, so we must
// enforce exactly one. In dev, multiple instances are normal (orphaned
// processes, test alongside dev, etc.) so skip the lock.

const gotLock = IS_DEV || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // ── State ─────────────────────────────────────────────────────────────────

  let windowManager: WindowManager | null = null;
  let bootPromise: Promise<MakaioRuntime | null> = Promise.resolve(null);
  let httpServer: HttpServer | null = null;
  /**
   * Infrastructure parameters computed during {@link setupInfrastructure},
   * needed to construct the {@link WindowManager} after boot resolves.
   */
  let setupResult: { baseUrl: string; busUrl: string; iconPath: string } | null = null;
  /**
   * Closes the Vite dev server started in dev mode.
   *
   * `null` in production — the Hono/node-server owns the lifecycle there and
   * is closed via `httpServer.close()`.
   */
  let viteClose: (() => Promise<void>) | null = null;

  /**
   * Cleanup callbacks registered by desktop chrome bus handler wiring.
   *
   * Each entry is a function returned by `MakaioBus.on(...)` that removes
   * the handler when called. Iterated in the shutdown path to ensure no
   * orphaned bus listeners remain after the runtime shuts down.
   */
  const busHandlerCleanups: Array<() => void> = [];

  let trayEntries: readonly TrayMenuListEntry[] = [];
  let refreshTrayMenu: (() => void) | null = null;

  /**
   * Tear down the Vite dev server (if running) and the HTTP server.
   *
   * Centralises the cleanup pattern used by the boot-failure catch, the
   * graceful `before-quit` handler, and the fatal-startup catch so they
   * stay in sync.
   */
  async function closeServerInfrastructure(): Promise<void> {
    // Idempotent — null after first call so double-invocation from
    // overlapping shutdown paths does not close already-closed resources.
    const closeVite = viteClose;
    viteClose = null;
    if (closeVite) {
      await closeVite().catch((err: unknown) => {
        console.warn('[electron] Vite close error:', err);
      });
    }

    const server = httpServer;
    httpServer = null;
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // ── Window creation helper ────────────────────────────────────────────────

  /**
   * Create a window and emit bus lifecycle events (opened, closed).
   *
   * This is the canonical window creation path — used by startup, tray,
   * navigation handler, and the `window.create` RPC. All bus event emission
   * around window lifecycle is centralised here.
   * @param options - Window creation options forwarded to WindowManager.
   * @returns The Electron window ID of the created or reused window.
   */
  function createWindow(options: CreateWindowOptions): number {
    const { windowId, isNew } = windowManager!.createWindow(options);

    if (isNew) {
      refreshTrayMenu?.();
      const entry = windowManager!.getWindow(windowId);
      if (entry) {
        MakaioBus.emit(HostSubjects.window.opened, {
          windowId,
          registrationId: entry.registrationId,
          params: entry.params,
          label: entry.label,
          visible: entry.win.isVisible(),
          focused: entry.win.isFocused(),
        }).catch((err: unknown) => {
          console.warn('[electron] Failed to emit window.opened:', err);
        });

        entry.win.on('closed', () => {
          refreshTrayMenu?.();
          MakaioBus.emit(HostSubjects.window.closed, {
            windowId,
            registrationId: entry.registrationId,
            params: entry.params,
          }).catch((err: unknown) => {
            console.warn('[electron] Failed to emit window.closed:', err);
          });
        });
      }
    }

    return windowId;
  }

  // ── Infrastructure setup ──────────────────────────────────────────────────

  /**
   * Start the HTTP/bus server and kick off the runtime boot.
   *
   * Does NOT construct the {@link WindowManager} — that happens in the
   * `app.whenReady()` callback after `bootPromise` resolves, so
   * `windowManager` receives the populated `runtime.windowRegistry` from
   * the coordinator rather than an independent empty instance.
   *
   * Dev mode: Vite is started programmatically via the Node API. The Vite
   * HTTP server becomes `httpServer` so the bus WebSocket upgrade handler
   * attaches to the same server as Vite HMR. Vite handles all renderer HTTP
   * requests; the Hono app's HTTP routes (`/health`, plugin endpoints) are not
   * reachable in dev because Vite owns the request pipeline — only the bus
   * WebSocket transport (raw `httpServer.on('upgrade')`) works in both modes.
   *
   * Production: `@hono/node-server` + `serveStatic` serves the built renderer
   * over `http://` (replaces the former `file://` protocol path). The Hono app
   * handles `/health` and any plugin HTTP routes in production only.
   */
  async function setupInfrastructure(): Promise<void> {
    const iconPath = path.join(PKG_ROOT, 'icons', 'icon.png');

    if (process.platform === 'darwin') {
      app.dock?.setIcon(iconPath);
    }

    const honoApp = new Hono();
    const routeGraph = IS_DEV ? undefined : createHonoRouteGraph(honoApp, { health: () => 'ok' });
    const builder = IS_DEV ? undefined : createHttpRouteGraphBuilder(routeGraph);

    if (IS_DEV) {
      // Dev mode: delegate port selection to the Vite config's get-port()
      // helper, which tries MAKAIO_PORT (or 6252) then falls back to the
      // next free port. This avoids strictPort fail-fast when an orphaned
      // process holds the default port — a normal dev hazard.
      //
      // Do NOT set MAKAIO_BUS_URL before createServer() — the Vite config
      // computes its own fallback from the port it actually binds to.
      // The renderer Vite config includes ViteBusServerPlugin for standalone
      // `yarn dev` (no Electron main process). In dev:electron the main process
      // owns the bus server, so disable the plugin to avoid registering two
      // upgrade handlers on the same HTTP server.
      process.env['VITE_DISABLE_BUS_SERVER'] = 'true';

      const { createServer: createViteServer } = await import('vite');
      const configFile = path.join(PKG_ROOT, 'vite.renderer.config.ts');
      const vite = await createViteServer({
        configFile,
        configLoader: 'runner',
        server: { host: '127.0.0.1' },
      });
      await vite.listen();

      // vite.httpServer is non-null after listen() resolves.
      httpServer = vite.httpServer! as HttpServer;

      // Store Vite teardown for the shutdown path.
      viteClose = (): Promise<void> => vite.close();
    } else {
      // Production: the port must be deterministic — the CLI launcher
      // connects to a known address. Fail-fast if the port is taken
      // (single-instance lock should have caught it already).
      const rawPort = Number(process.env['MAKAIO_PORT']);
      const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535 ? rawPort : DEFAULT_PORT;

      httpServer = createAdaptorServer({ fetch: routeGraph!.fetch }) as HttpServer;
      httpServer.listen(port, '127.0.0.1');
      await waitForServerListening(httpServer, port);
    }

    const boundPort = resolveListeningPort(httpServer!);
    const baseUrl = `http://127.0.0.1:${boundPort}`;
    const busUrl = `ws://127.0.0.1:${boundPort}/bus`;

    // Store for use in whenReady after boot resolves.
    setupResult = { baseUrl, busUrl, iconPath };
    const makaioHome = path.join(os.homedir(), '.makaio');
    const baseRuntimeOptions = await buildDesktopBaseRuntimeOptions(makaioHome);
    const runtimeOptions = await applySelectedDesktopRuntimeConfig(baseRuntimeOptions, {
      makaioHome,
      env: process.env,
    });
    const frameworkModuleResolver = resolveDesktopFrameworkModuleResolver(runtimeOptions);
    if (builder) {
      const rendererDir = path.join(PKG_ROOT, 'dist', 'renderer');
      const { serveStatic } = await import('@hono/node-server/serve-static');
      builder.add({
        owner: '__electron-static',
        phase: 'static-fallback',
        mount: (app) => {
          app.use('/assets/*', serveStatic({ root: rendererDir }));
          app.use('/extensions/*', serveStatic({ root: rendererDir }));
          app.get('*', serveStatic({ root: rendererDir, rewriteRequestPath: () => '/index.html' }));
        },
      });
    }

    bootPromise = bootMakaioRuntime({
      httpServer: httpServer!,
      routeGraphBuilder: builder,
      surface: 'interactive',
      ...runtimeOptions,
      ...(IS_DEV
        ? {}
        : { modelRegistryFallbackSeedPaths: [path.join(process.resourcesPath, 'static/model-registry.yaml')] }),
      frameworkModuleResolver,
      hostCapabilities: normalizeNodeHostCapabilities(runtimeOptions.hostCapabilities),
      onTransportReady({ host, port: readyPort }) {
        // Announce the bound address on stdout — consumed by the E2E test
        // harness for port discovery. This fires after the bus WebSocket
        // upgrade handler is attached, so the port is actually connectable.
        process.stdout.write(`MAKAIO_PORT=${readyPort}\n`);
        console.info('[electron] Bus transport ready on %s:%d', host, readyPort);
      },
    })
      .then((runtime) => {
        routeGraph?.markReady();
        console.info('[electron] Runtime ready (port=%d)', runtime.port);
        return runtime;
      })
      .catch((err: unknown) => {
        // Release the port before the error window shows.
        return closeServerInfrastructure().then(() => {
          showBootErrorWindow(err);
          return null;
        });
      });
  }

  // ── Bus handler registration ──────────────────────────────────────────────

  // ── First window ──────────────────────────────────────────────────────────

  /**
   * Open the fallback framework shell window.
   *
   * Startup overrides are consumed by `openInitialWindows`; every later
   * default-window affordance must reopen the framework shell.
   * @returns The Electron window ID of the created window.
   */
  function openDefaultWindow(): number {
    return createWindow({ registrationId: FRAMEWORK_FALLBACK_WINDOW });
  }

  /**
   * Open the initial window(s) at startup.
   *
   * Priority:
   * 1. `MAKAIO_INITIAL_WINDOW` env override (integration tests, CLI launch).
   * 2. Persisted window session restore.
   * 3. Fallback framework shell window (`framework-shell:main`).
   */
  async function openInitialWindows(): Promise<void> {
    const { registrationId, isOverride } = resolveInitialWindowState();

    if (isOverride) {
      // Environment-driven override (integration tests, CLI launch).
      const customData = resolveInitialCustomData();
      createWindow({
        registrationId,
        params: Object.keys(customData).length > 0 ? customData : undefined,
      });
      return;
    }

    let session: Awaited<ReturnType<typeof loadWindowSession>> = null;
    try {
      session = await loadWindowSession(MakaioBus, WINDOW_SESSION_SCOPE);
    } catch (err: unknown) {
      console.warn('[electron] Failed to load window session:', err);
    }

    if (!session) {
      // No session to restore — open the fallback framework shell window.
      openDefaultWindow();
      return;
    }

    for (const entry of session.windows) {
      try {
        const windowId = createWindow({
          registrationId: entry.registrationId,
          params: entry.params,
        });
        if (entry.bounds) {
          const display = screen.getDisplayMatching(entry.bounds);
          const { workArea } = display;
          // Only restore bounds if they overlap with a live display's work area.
          // Skipping keeps Electron's default placement when a monitor is removed.
          const overlaps =
            entry.bounds.x < workArea.x + workArea.width &&
            entry.bounds.x + entry.bounds.width > workArea.x &&
            entry.bounds.y < workArea.y + workArea.height &&
            entry.bounds.y + entry.bounds.height > workArea.y;
          if (overlaps) {
            const winEntry = windowManager!.getWindow(windowId);
            if (winEntry) winEntry.win.setBounds(entry.bounds);
          }
        }
      } catch (err: unknown) {
        console.warn('[electron] Failed to restore window (registrationId=%s):', entry.registrationId, err);
      }
    }

    // When a stale session contains only removed/renamed registration IDs,
    // every createWindow call above fails silently. Fall back to the default
    // window so the user always sees at least one window on startup.
    if (windowManager!.listWindows().length === 0) {
      openDefaultWindow();
    }
  }

  // ── Shutdown + lifecycle registration ─────────────────────────────────────

  /**
   * Register the `before-quit` shutdown handler and macOS lifecycle hooks.
   * @param destroyTray - Tray teardown callback invoked during shutdown.
   */
  function registerShutdownAndLifecycle(destroyTray: () => void): void {
    let shutdownPromise: Promise<void> | null = null;

    app.on('before-quit', (e) => {
      e.preventDefault();
      if (shutdownPromise) return;

      shutdownPromise = (async () => {
        try {
          if (windowManager) await saveWindowSession(MakaioBus, windowManager, WINDOW_SESSION_SCOPE);
        } catch (err: unknown) {
          console.warn('[electron] Failed to save window session:', err);
        }

        try {
          const runtime = await bootPromise;
          if (runtime) await runtime.shutdown();
        } catch (err: unknown) {
          console.error('[electron] Error during runtime shutdown:', err);
        }

        // Defensive: individual cleanup failures must not prevent subsequent
        // teardown steps (especially httpServer.close) from running.
        for (const cleanup of busHandlerCleanups) {
          try {
            cleanup();
          } catch (cleanupErr: unknown) {
            console.warn('[electron] Bus handler cleanup error:', cleanupErr);
          }
        }

        try {
          destroyTray();
        } catch (trayErr: unknown) {
          console.warn('[electron] Tray teardown error:', trayErr);
        }

        await closeServerInfrastructure();

        app.exit(0);
      })();
    });

    app.on('window-all-closed', () => {
      // Don't quit — the tray keeps the app alive on all platforms.
    });

    // macOS dock click: open (or focus) the fallback framework shell window.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
        openDefaultWindow();
      }
    });
  }

  // ── Boot sequence ─────────────────────────────────────────────────────────

  app.on('second-instance', () => {
    if (windowManager && !windowManager.focusWindow()) {
      openDefaultWindow();
    }
  });

  app
    .whenReady()
    .then(async () => {
      await setupInfrastructure();

      // Await boot before wiring desktop chrome — if boot failed, the
      // boot-error window is already visible and we should not wire tray,
      // bus handlers, or open a default window behind it.
      const runtime = await bootPromise;
      if (!runtime) return;

      // Construct WindowManager with the registry populated during boot.
      // Constructing here (after bootPromise) guarantees that
      // runtime.windowRegistry already contains all package window
      // registrations — a separate pre-boot empty instance would never
      // receive those registrations.
      const { baseUrl, busUrl, iconPath } = setupResult!;

      // Initialise the tray popover renderer config so toggleTrayPopover()
      // can load the SPA with the correct base and bus URLs.
      initTrayPopover(baseUrl, busUrl);

      windowManager = new WindowManager({
        baseUrl,
        busUrl,
        isDev: IS_DEV,
        iconPath,
        windowRegistry: runtime.windowRegistry,
      });

      const notificationProvider = new ElectronNotificationProvider();

      registerAllBusHandlers({
        cleanups: busHandlerCleanups,
        createWindow,
        dashboardRegistrationId: FRAMEWORK_FALLBACK_WINDOW,
        getWindowManager: () => windowManager!,
        getRefreshTrayMenu: () => refreshTrayMenu,
        notificationProvider,
        localNotificationSubjects: LocalNotificationSubjects,
        runtime,
      });

      const { destroy: destroyTray, refreshMenu } = createTray({
        iconPath,
        listWindows: () => windowManager!.listWindows(),
        listRegistrations: () => runtime.windowRegistry.list(),
        getEntries: () => trayEntries,
        focusWindow: (id) => {
          windowManager!.focusWindow(id);
        },
        createWindow: (registrationId) => {
          createWindow({ registrationId });
        },
        onItemClicked: (entry) => {
          MakaioBus.emit(TrayMenuSubjects.item.clicked, {
            packageName: entry.packageName,
            entryId: entry.entryId,
            groupId: entry.groupId,
            metadata: entry.metadata,
          }).catch((err: unknown) => {
            console.warn('[electron] Failed to emit tray item.clicked:', err);
          });
        },
        openDashboard: () => {
          MakaioBus.request(HostSubjects.window.openDashboard, {})
            .then((result) => {
              if (result.windowId === null) {
                console.warn('[electron] Failed to open dashboard from tray menu: no window could be opened');
              }
            })
            .catch((err: unknown) => {
              console.warn('[electron] Failed to open dashboard from tray menu:', err);
            });
        },
      });
      refreshTrayMenu = refreshMenu;

      // Rapid changed events during boot are bounded by the number of
      // packages (typically 3-5) and settle before Electron subscribes
      // (startAll awaits all registrations). No coalescing needed.
      const refreshTrayEntries = async (): Promise<void> => {
        try {
          const result = await MakaioBus.request(TrayMenuSubjects.list, {});
          trayEntries = result.entries;
          refreshTrayMenu?.();
        } catch (err: unknown) {
          console.warn('[electron] Failed to refresh tray entries:', err);
        }
      };

      busHandlerCleanups.push(
        MakaioBus.on(TrayMenuSubjects.changed, () => {
          void refreshTrayEntries();
        }),
      );

      await refreshTrayEntries();

      registerShutdownAndLifecycle(destroyTray);

      await openInitialWindows();
    })
    .catch(async (err: unknown) => {
      console.error('[electron] Fatal startup error:', err);

      // Tear down any partially-initialized infrastructure so the error
      // window is the only thing left running.
      try {
        const runtime = await bootPromise;
        if (runtime) await runtime.shutdown();
      } catch {
        // Ignore — runtime may not have booted.
      }
      for (const cleanup of busHandlerCleanups) {
        try {
          cleanup();
        } catch (cleanupErr: unknown) {
          console.warn('[electron] Bus handler cleanup error:', cleanupErr);
        }
      }
      await closeServerInfrastructure();

      showBootErrorWindow(err);
    });
}
