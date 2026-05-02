import { MakaioBus } from '@makaio/bus-core';
import { PlatformSubjects } from '@makaio/contracts';

export interface AutoLaunchControllerOptions {
  /** Refresh the tray menu after auto-launch state changes. */
  refreshTrayMenu: () => void;
}

export interface AutoLaunchController {
  /** Auto-launch enabled state; `null` = not supported / handler absent. */
  readonly enabled: boolean | null;
  /** Query current platform auto-launch status. */
  refreshStatus: () => Promise<void>;
  /** Toggle platform auto-launch using the current state. */
  toggle: () => void;
}

/**
 * Create the tray-facing auto-launch state controller.
 * @param options - UI refresh callbacks used after state changes.
 * @returns Auto-launch controller used by the tray menu.
 */
export function createAutoLaunchController(options: AutoLaunchControllerOptions): AutoLaunchController {
  let enabled: boolean | null = null;

  return {
    get enabled() {
      return enabled;
    },

    async refreshStatus(): Promise<void> {
      try {
        const result = await MakaioBus.requestOptional(PlatformSubjects.autoLaunch.getStatus, {});
        enabled = result.handled && result.data.supported ? result.data.enabled : null;
        options.refreshTrayMenu();
      } catch (err: unknown) {
        enabled = null;
        options.refreshTrayMenu();
        console.warn('[electrobun] Failed to query auto-launch status:', err);
      }
    },

    toggle(): void {
      // `null` means the platform handler is absent or reported unsupported;
      // the tray entry is informational only and must not send enable/disable RPCs.
      if (enabled === null) return;
      void (async () => {
        try {
          enabled =
            enabled === true
              ? !(await MakaioBus.request(PlatformSubjects.autoLaunch.disable, {})).disabled
              : (await MakaioBus.request(PlatformSubjects.autoLaunch.enable, { hidden: true })).enabled;
          options.refreshTrayMenu();
        } catch (err: unknown) {
          console.warn('[electrobun] Failed to toggle auto-launch:', err);
        }
      })();
    },
  };
}
