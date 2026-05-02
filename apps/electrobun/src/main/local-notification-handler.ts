import { MakaioBus } from '@makaio/bus-core';
import type {
  ILocalNotificationProvider,
  LocalNotificationPayload,
  LocalNotificationProviderSummary,
  NotifyResponse,
} from '@makaio/services-core/local-notification';

const NO_PROVIDER_ERROR = 'No notification provider available';

type LocalNotificationSubjects =
  typeof import('@makaio/services-core/local-notification/namespace').LocalNotificationSubjects;

type ProviderAvailabilityResult = {
  available: boolean;
  error?: string;
};

type LocalNotificationProviderResult = {
  provider: LocalNotificationProviderSummary | null;
};

/**
 * Normalize provider availability checks into a stable result.
 * @param provider - Desktop host notification provider.
 * @returns Availability plus any probe failure message.
 */
function getProviderAvailability(provider: ILocalNotificationProvider): ProviderAvailabilityResult {
  try {
    return { available: provider.isAvailable() };
  } catch (error: unknown) {
    return {
      available: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Build the RPC response for provider lookup.
 * @param provider - Desktop host notification provider, if injected.
 * @returns Bus response payload for `local-notification.getProvider`.
 */
export function getLocalNotificationProviderResult(
  provider: ILocalNotificationProvider | undefined,
): LocalNotificationProviderResult {
  if (!provider) {
    return { provider: null };
  }

  // `local-notification.getProvider` exposes only summary metadata, so an
  // availability probe failure degrades to `available: false` instead of
  // escaping the RPC handler.
  const { available } = getProviderAvailability(provider);

  return {
    provider: {
      id: provider.id,
      displayName: provider.displayName,
      available,
    },
  };
}

/**
 * Normalize provider state and provider failures to a schema-conformant notify result.
 * @param provider - Desktop host notification provider, if injected.
 * @param notification - Notification payload supplied by the bus request.
 * @returns Notify response suitable for the local-notification contract.
 */
export async function notifyWithLocalNotificationProvider(
  provider: ILocalNotificationProvider | undefined,
  notification: LocalNotificationPayload,
): Promise<NotifyResponse> {
  if (!provider) {
    return { success: false, error: NO_PROVIDER_ERROR };
  }

  const availability = getProviderAvailability(provider);
  if (!availability.available) {
    return {
      success: false,
      error: availability.error ?? `Provider '${provider.id}' is not available`,
    };
  }

  try {
    return await provider.notify(notification);
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Register the local-notification RPC handlers against the injected provider.
 * @param cleanups - Collector for `MakaioBus.on(...)` cleanup callbacks.
 * @param provider - Desktop host notification provider, if injected.
 * @param localNotificationSubjects - Typed subjects supplied by the composition root.
 */
export function registerLocalNotificationBusHandlers(
  cleanups: Array<() => void>,
  provider: ILocalNotificationProvider | undefined,
  localNotificationSubjects: Pick<LocalNotificationSubjects, 'notify' | 'getProvider'>,
): void {
  cleanups.push(
    MakaioBus.on(localNotificationSubjects.notify, async (ctx) => {
      const result = await notifyWithLocalNotificationProvider(provider, ctx.payload);
      ctx.setResult(result);
    }),
  );

  cleanups.push(
    MakaioBus.on(localNotificationSubjects.getProvider, (ctx) => {
      ctx.setResult(getLocalNotificationProviderResult(provider));
    }),
  );
}
