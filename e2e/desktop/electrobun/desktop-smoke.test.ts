/**
 * Minimal-config desktop E2E tests for the Electrobun host and shared smoke
 * contract helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { HostSubjects, type WindowState } from '@makaio/host-shared';
import { UiSubjects } from '@makaio/ui-kernel';
import { waitForUiReady } from '../../shared/bus-helpers.js';
import { spawnAndDiscoverPort, type SpawnedProcess } from '../../shared/spawn-helpers.js';
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

describe('waitForUiReady host lifecycle', { timeout: 10_000 }, () => {
  let bus: IMakaioBus;
  let host: SpawnedProcess;

  beforeEach(async () => {
    bus = createBusInstance();
    host = await spawnAndDiscoverPort({
      cmd: process.execPath,
      args: [
        '-e',
        'process.on("SIGUSR2", () => process.exit(23)); setInterval(() => {}, 1000); console.log("MAKAIO_PORT=43123");',
      ],
      spawnOptions: {},
      timeoutMs: 5_000,
      label: 'ui-readiness-fixture',
    });
  });

  afterEach(async () => {
    await host?.kill();
    bus?.disconnect();
  });

  it('retains real signal exit and cleans up before a delayed consumer awaits readiness', async () => {
    const exit = host.waitForExit();
    expect(host.waitForExit()).toBe(exit);
    const wait = waitForUiReady(bus, 'electrobun', host, 60_000);
    expect(bus.getContext().eventHandlers.size).toBe(1);
    await host.sendSignal('SIGTERM');
    // Crossing an event-loop turn exercises the early rejection without a caller observer.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(await exit).toEqual({ code: null, signal: 'SIGTERM' });
    expect(bus.getContext().eventHandlers.size).toBe(0);
    await expect(wait).rejects.toThrow(
      '[waitForUiReady] Host exited before ui.ready for electrobun (code=null, signal=SIGTERM)',
    );
  });

  it('retains a nonzero exit code when the host exited before UI readiness was requested', async () => {
    expect(await host.sendSignal('SIGUSR2')).toBe(23);
    expect(await host.waitForExit()).toEqual({ code: 23, signal: null });

    await expect(waitForUiReady(bus, 'electrobun', host, 60_000)).rejects.toThrow('code=23, signal=null');
    expect(bus.getContext().eventHandlers.size).toBe(0);
  });

  it('returns the requested surface and preserves success when the host exits later', async () => {
    const wait = waitForUiReady(bus, 'electrobun', host, 60_000);
    await bus.emit(UiSubjects.ready, { surface: 'electron', timestamp: 1 });
    expect(bus.getContext().eventHandlers.size).toBe(1);
    const ready = { surface: 'electrobun' as const, timestamp: 2 };
    await bus.emit(UiSubjects.ready, ready);
    await expect(wait).resolves.toEqual(ready);
    expect(bus.getContext().eventHandlers.size).toBe(0);

    await host.sendSignal('SIGTERM');
    await expect(wait).resolves.toEqual(ready);
  });

  it('retains timeout rejection for a delayed consumer and removes its listener', async () => {
    const wait = waitForUiReady(bus, 'electrobun', host, 10);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(bus.getContext().eventHandlers.size).toBe(0);
    await expect(wait).rejects.toThrow('once() timed out after 10ms');
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
