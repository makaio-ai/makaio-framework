import { Notification } from 'electron';
import type {
  ILocalNotificationProvider,
  LocalNotificationPayload,
  NotifyResponse,
} from '@makaio/services-core/local-notification';

/**
 * Redact sensitive parts of a potentially untrusted URL for logging.
 * Keeps scheme, host, and pathname while stripping query and fragment.
 * @param rawUrl - Untrusted URL input.
 * @returns Sanitized URL representation for logs.
 */
function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Electron-based local notification provider.
 *
 * Uses Electron's Notification API to show native desktop notifications.
 */
export class ElectronNotificationProvider implements ILocalNotificationProvider {
  public readonly id = 'electron';
  public readonly displayName = 'Electron Desktop';

  /**
   * Check if notifications are supported on this platform.
   * @returns Whether notifications can be shown
   */
  public isAvailable(): boolean {
    return Notification.isSupported();
  }

  /**
   * Show a notification using Electron's native API.
   * @param notification - The notification payload
   * @returns Result indicating success or failure
   */
  public async notify(notification: LocalNotificationPayload): Promise<NotifyResponse> {
    if (!this.isAvailable()) {
      return { success: false, error: 'Notifications not supported on this platform' };
    }

    try {
      const electronNotification = new Notification({
        title: notification.title,
        body: notification.body,
        icon: notification.icon,
      });

      // Handle click if URL is provided — only allow http(s) to prevent
      // arbitrary file:// or javascript: navigation.
      if (notification.url) {
        let parsedUrl: URL | null = null;
        try {
          parsedUrl = new URL(notification.url);
        } catch {
          console.warn(`[ElectronNotificationProvider] Invalid URL skipped: ${sanitizeUrlForLog(notification.url)}`);
        }

        if (parsedUrl !== null && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')) {
          const safeUrl = parsedUrl.href;
          electronNotification.on('click', () => {
            // Import shell dynamically to avoid circular deps
            import('electron')
              .then(({ shell }) => shell.openExternal(safeUrl))
              .catch((err: unknown) => {
                const errMessage = err instanceof Error ? err.message : 'unknown error';
                console.warn(
                  `[ElectronNotificationProvider] Failed to open URL (${sanitizeUrlForLog(safeUrl)}): ${errMessage}`,
                );
              });
          });
        } else if (parsedUrl !== null) {
          console.warn(`[ElectronNotificationProvider] Disallowed URL protocol skipped: ${parsedUrl.protocol}`);
        }
      }

      electronNotification.show();

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to show notification',
      };
    }
  }

  /**
   * Optional validation - always valid for Electron.
   * @returns Validation result
   */
  public async validate(): Promise<{ valid: boolean; error?: string }> {
    if (!this.isAvailable()) {
      return { valid: false, error: 'Notifications not supported' };
    }
    return { valid: true };
  }
}
