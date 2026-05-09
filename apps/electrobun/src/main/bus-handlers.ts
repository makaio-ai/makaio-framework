import { MakaioBus } from '@makaio/bus-core';
import { HostSubjects } from '@makaio/contracts';
import { VariantSubjects } from '@makaio/contracts/variant';
import type { MakaioRuntime } from '@makaio/runtime-bun';
import type { ILocalNotificationProvider } from '@makaio/services-core/local-notification';
import { LocalNotificationSubjects } from '@makaio/services-core/local-notification/namespace';
import { FRAMEWORK_FALLBACK_WINDOW, registerHostNavigationHandler } from '@makaio/host-shared';
import { KernelSubjects } from '@makaio/kernel/namespace';
import { UiSubjects } from '@makaio/ui-kernel';
import { registerLocalNotificationBusHandlers } from './local-notification-handler.js';
import type { CreateWindowOptions, WindowManager } from './window-manager.js';
import { registerVariantUpgradeHandler } from './upgrade-handler.js';
import { detectVariant } from './variant-detection.js';
import { registerElectrobunWindowsBusHandlers } from './windows-bus-handlers.js';

export interface RegisterBusHandlersOptions {
  /** Cleanup sink for all bus handler unsubscribe callbacks. */
  busHandlerCleanups: Array<() => void>;
  /** Host window creation helper. */
  createWindow: (options: CreateWindowOptions) => number;
  /** Desktop notification provider, if this runtime supplies one. */
  localNotificationProvider: ILocalNotificationProvider | undefined;
  /** Fallback shell window opener. */
  openDefaultWindow: () => number;
  /** Refresh the tray menu after window state changes. */
  refreshTrayMenu: () => void;
  /** Show the tray popover idempotently. */
  showTrayPopover: (options: { anchor?: { x: number; y: number } }) => boolean;
  /** Runtime with the populated window registry. */
  runtime: MakaioRuntime;
  /** Active Electrobun window manager. */
  windowManager: WindowManager;
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
 * @param options - Shared desktop bus handler dependencies.
 */
export function registerBusHandlers(options: RegisterBusHandlersOptions): void {
  const {
    busHandlerCleanups,
    createWindow,
    localNotificationProvider,
    refreshTrayMenu,
    runtime,
    showTrayPopover,
    windowManager,
  } = options;

  busHandlerCleanups.push(
    MakaioBus.on(HostSubjects.window.create, (ctx) => {
      const windowId = createWindow(ctx.payload);
      ctx.setResult({ windowId });
    }),
  );

  busHandlerCleanups.push(
    MakaioBus.on(HostSubjects.window.focus, (ctx) => {
      const success = windowManager.focusWindow(ctx.payload.windowId);
      ctx.setResult({ success });
    }),
  );

  busHandlerCleanups.push(
    MakaioBus.on(HostSubjects.window.list, (ctx) => {
      const windows = windowManager.listWindows();
      ctx.setResult({ windows });
    }),
  );

  busHandlerCleanups.push(
    MakaioBus.on(HostSubjects.window.labelChanged, (ctx) => {
      windowManager.updateLabel(ctx.payload.windowId, ctx.payload.label);
      refreshTrayMenu();
    }),
  );

  registerLocalNotificationBusHandlers(busHandlerCleanups, localNotificationProvider, LocalNotificationSubjects);

  busHandlerCleanups.push(
    MakaioBus.on(KernelSubjects.ready, () => {
      windowManager.setBootComplete();
    }),
  );

  // Repeated show requests must not toggle the popover closed. Tray-click and
  // the global hotkey continue to use toggleTrayPopover for toggle semantics.
  busHandlerCleanups.push(
    MakaioBus.on(UiSubjects.popover.show, (ctx) => {
      const { x, y } = ctx.payload;
      const anchor = x != null && y != null ? { x, y } : undefined;
      const shown = showTrayPopover({ anchor });
      ctx.setResult({ shown });
    }),
  );

  busHandlerCleanups.push(
    registerHostNavigationHandler(MakaioBus, {
      createWindow,
      windowManager,
      windowRegistry: runtime.windowRegistry,
    }),
  );

  // Resolve once so every variant-info request is a synchronous property read
  // rather than a repeated filesystem probe.
  const variantConfig = detectVariant();
  busHandlerCleanups.push(
    MakaioBus.on(VariantSubjects.getInfo, (ctx) => {
      ctx.setResult(variantConfig);
    }),
  );

  registerVariantUpgradeHandler(busHandlerCleanups, variantConfig);
  busHandlerCleanups.push(
    registerElectrobunWindowsBusHandlers(MakaioBus, {
      createWindow: (registrationId) => createWindow({ registrationId }),
      dashboardRegistrationId: FRAMEWORK_FALLBACK_WINDOW,
      findWindow: (registrationId) => windowManager.findByRegistrationId(registrationId),
      focusWindow: (windowId) => windowManager.focusWindow(windowId),
      focusAnyWindow: () => {
        if (!windowManager.focusWindow()) return null;
        const windows = windowManager.listWindows();
        return windows[windows.length - 1]?.windowId ?? null;
      },
      openDefaultWindow: options.openDefaultWindow,
      onRestoreFromBackground: options.onRestoreFromBackground,
    }),
  );
}
