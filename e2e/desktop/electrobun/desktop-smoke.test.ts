/**
 * Minimal-config desktop E2E tests for the Electrobun host and shared smoke
 * contract helpers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { HostSubjects, type WindowState } from '@makaio/host-shared';
import {
  removeDesktopE2eHome,
  runMakaioDevDesktopSmoke,
  waitForWindowRegistration,
} from '../desktop-smoke-contract.js';
import { startElectrobun } from './spawn.js';

const REGISTRATION_ID = 'framework-shell:main';

/**
 * Create the minimal valid window state returned by host window list handlers.
 * @param windowId - Host-assigned desktop window ID.
 * @param registrationId - Package-qualified window registration ID.
 * @returns Window state accepted by the host list response schema.
 */
function makeWindowState(windowId: number, registrationId: string): WindowState {
  return { windowId, registrationId, visible: true, focused: false };
}

describe('waitForWindowRegistration', () => {
  let bus: IMakaioBus | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    bus?.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('continues polling after a transient window list failure', async () => {
    vi.useFakeTimers();
    bus = createBusInstance();
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let attempts = 0;

    cleanup = bus.on(HostSubjects.window.list, (ctx) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('transient list failure');
      }
      ctx.setResult({ windows: [makeWindowState(7, REGISTRATION_ID)] });
    });

    const waitPromise = waitForWindowRegistration(bus, REGISTRATION_ID, 'electrobun');
    await vi.advanceTimersByTimeAsync(250);

    await expect(waitPromise).resolves.toEqual({ registrationId: REGISTRATION_ID, windowId: 7 });
    expect(attempts).toBe(2);
    expect(consoleInfo).toHaveBeenCalledWith(
      '[desktop-e2e:%s] Window list request failed while waiting for registration %s: %s',
      'electrobun',
      REGISTRATION_ID,
      expect.stringContaining('transient list failure'),
    );
  });
});

describe('removeDesktopE2eHome', () => {
  it('uses retry-capable recursive removal for native graphics cache teardown races', async () => {
    const remove = vi.fn<NonNullable<Parameters<typeof removeDesktopE2eHome>[1]>>().mockResolvedValue(undefined);

    await removeDesktopE2eHome('/tmp/makaio-electrobun-desktop-e2e-test', remove);

    expect(remove).toHaveBeenCalledWith('/tmp/makaio-electrobun-desktop-e2e-test', {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    });
  });
});

describe('Electrobun desktop smoke test', { timeout: 220_000 }, () => {
  it('boots, opens a window, mounts the renderer, and shuts down cleanly', async () => {
    await runMakaioDevDesktopSmoke({
      expectedExtensionName: 'framework-shell',
      expectedRegistrationId: 'framework-shell:main',
      expectedUiSurface: 'electrobun',
      hostLabel: 'electrobun',
      startHost: startElectrobun,
    });
  });
});
