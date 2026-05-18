/**
 * Desktop E2E smoke test for the primary Electrobun host.
 *
 * Spawns the real Electrobun composition root without host runtime config and
 * verifies that startup opens the default shell window.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { HostSubjects } from '@makaio/host-shared';
import { BootSubjects, ExtensionSubjects, KernelSubjects } from '@makaio/kernel';
import { connectTestBus, waitForBoot, waitForRuntimeReady, waitForUiReady } from '../shared/bus-helpers.js';
import { resolveFreeLoopbackPort } from '../shared/free-port.js';
import { startElectrobun, type ElectrobunProcess } from './spawn-electrobun.js';

const EXPECTED_SHELL_WINDOW = 'framework-shell:main';
const STARTUP_TIMEOUT_MS = 60_000;

async function waitForWindowRegistration(
  bus: IMakaioBus,
  registrationId: string,
  timeoutMs: number,
): Promise<{ windowId: number; registrationId: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { windows } = await bus.request(HostSubjects.window.list, {});
    const match = windows.find((window) => window.registrationId === registrationId);
    if (match) {
      return { windowId: match.windowId, registrationId: match.registrationId };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for window '${registrationId}' within ${timeoutMs}ms`);
}

describe('Electrobun desktop smoke test', { timeout: 200_000 }, () => {
  let electrobun: ElectrobunProcess | null = null;
  let e2eTmpDir: string | null = null;

  afterEach(async () => {
    try {
      if (electrobun) await electrobun.kill();
    } finally {
      electrobun = null;
      if (e2eTmpDir) {
        await fs.rm(e2eTmpDir, { recursive: true, force: true });
        e2eTmpDir = null;
      }
    }
  });

  it('boots without host policy, opens the default shell, and shuts down cleanly', async () => {
    e2eTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-electrobun-e2e-'));
    const hostPort = await resolveFreeLoopbackPort();
    electrobun = await startElectrobun({
      timeoutMs: STARTUP_TIMEOUT_MS,
      env: {
        HOME: e2eTmpDir,
        XDG_CONFIG_HOME: path.join(e2eTmpDir, '.config'),
        MAKAIO_DATABASE_PATH: path.join(e2eTmpDir, 'makaio.db'),
        MAKAIO_PORT: String(hostPort),
      },
    });
    expect(electrobun.port).toBe(hostPort);

    let bus: IMakaioBus | null = null;
    const connectDeadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < connectDeadline) {
      try {
        bus = await connectTestBus(electrobun.port);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!bus) throw new Error(`Failed to connect to bus within ${STARTUP_TIMEOUT_MS / 1000}s`);

    try {
      const uiReadyPromise = waitForUiReady(bus, 'electrobun', STARTUP_TIMEOUT_MS);
      const bootPayload = await waitForBoot(bus, STARTUP_TIMEOUT_MS);
      expect(bootPayload.failedServices).toEqual([]);

      const bootState = await bus.request(BootSubjects.getState, {});
      expect(bootState.complete).toBe(true);
      expect(bootState.failedServices).toEqual([]);

      const { ready, machineId } = await waitForRuntimeReady(bus, STARTUP_TIMEOUT_MS);
      expect(ready).toBe(true);
      expect(machineId.length).toBeGreaterThan(0);

      const runtimeProbe = await bus.request(KernelSubjects.isReady, {});
      expect(runtimeProbe.ready).toBe(true);
      expect(runtimeProbe.machineId).toBe(machineId);

      const extResp = await bus.request(ExtensionSubjects.list, {});
      const { extensions } = extResp as { extensions: Array<{ name: string; state: string }> };
      expect(extensions.find((extension) => extension.name === 'framework-shell')?.state).toBe('active');

      const openedWindow = await waitForWindowRegistration(bus, EXPECTED_SHELL_WINDOW, STARTUP_TIMEOUT_MS);
      expect(openedWindow.registrationId).toBe(EXPECTED_SHELL_WINDOW);
      expect(openedWindow.windowId).toBeGreaterThan(0);
      expect(electrobun.getOutput()).not.toContain('[WindowManager] Failed to load');
      expect(electrobun.getOutput()).not.toContain('[WindowManager] Renderer crashed:');

      const uiReady = await uiReadyPromise;
      expect(uiReady.surface).toBe('electrobun');
      expect(uiReady.timestamp).toBeGreaterThan(0);

      const { windows } = await bus.request(HostSubjects.window.list, {});
      const shellWindow = windows.find((window) => window.registrationId === EXPECTED_SHELL_WINDOW);
      expect(shellWindow).toBeDefined();
      expect(shellWindow!.windowId).toBe(openedWindow.windowId);
    } finally {
      bus.disconnect();
    }

    const exitCode = await electrobun.sendSignal('SIGTERM');
    expect(exitCode === null || exitCode === 0).toBe(true);
    electrobun = null;
  });
});
