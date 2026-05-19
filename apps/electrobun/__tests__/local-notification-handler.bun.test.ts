/// <reference types="bun-types" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import type {
  ILocalNotificationProvider,
  LocalNotificationPayload,
  NotifyResponse,
} from '@makaio/services-core/local-notification';
import { LocalNotificationSubjects } from '@makaio/services-core/local-notification/namespace';
import {
  getLocalNotificationProviderResult,
  notifyWithLocalNotificationProvider,
  registerLocalNotificationBusHandlers,
} from '../src/main/local-notification-handler.js';

const NOTIFICATION: LocalNotificationPayload = {
  title: 'Title',
  body: 'Body',
};

function createProvider(options?: {
  isAvailable?: boolean;
  availabilityError?: unknown;
  notify?: (notification: LocalNotificationPayload) => Promise<NotifyResponse>;
}): ILocalNotificationProvider {
  return {
    id: 'test-provider',
    displayName: 'Test Provider',
    isAvailable: () => {
      if (options?.availabilityError !== undefined) {
        throw options.availabilityError;
      }
      return options?.isAvailable ?? true;
    },
    notify:
      options?.notify ??
      mock(
        async (): Promise<NotifyResponse> => ({
          success: true,
        }),
      ),
  };
}

describe('local notification handler', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    let firstCleanupError: unknown;

    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error: unknown) {
        firstCleanupError ??= error;
      }
    }

    if (firstCleanupError !== undefined) {
      throw firstCleanupError;
    }
  });

  it('returns null provider info when no desktop provider is injected', () => {
    expect(getLocalNotificationProviderResult(undefined)).toEqual({ provider: null });
  });

  it('surfaces provider availability in the provider summary', () => {
    expect(getLocalNotificationProviderResult(createProvider({ isAvailable: false }))).toEqual({
      provider: {
        id: 'test-provider',
        displayName: 'Test Provider',
        available: false,
      },
    });
  });

  it('treats availability probe failures as unavailable in the provider summary', () => {
    expect(getLocalNotificationProviderResult(createProvider({ availabilityError: new Error('boom') }))).toEqual({
      provider: {
        id: 'test-provider',
        displayName: 'Test Provider',
        available: false,
      },
    });
  });

  it('returns a failure response when the provider is missing', async () => {
    await expect(notifyWithLocalNotificationProvider(undefined, NOTIFICATION)).resolves.toEqual({
      success: false,
      error: 'No notification provider available',
    });
  });

  it('returns a failure response when the provider is unavailable', async () => {
    const notify = mock(async () => ({ success: true }) satisfies NotifyResponse);

    await expect(
      notifyWithLocalNotificationProvider(createProvider({ isAvailable: false, notify }), NOTIFICATION),
    ).resolves.toEqual({
      success: false,
      error: "Provider 'test-provider' is not available",
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it('returns a failure response when provider availability probing throws', async () => {
    const notify = mock(async () => ({ success: true }) satisfies NotifyResponse);

    await expect(
      notifyWithLocalNotificationProvider(
        createProvider({ availabilityError: new Error('boom'), notify }),
        NOTIFICATION,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'boom',
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it('returns a schema-conformant failure when provider.notify rejects', async () => {
    await expect(
      notifyWithLocalNotificationProvider(
        createProvider({
          notify: mock(async () => {
            throw new Error('boom');
          }),
        }),
        NOTIFICATION,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'boom',
    });
  });

  it('registers bus handlers that use the injected provider through the helper wiring path', async () => {
    const deliveredNotifications: LocalNotificationPayload[] = [];
    const provider = createProvider({
      notify: async (notification) => {
        deliveredNotifications.push(notification);
        return { success: true };
      },
    });

    registerLocalNotificationBusHandlers(cleanups, provider, LocalNotificationSubjects);

    await expect(MakaioBus.request(LocalNotificationSubjects.getProvider, {})).resolves.toEqual({
      provider: {
        id: 'test-provider',
        displayName: 'Test Provider',
        available: true,
      },
    });

    await expect(MakaioBus.request(LocalNotificationSubjects.notify, NOTIFICATION)).resolves.toEqual({
      success: true,
    });
    expect(deliveredNotifications).toEqual([NOTIFICATION]);
  });
});
