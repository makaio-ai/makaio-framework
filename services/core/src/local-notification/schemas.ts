import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Local notification payload sent to the active platform provider.
 */
export interface LocalNotificationPayload {
  /** Notification title. */
  title: string;
  /** Notification body text. */
  body: string;
  /** Optional icon path or identifier. */
  icon?: string;
  /** Optional click action URL. */
  url?: string;
}

/**
 * Request payload for showing a local notification.
 */
export type NotifyRequest = LocalNotificationPayload;

/**
 * Response returned when the platform provider accepts the notification.
 */
export type NotifySuccessResponse = {
  /** Whether the notification was shown. */
  success: true;
};

/**
 * Response returned when the platform provider cannot show the notification.
 */
export type NotifyFailureResponse = {
  /** Whether the notification was shown. */
  success: false;
  /** Human-readable failure reason. */
  error: string;
};

/**
 * Local notification result.
 */
export type NotifyResponse = NotifySuccessResponse | NotifyFailureResponse;

/**
 * Summary of the active local notification provider.
 */
export interface LocalNotificationProviderSummary {
  /** Provider identifier. */
  id: string;
  /** Human-readable provider name. */
  displayName: string;
  /** Whether the provider can currently show notifications. */
  available: boolean;
}

/**
 * Local notification payload validator.
 */
const LocalNotificationSchema = z.object({
  /** Notification title */
  title: z.string(),
  /** Notification body text */
  body: z.string(),
  /** Optional icon path or identifier */
  icon: z.string().optional(),
  /** Optional click action URL */
  url: z.string().optional(),
}) satisfies z.ZodType<LocalNotificationPayload, LocalNotificationPayload>;

/**
 * Local notification response validator.
 */
const NotifyResponseSchema = z.discriminatedUnion('success', [
  z
    .object({
      /** Whether the notification was shown */
      success: z.literal(true),
    })
    .strict(),
  z
    .object({
      /** Whether the notification was shown */
      success: z.literal(false),
      /** Error message if failed */
      error: z.string(),
    })
    .strict(),
]) satisfies z.ZodType<NotifyResponse, NotifyResponse>;

/**
 * Local notification provider summary validator.
 */
const LocalNotificationProviderSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
}) satisfies z.ZodType<LocalNotificationProviderSummary, LocalNotificationProviderSummary>;

/**
 * Local notification domain schemas.
 *
 * Local notifications are platform-native notifications (Electron, iOS, Android, Web).
 * Unlike push notifications, only one provider is active per platform.
 */
export const LocalNotificationSchemas = {
  /**
   * Show a local notification on the current platform.
   */
  notify: {
    request: LocalNotificationSchema,
    response: NotifyResponseSchema,
  },

  /**
   * Get the current platform's notification provider info.
   */
  getProvider: {
    request: z.object({}),
    response: z.object({
      provider: LocalNotificationProviderSummarySchema.nullable(),
    }),
  },
} satisfies SchemaRecord;
