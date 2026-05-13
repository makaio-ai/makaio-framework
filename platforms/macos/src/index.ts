import type { MakaioExtension } from '@makaio/contracts';
import { AUTO_LAUNCH_CAPABILITY_ID, CapabilitySubjects, registerAutoLaunchProvider } from '@makaio/contracts';
import {
  MacOSAutoLaunchProvider,
  resolveMacOSAutoLaunchTarget,
  type MacOSAutoLaunchProviderOptions,
} from './auto-launch-provider.js';
import { registerAutoLaunchHandlers } from './auto-launch-handler.js';

/** Options for creating the macOS platform capability package. */
export interface PlatformMacOSPackageOptions {
  /**
   * Target app bundle for Login Item management.
   *
   * Omit to derive the target from `MAKAIO_APP` or the running `.app` bundle.
   * Pass `false` to disable auto-launch registration for this package instance.
   */
  readonly autoLaunch?: MacOSAutoLaunchProviderOptions | false;
}

/**
 * Create the macOS platform capability package.
 * @param options - Host-owned platform capability policy.
 * @returns A Darwin-gated Makaio extension.
 */
export function createPlatformMacOSPackage(options: PlatformMacOSPackageOptions = {}): MakaioExtension {
  return {
    name: 'platform-macos',
    displayName: 'Platform: macOS',
    version: '0.1.0',
    requires: [{ type: 'host', id: 'darwin' }],
    create: (ctx) => {
      const target =
        options.autoLaunch === false
          ? undefined
          : (options.autoLaunch ?? resolveMacOSAutoLaunchTarget({ env: process.env, execPath: process.execPath }));
      const provider = target ? new MacOSAutoLaunchProvider(target) : undefined;
      let handlerCleanup: (() => void) | undefined;

      return {
        async init() {
          if (!provider) return;

          handlerCleanup = registerAutoLaunchHandlers(ctx.bus, provider);
          registerAutoLaunchProvider(ctx.bus, provider);
        },
        destroy() {
          handlerCleanup?.();
          if (!provider) return;

          ctx.bus.emit(CapabilitySubjects.unregister, {
            capabilityId: AUTO_LAUNCH_CAPABILITY_ID,
            providerId: provider.id,
          });
        },
      };
    },
  };
}

/**
 * macOS platform capability package.
 *
 * Provides OS-level capabilities for macOS hosts:
 * - Auto-launch (Login Items)
 *
 * Gated to macOS via `requires: [{ type: 'host', id: 'darwin' }]`.
 */
export const platformMacOSPackage: MakaioExtension = createPlatformMacOSPackage();
