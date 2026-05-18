/* eslint max-lines: ["error", { "max": 750 }] */
/**
 * Electrobun main-process composition root.
 *
 * Mirrors the Electron composition root (`apps/electron/src/main/main.ts`)
 * with the Bun-native Electrobun desktop runtime layered on top. Delegates all
 * service/adapter/plugin wiring to the platform boot, then wires
 * Electrobun-specific concerns: windows, tray, session persistence.
 *
 * In dev mode, Vite owns the HTTP server and the bus WebSocket upgrade handler
 * attaches to it via the Node-platform transport (same single-port pattern as
 * Electron). In production, `Bun.serve()` with the Bun-native transport runs
 * both renderer serving and bus on one port.
 *
 * Key differences from the Electron composition root:
 * - Production uses `Bun.serve()` and `hono/bun` instead of `@hono/node-server`.
 * - Config is injected into windows via URL query params (no preload/contextBridge).
 * - In production, a health-probe singleton check runs at startup; in dev mode multiple instances are allowed.
 * - Shutdown is handled via `process.on('SIGTERM')` and `process.on('SIGINT')`.
 * @packageDocumentation
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server as HttpServer } from 'node:http';
import { Hono } from 'hono';
import { MakaioBus } from '@makaio/bus-core';
import {
  bootMakaioRuntime as bootBunRuntime,
  BunBusServerTransportProvider,
  createBunRouteGraphFetch,
  type MakaioRuntime,
} from '@makaio/runtime-bun';
import {
  buildNodeRuntimeOptions,
  buildConfiguredRuntimeOptions,
  bootMakaioRuntime as bootNodeRuntime,
  NoopFrameworkModuleResolver,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
  normalizeNodeHostCapabilities,
  type CoreBootOptions,
  type FrameworkModuleResolver,
  type HonoRouteGraph,
} from '@makaio/runtime-node';
import { HostSubjects } from '@makaio/contracts';
import { TrayMenuSubjects, type TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import { FRAMEWORK_FALLBACK_WINDOW, saveWindowSession, createDevHealthPlugin } from '@makaio/host-shared';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import Electrobun, { GlobalShortcut } from 'electrobun/bun';
import { applySelectedDesktopRuntimeConfig } from '@makaio/host-shared/desktop-runtime-config';
import { WindowManager } from './window-manager.js';
import type { CreateWindowOptions } from './window-manager.js';
import { createTray } from './tray.js';
import { initTrayPopover, showTrayPopover, toggleTrayPopover } from './tray-popover.js';
import { resolveDevHostOptions, buildDevHostRuntimeOptions } from './dev-host-options.js';
import { createAutoLaunchController } from './auto-launch-controller.js';
import { registerBusHandlers } from './bus-handlers.js';
import { openInitialWindows } from './initial-windows.js';

// ESM-compatible __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default TCP port for the in-process bus HTTP server. */
const DEFAULT_PORT = 6252;
const WINDOW_SESSION_SCOPE = 'electrobun';

const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Package root directory — resolved at build time via `define` in `build.ts`.
 * Inside the `.app` bundle, `import.meta.dirname` points at
 * `Contents/Resources/app/bun/` which breaks `resolveWorkspaceRoot`. The
 * compile-time constant captures the real package directory.
 */
declare const __ELECTROBUN_PROJECT_ROOT__: string;

/**
 * Framework version — resolved at build time via `define` in `build.ts`.
 * `readFrameworkVersion()` resolves `package.json` relative to `import.meta.url`
 * which is meaningless inside the Bun bundle. The compile-time constant captures
 * the version from `@makaio/runtime-node/package.json` at build time.
 */
declare const __FRAMEWORK_VERSION__: string;

/**
 * Default MAKAIO_HOME directory name — resolved at build time from the release track.
 * Stable builds use `.makaio`; canary builds use `.makaio-canary`.
 * The user can still override via the `MAKAIO_HOME` environment variable.
 */
declare const __MAKAIO_HOME_DEFAULT__: string;
const PKG_ROOT =
  typeof __ELECTROBUN_PROJECT_ROOT__ !== 'undefined'
    ? __ELECTROBUN_PROJECT_ROOT__
    : IS_DEV
      ? (process.env['MAKAIO_ELECTROBUN_PKG_ROOT'] ?? path.join(__dirname, '..', '..'))
      : path.join(__dirname, '..');

/**
 * Build host-selected desktop runtime options before runtime config overlay.
 * @param makaioHome - Resolved Makaio home directory.
 * @returns Runtime options selected by dev-host or config-backed discovery.
 */
async function buildDesktopBaseRuntimeOptions(makaioHome: string): Promise<Partial<CoreBootOptions>> {
  const devHost = IS_DEV ? resolveDevHostOptions(process.env, { baseDir: resolveWorkspaceRoot(PKG_ROOT) }) : undefined;
  if (IS_DEV && devHost) return buildDevHostRuntimeOptions(devHost, makaioHome);
  if (IS_DEV) return buildNodeRuntimeOptions({ makaioHome, env: process.env });
  return buildConfiguredRuntimeOptions({ makaioHome, env: process.env });
}

/**
 * Resolve the framework module resolver selected for desktop boot.
 * @param runtimeOptions - Runtime options after desktop config overlay.
 * @returns Resolver allowed for the current environment.
 */
function resolveDesktopFrameworkModuleResolver(
  runtimeOptions: Pick<CoreBootOptions, 'frameworkModuleResolver'>,
): FrameworkModuleResolver {
  return runtimeOptions.frameworkModuleResolver ?? new NoopFrameworkModuleResolver();
}

/**
 * Resolve the bundled framework package root for production extension loading.
 * @returns App-bundled `@makaio/framework` package root, or undefined in dev.
 */
function resolveDesktopFrameworkPackagePath(): string | undefined {
  return IS_DEV ? undefined : path.join(PKG_ROOT, 'node_modules', '@makaio', 'framework');
}

// ── State ─────────────────────────────────────────────────────────────────────

let windowManager: WindowManager | null = null;
let bootPromise: Promise<MakaioRuntime | null> = Promise.resolve(null);

/**
 * Whether the process was started in background-only mode (`--background`).
 *
 * Set to `true` on startup when the flag is present and reset to `false` by
 * {@link restoreFromBackgroundMode} the first time the app is brought to the
 * foreground.
 */
let isBackgroundMode = process.argv.includes('--background');
const startedInBackgroundMode = isBackgroundMode;

// Hide the Dock icon immediately when started in background-only mode so
// the app never appears in the Dock before the first window is opened.
if (isBackgroundMode) {
  Electrobun.Utils.setDockIconVisible(false);
}

/**
 * Upgrade from background-only mode to regular (visible) mode.
 *
 * Restores the macOS Dock icon and clears the background-mode flag. Safe to
 * call multiple times — idempotent once the flag is already `false`.
 */
function restoreFromBackgroundMode(): void {
  if (!isBackgroundMode) return;
  Electrobun.Utils.setDockIconVisible(true);
  isBackgroundMode = false;
}

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
let viteClose: (() => Promise<void>) | null = null;

// ── Cleanup ───────────────────────────────────────────────────────────────────

/**
 * Tear down bus handlers, runtime, tray, and Vite dev server.
 *
 * Centralises the cleanup pattern used by the graceful shutdown handlers so
 * they stay in sync. Safe to call multiple times — idempotent after first call.
 * @param destroyTray - Tray teardown callback invoked during shutdown.
 */
async function shutdownGracefully(destroyTray: (() => void) | null): Promise<void> {
  if (windowManager) {
    try {
      await saveWindowSession(MakaioBus, windowManager, WINDOW_SESSION_SCOPE);
    } catch (err: unknown) {
      console.warn('[electrobun] Failed to save window session:', err);
    }
  }

  try {
    const runtime = await bootPromise;
    if (runtime) await runtime.shutdown();
  } catch (err: unknown) {
    console.error('[electrobun] Error during runtime shutdown:', err);
  }

  // Defensive: individual cleanup failures must not prevent subsequent teardown.
  for (const cleanup of busHandlerCleanups) {
    try {
      cleanup();
    } catch (cleanupErr: unknown) {
      console.warn('[electrobun] Bus handler cleanup error:', cleanupErr);
    }
  }

  try {
    destroyTray?.();
  } catch (trayErr: unknown) {
    console.warn('[electrobun] Tray teardown error:', trayErr);
  }

  try {
    await viteClose?.();
  } catch (viteErr: unknown) {
    console.warn('[electrobun] Vite close error:', viteErr);
  }
}

// ── Window creation helper ────────────────────────────────────────────────────

/**
 * Create a window and emit bus lifecycle events (opened, closed).
 *
 * This is the canonical window creation path — used by startup, tray,
 * navigation handler, and the `window.create` RPC. All bus event emission
 * around window lifecycle is centralised here.
 * @param options - Window creation options forwarded to WindowManager.
 * @returns The Electrobun window ID of the created or reused window.
 */
function createWindow(options: CreateWindowOptions): number {
  restoreFromBackgroundMode();
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
        console.warn('[electrobun] Failed to emit window.opened:', err);
      });

      // Wire the closed event through the proxy's event listener.
      // The proxy itself tracks destruction via the `close` event internally;
      // we additionally emit the bus event for external consumers.
      entry.win.browserWindow.on(`close`, () => {
        refreshTrayMenu?.();
        MakaioBus.emit(HostSubjects.window.closed, {
          windowId,
          registrationId: entry.registrationId,
          params: entry.params,
        }).catch((err: unknown) => {
          console.warn('[electrobun] Failed to emit window.closed:', err);
        });
      });
    }
  }

  return windowId;
}

// ── First window ──────────────────────────────────────────────────────────────

/**
 * Open the fallback framework shell window.
 *
 * Startup overrides are consumed by {@link openInitialWindows}; every later
 * default-window affordance must reopen the framework shell.
 * @returns The window ID of the created window.
 */
function openDefaultWindow(): number {
  return createWindow({ registrationId: FRAMEWORK_FALLBACK_WINDOW });
}

(async () => {
  try {
    const rawPort = Number(process.env['MAKAIO_PORT']);
    const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535 ? rawPort : DEFAULT_PORT;

    if (!IS_DEV) {
      const { probeHealth } = await import('../health-probe.js');
      const health = await probeHealth(port);
      if (health) {
        let focused = false;
        try {
          const { connectAndFocus } = await import('../second-instance.js');
          focused = await connectAndFocus(port, health);
        } catch (err) {
          console.warn('[electrobun] Failed to focus existing instance:', err);
        }
        const status = focused ? 'Focused existing instance' : 'Existing instance detected but focus did not complete';
        const log = focused ? console.info : console.warn;
        log(`[electrobun] ${status} - exiting.`);
        process.exit(0);
      }
    }

    const honoApp = new Hono();

    const makaioHomeDefault = typeof __MAKAIO_HOME_DEFAULT__ !== 'undefined' ? __MAKAIO_HOME_DEFAULT__ : '.makaio';
    const makaioHome = process.env['MAKAIO_HOME']?.trim() || path.join(os.homedir(), makaioHomeDefault);
    if (!process.env['MAKAIO_HOME']?.trim()) {
      process.env['MAKAIO_HOME'] = makaioHome;
    }
    const baseRuntimeOptions = await buildDesktopBaseRuntimeOptions(makaioHome);
    const runtimeOptions = await applySelectedDesktopRuntimeConfig(baseRuntimeOptions, {
      makaioHome,
      env: process.env,
    });
    const runtimeHostCapabilities = IS_DEV
      ? normalizeNodeHostCapabilities(runtimeOptions.hostCapabilities)
      : runtimeOptions.hostCapabilities;
    const frameworkModuleResolver = resolveDesktopFrameworkModuleResolver(runtimeOptions);
    const frameworkPackagePath = resolveDesktopFrameworkPackagePath();

    const commonBootOptions = {
      surface: 'interactive' as const,
      ...runtimeOptions,
      ...(runtimeHostCapabilities !== undefined ? { hostCapabilities: runtimeHostCapabilities } : {}),
      frameworkVersion: typeof __FRAMEWORK_VERSION__ !== 'undefined' ? __FRAMEWORK_VERSION__ : undefined,
      frameworkModuleResolver,
      frameworkPackagePath,
      onTransportReady({ host, port: readyPort }: { host: string; port: number }) {
        process.stdout.write(`MAKAIO_PORT=${readyPort}\n`);
        console.info('[electrobun] Bus transport ready on %s:%d', host, readyPort);
      },
    };

    let boundPort: number;
    let routeGraph: HonoRouteGraph | undefined;

    if (IS_DEV) {
      // Single-port dev: Vite owns the HTTP server. The bus WebSocket
      // upgrade handler attaches to the same server via runtime-node's
      // ws-based transport — the same pattern as the Electron composition
      // root. Renderer content, HMR, and the bus share one port.
      process.env['VITE_DISABLE_BUS_SERVER'] = 'true';
      const { createServer: createViteServer } = await import('vite');
      const configFile = path.join(PKG_ROOT, 'vite.renderer.config.ts');
      const vite = await createViteServer({
        configFile,
        configLoader: 'runner',
        server: { host: '127.0.0.1', port },
        plugins: [createDevHealthPlugin()],
      });
      await vite.listen();
      const httpServer = vite.httpServer!;
      const viteAddress = httpServer.address();
      boundPort = typeof viteAddress === 'object' && viteAddress ? viteAddress.port : port;
      viteClose = () => vite.close();
      console.info('[electrobun] Vite dev server listening on http://127.0.0.1:%d', boundPort);

      bootPromise = bootNodeRuntime({
        httpServer: httpServer as HttpServer,
        ...commonBootOptions,
      });
    } else {
      // Production: Bun.serve() with Bun-native WebSocket transport.
      routeGraph = createHonoRouteGraph(honoApp, { health: () => 'ok' });
      const builder = createHttpRouteGraphBuilder(routeGraph);

      // Register the static-fallback contribution before boot so renderer
      // assets are available as soon as the route graph is marked ready.
      const distDir = path.join(PKG_ROOT, 'dist', 'renderer');
      const { serveStatic } = await import('hono/bun');
      builder.add({
        owner: '__electrobun-static',
        phase: 'static-fallback',
        mount: (app) => {
          app.use('/assets/*', serveStatic({ root: distDir }));
          app.use('/extensions/*', serveStatic({ root: distDir }));
          app.get('*', serveStatic({ root: distDir, rewriteRequestPath: () => '/index.html' }));
        },
      });

      // Create the Bun-native bus transport and extract the WebSocket handler
      // before starting the server so it is wired into Bun.serve() immediately.
      const transport = new BunBusServerTransportProvider({
        auth: commonBootOptions.auth,
        loopbackName: commonBootOptions.loopbackName ?? 'bun',
      });
      const websocket = transport.createWebSocketHandler();

      const rawServer = Bun.serve({
        fetch: createBunRouteGraphFetch(routeGraph),
        websocket,
        port,
        hostname: '127.0.0.1',
      });
      boundPort = rawServer.port;
      const bunServer = { port: boundPort, hostname: rawServer.hostname };

      bootPromise = bootBunRuntime({ transport, bunServer, routeGraphBuilder: builder, ...commonBootOptions });
    }

    const baseUrl = `http://127.0.0.1:${boundPort}`;
    const busUrl = `ws://127.0.0.1:${boundPort}/bus`;

    // Initialise the tray popover with the resolved URLs so that subsequent
    // toggleTrayPopover() calls can construct the correct SPA URL.
    initTrayPopover(baseUrl, busUrl);

    process.stdout.write(`MAKAIO_PORT=${boundPort}\n`);
    console.info('[electrobun] Server listening on %s', baseUrl);

    bootPromise = bootPromise
      .then((runtime) => {
        if (runtime === null) {
          return null;
        }
        routeGraph?.markReady();
        console.info('[electrobun] Runtime ready (port=%d)', runtime.port);
        return runtime;
      })
      .catch((err: unknown) => {
        console.error('[electrobun] Boot failed:', err);
        return null;
      });

    const runtime = await bootPromise;
    if (!runtime) {
      await shutdownGracefully(null);
      console.error('[electrobun] Boot failed — exiting.');
      process.exit(1);
    }

    windowManager = new WindowManager({
      port: boundPort,
      isDev: IS_DEV,
      windowRegistry: runtime.windowRegistry,
    });
    windowManager.setBootComplete();

    registerBusHandlers({
      busHandlerCleanups,
      createWindow,
      localNotificationProvider: undefined,
      openDefaultWindow,
      refreshTrayMenu: () => refreshTrayMenu?.(),
      showTrayPopover,
      runtime,
      windowManager,
      onRestoreFromBackground: restoreFromBackgroundMode,
    });

    let shutdownInProgress = false;
    let destroyTray: (() => void) | null = null;

    const handleShutdown = (): void => {
      if (shutdownInProgress) return;
      shutdownInProgress = true;

      shutdownGracefully(destroyTray)
        .catch((err: unknown) => {
          console.error('[electrobun] Shutdown error:', err);
        })
        .finally(() => {
          process.exit(0);
        });
    };

    const autoLaunchController = createAutoLaunchController({
      refreshTrayMenu: () => refreshTrayMenu?.(),
    });

    const trayHandle = createTray({
      iconPath: path.join(PKG_ROOT, 'icons', 'tray-icon@2x.png'),
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
          console.warn('[electrobun] Failed to emit tray item.clicked:', err);
        });
      },
      openDashboard: () => {
        MakaioBus.request(HostSubjects.window.openDashboard, {})
          .then((result) => {
            if (result.windowId === null) {
              console.warn('[electrobun] Failed to open dashboard from tray menu: no window could be opened');
            }
          })
          .catch((err: unknown) => {
            console.warn('[electrobun] Failed to open dashboard from tray menu:', err);
          });
      },
      onQuit: handleShutdown,
      get autoLaunchEnabled() {
        return autoLaunchController.enabled;
      },
      toggleAutoLaunch: () => autoLaunchController.toggle(),
    });
    refreshTrayMenu = trayHandle.refreshMenu;

    // Global shortcut: toggle the popover (centred on primary display when no anchor).
    // Electrobun's GlobalShortcut uses the same accelerator syntax as Electron.
    const GLOBAL_SHORTCUT = 'Alt+CommandOrControl+M';
    const shortcutRegistered = GlobalShortcut.register(GLOBAL_SHORTCUT, () => {
      toggleTrayPopover();
    });
    if (!shortcutRegistered) {
      console.warn(`[electrobun] Failed to register global shortcut ${GLOBAL_SHORTCUT}`);
    }

    // Combine tray + shortcut teardown into a single destroyTray callback so
    // shutdownGracefully can call one function to clean everything up.
    destroyTray = () => {
      GlobalShortcut.unregister(GLOBAL_SHORTCUT);
      trayHandle.destroy();
    };

    // macOS dock click: reopen the default window when all windows are closed.
    // When started in background mode, restore the Dock icon first.
    Electrobun.events.on('reopen', () => {
      restoreFromBackgroundMode();
      if (windowManager && windowManager.listWindows().length === 0) {
        openDefaultWindow();
      }
    });

    // Rapid changed events during boot are bounded by the number of
    // packages (typically 3-5) and settle before we subscribe.
    const refreshTrayEntries = async (): Promise<void> => {
      try {
        const result = await MakaioBus.request(TrayMenuSubjects.list, {});
        trayEntries = result.entries;
        refreshTrayMenu?.();
      } catch (err: unknown) {
        console.warn('[electrobun] Failed to refresh tray entries:', err);
      }
    };

    busHandlerCleanups.push(
      MakaioBus.on(TrayMenuSubjects.changed, () => {
        void refreshTrayEntries();
      }),
    );

    await refreshTrayEntries();
    await autoLaunchController.refreshStatus();

    process.on('SIGTERM', handleShutdown);
    process.on('SIGINT', handleShutdown);

    // ── Open initial windows ──────────────────────────────────────────────────
    // Skip in background mode: windows are opened lazily when the app is
    // first brought to the foreground (via reopen, app.focus, or makaio open).
    if (!startedInBackgroundMode) {
      await openInitialWindows({
        createWindow,
        openDefaultWindow,
        windowManager,
        sessionScope: WINDOW_SESSION_SCOPE,
      });
    }

    // Signal the bus URL on stdout for E2E test port discovery.
    // Emitted unconditionally — background mode still has a live bus server.
    process.stdout.write(`MAKAIO_BUS_URL=${busUrl}\n`);
  } catch (err: unknown) {
    console.error('[electrobun] Fatal startup error:', err);
    await shutdownGracefully(null);
    process.exit(1);
  }
})();
