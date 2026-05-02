import type { ICapabilityProvider } from '../../capability/types.js';

/**
 * Auto-launch capability provider.
 *
 * Platform packages implement this to manage login items / autostart entries
 * for the current operating system.
 */
export interface IAutoLaunchProvider extends ICapabilityProvider {
  /** Capability identifier — must be `'autoLaunch'`. */
  readonly capabilityId: 'autoLaunch';

  /**
   * Enable auto-launch at login.
   * @param hidden - Whether the app should start hidden (tray only).
   * @returns Whether auto-launch was successfully enabled.
   */
  enable(hidden?: boolean): Promise<{ enabled: boolean; error?: string }>;

  /**
   * Disable auto-launch at login.
   * @returns Whether auto-launch was successfully disabled.
   */
  disable(): Promise<{ disabled: boolean; error?: string }>;

  /**
   * Query current auto-launch status.
   * @returns Whether auto-launch is enabled and supported.
   */
  getStatus(): Promise<{ enabled: boolean; supported: boolean }>;
}
