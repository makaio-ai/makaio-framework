import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Platform capability schemas.
 *
 * Cross-platform bus subjects for OS-level capabilities. Each platform
 * package (`platform-macos`, `platform-linux`, `platform-windows`)
 * registers handlers for the capabilities it supports.
 *
 * Consumers interact exclusively through these subjects — never through
 * OS APIs directly.
 */
export const PlatformSchemas = {
  /**
   * Enable auto-launch at login.
   *
   * The platform provider registers the application as a login item
   * (macOS), autostart entry (Linux), or Run key (Windows).
   *
   * Subject: `platform.autoLaunch.enable`
   * Type: Request (RPC)
   */
  'autoLaunch.enable': {
    request: z.object({
      /** Whether the app should start hidden (tray only, no window). */
      hidden: z.boolean().optional().default(true),
    }),
    response: z.object({
      /** Whether auto-launch was successfully enabled. */
      enabled: z.boolean(),
      /** Error message if enablement failed. */
      error: z.string().optional(),
    }),
  },

  /**
   * Disable auto-launch at login.
   *
   * Subject: `platform.autoLaunch.disable`
   * Type: Request (RPC)
   */
  'autoLaunch.disable': {
    request: z.object({}),
    response: z.object({
      /** Whether auto-launch was successfully disabled. */
      disabled: z.boolean(),
      /** Error message if disablement failed. */
      error: z.string().optional(),
    }),
  },

  /**
   * Query auto-launch status.
   *
   * Subject: `platform.autoLaunch.getStatus`
   * Type: Request (RPC)
   */
  'autoLaunch.getStatus': {
    request: z.object({}),
    response: z.object({
      /** Whether auto-launch is currently enabled. */
      enabled: z.boolean(),
      /** Whether the current platform supports auto-launch. */
      supported: z.boolean(),
    }),
  },
} satisfies SchemaRecord;

/** Request payload for `platform.autoLaunch.enable`. */
export type AutoLaunchEnableRequest = z.infer<(typeof PlatformSchemas)['autoLaunch.enable']['request']>;
/** Response payload for `platform.autoLaunch.enable`. */
export type AutoLaunchEnableResponse = z.infer<(typeof PlatformSchemas)['autoLaunch.enable']['response']>;
/** Response payload for `platform.autoLaunch.disable`. */
export type AutoLaunchDisableResponse = z.infer<(typeof PlatformSchemas)['autoLaunch.disable']['response']>;
/** Response payload for `platform.autoLaunch.getStatus`. */
export type AutoLaunchStatusResponse = z.infer<(typeof PlatformSchemas)['autoLaunch.getStatus']['response']>;
