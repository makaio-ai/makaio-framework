import type { ICapabilityProvider } from '@makaio/contracts';
import type { LocalNotificationPayload, NotifyResponse } from './schemas.js';

/**
 * Local notification provider interface.
 *
 * Each platform (Electron, iOS, Android, Web) implements this interface
 * to show native notifications.
 */
export interface ILocalNotificationProvider extends ICapabilityProvider {
  /**
   * Show a notification using the platform's native API.
   * @param notification - The notification payload
   * @returns Result indicating success or failure
   */
  notify(notification: LocalNotificationPayload): Promise<NotifyResponse>;

  /**
   * Check if the provider is available and has permission.
   * @returns Whether notifications can be shown
   */
  isAvailable(): boolean;
}
