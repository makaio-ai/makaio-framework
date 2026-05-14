/**
 * Desktop chrome bus handler registration.
 *
 * Registers all Electron main-process bus handlers that implement desktop
 * chrome concerns: window lifecycle, notifications, tray popover, and the
 * `host.window.openDashboard` RPC.
 *
 * Extracted from `main.ts` so the composition root stays under the `max-lines`
 * limit while keeping all handler wiring in a single, readable module.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import type { MakaioRuntime } from '@makaio/runtime-node';
import { HostSubjects, registerHostNavigationHandler } from '@makaio/host-shared';
import { UiNamespace, UiSubjects } from '@makaio/ui-kernel';
import { KernelSubjects } from '@makaio/kernel/namespace';
import type { ILocalNotificationProvider } from '@makaio/services-core/local-notification';
import type { CreateWindowOptions, WindowManager } from './window-manager.js';
import { registerWindowsBusHandlers } from './windows-bus-handlers.js';
import { showTrayPopover } from './tray-popover.js';

type LocalNotificationSubjects =
  typeof import('@makaio/services-core/local-notification/namespace').LocalNotificationSubjects;

/**
 * Dependencies injected into {@link registerAllBusHandlers} from the
 * composition root in `main.ts`.
 */
export interface BusHandlersDeps {
  /**
   * Array to which cleanup callbacks are pushed.
   *
   * Each entry is a function returned by `MakaioBus.on(...)` that removes
   * the handler when called. Iterated during shutdown to prevent orphaned
   * listeners.
   */
  cleanups: Array<() => void>;
  /**
   * Creates an Electron window and emits bus lifecycle events.
   * @param options - Window creation options forwarded to WindowManager.
   * @returns Electron `BrowserWindow.id` of the created or reused window.
   */
  createWindow: (options: CreateWindowOptions) => number;
  /** Qualified registration ID for the dashboard window opened by tray/UI affordances. */
  dashboardRegistrationId: string;
  /**
   * Returns the current WindowManager instance.
   *
   * Most handlers call this lazily at invocation time so they always see the
   * live instance constructed after boot. The one exception is the navigation
   * handler: `registerHostNavigationHandler` accepts a `WindowManager`
   * instance (not a getter), so `getWindowManager()` is called eagerly at
   * registration time and the returned instance is captured for the lifetime
   * of that handler.
   * @returns The active WindowManager.
   */
  getWindowManager: () => WindowManager;
  /**
   * Returns the current tray menu refresh callback, or `null` when the tray
   * has not yet been constructed.
   *
   * Called at handler invocation time so the handler always sees the live
   * reference even though the tray is wired after bus handlers are registered.
   * @returns The refresh callback, or `null`.
   */
  getRefreshTrayMenu: () => (() => void) | null;
  /**
   * The local notification provider for the desktop platform.
   *
   * Built-in Electron notification provider used by the desktop composition root.
   */
  notificationProvider: ILocalNotificationProvider;
  /**
   * Typed local-notification subjects supplied by the composition root that owns namespace registration.
   */
  localNotificationSubjects: Pick<LocalNotificationSubjects, 'notify' | 'getProvider'>;
  /**
   * The resolved Makaio runtime, used to supply the populated window registry
   * to the navigation handler.
   */
  runtime: MakaioRuntime;
  /**
   * Called once before the first window is created when upgrading from
   * background-only mode to regular (visible) mode.
   *
   * Optional — omit when the app was not started with `--background`.
   */
  onRestoreFromBackground?: () => void;
}

/**
 * Register all desktop chrome bus handlers and the navigation handler.
 *
 * Must be called after `windowManager` is constructed (i.e. after boot).
 * Pushes cleanup functions into `deps.cleanups`.
 * @param deps - Dependencies supplied by the composition root.
 */
// eslint-disable-next-line max-lines-per-function -- Composition root: each handler is a one-liner; splitting would scatter related wiring
export function registerAllBusHandlers(deps: BusHandlersDeps): void {
  const {
    cleanups,
    createWindow,
    dashboardRegistrationId,
    getWindowManager,
    getRefreshTrayMenu,
    notificationProvider,
    localNotificationSubjects,
    runtime,
    onRestoreFromBackground,
  } = deps;

  MakaioBus.registerNamespace(UiNamespace);

  cleanups.push(
    MakaioBus.on(HostSubjects.window.create, (ctx) => {
      const windowId = createWindow(ctx.payload);
      ctx.setResult({ windowId });
    }),
  );

  cleanups.push(
    MakaioBus.on(HostSubjects.window.focus, (ctx) => {
      const success = getWindowManager().focusWindow(ctx.payload.windowId);
      ctx.setResult({ success });
    }),
  );

  cleanups.push(
    MakaioBus.on(HostSubjects.window.list, (ctx) => {
      const windows = getWindowManager().listWindows();
      ctx.setResult({ windows });
    }),
  );

  cleanups.push(
    MakaioBus.on(HostSubjects.window.labelChanged, (ctx) => {
      getWindowManager().updateLabel(ctx.payload.windowId, ctx.payload.label);
      getRefreshTrayMenu()?.();
    }),
  );

  cleanups.push(
    MakaioBus.on(localNotificationSubjects.notify, async (ctx) => {
      const result = await notificationProvider.notify(ctx.payload);
      ctx.setResult(result);
    }),
  );

  cleanups.push(
    MakaioBus.on(localNotificationSubjects.getProvider, (ctx) => {
      ctx.setResult({
        provider: {
          id: notificationProvider.id,
          displayName: notificationProvider.displayName,
          available: notificationProvider.isAvailable(),
        },
      });
    }),
  );

  cleanups.push(
    MakaioBus.on(KernelSubjects.ready, () => {
      getWindowManager().setBootComplete();
    }),
  );

  cleanups.push(
    MakaioBus.on(UiSubjects.popover.show, (ctx) => {
      const { x, y } = ctx.payload;
      const anchor = x != null && y != null ? { x, y } : undefined;
      const shown = showTrayPopover({ anchor });
      ctx.setResult({ shown });
    }),
  );

  cleanups.push(
    registerWindowsBusHandlers(MakaioBus, {
      createWindow: (id) => createWindow({ registrationId: id }),
      dashboardRegistrationId,
      findWindow: (id) => getWindowManager().findWindowByRegistrationId(id),
      focusWindow: (id) => getWindowManager().focusWindow(id),
      focusAnyWindow: () => getWindowManager().focusMostRecentWindow(),
      openDefaultWindow: () => createWindow({ registrationId: dashboardRegistrationId }),
      onRestoreFromBackground,
    }),
  );

  const unregisterNavigation = registerHostNavigationHandler(MakaioBus, {
    createWindow: (opts) => createWindow(opts),
    windowManager: getWindowManager(),
    windowRegistry: runtime.windowRegistry,
  });
  cleanups.push(unregisterNavigation);
}
