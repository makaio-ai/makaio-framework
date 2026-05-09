/**
 * Background app launch with bus readiness polling.
 *
 * Spawns the Makaio desktop app as a detached child process and waits
 * for the bus server to become reachable before returning, so CLI commands
 * can proceed without manual retry logic.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { HealthResult } from '@makaio/utils/health-probe';
import { probeHealth } from './bus-client.js';
import { resolveLaunchTarget, shouldUseMacOpen } from './open-command.js';

/**
 * Auto-launch only makes sense when the CLI targets a local bus server.
 * @param busUrl - WebSocket bus URL to inspect.
 * @returns `true` when the URL targets 127.0.0.1, localhost, or [::1].
 */
function isLoopbackBusUrl(busUrl: string): boolean {
  try {
    const { hostname } = new URL(busUrl.replace(/^ws/, 'http'));
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const POLL_INTERVAL_MS = 150;
const LAUNCH_TIMEOUT_MS = 15_000;
const SPINNER_FRAMES = ['|', '/', '-', '\\'];

/**
 * Result returned by {@link launchAppAndWaitForBus}.
 */
export interface BackgroundLaunchResult {
  /** Health probe result, or `null` if the bus did not become ready in time. */
  readonly health: HealthResult | null;
  /** Whether a launch was actually attempted. */
  readonly launched: boolean;
}

/**
 * Launch the Makaio desktop app in background mode and wait for its bus to become ready.
 *
 * Resolves the platform-specific launch target, spawns the app as a detached
 * child process, then polls the health endpoint until the bus is reachable or
 * the hard timeout elapses. A stderr spinner provides feedback while waiting.
 * @param busUrl - WebSocket URL of the bus to probe (e.g. `ws://127.0.0.1:6252/bus`).
 * @returns A result describing whether the app was launched and whether the bus became ready.
 */
export async function launchAppAndWaitForBus(busUrl: string): Promise<BackgroundLaunchResult> {
  if (!isLoopbackBusUrl(busUrl)) {
    return { health: null, launched: false };
  }

  const appPath = resolveLaunchTarget(process.platform);
  if (appPath === null) {
    return { health: null, launched: false };
  }

  if (!existsSync(appPath)) {
    return { health: null, launched: false };
  }

  const [command, args] = shouldUseMacOpen(process.platform, appPath)
    ? ['open', [appPath, '--args', '--background']]
    : [appPath, ['--background']];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
  } catch {
    return { health: null, launched: false };
  }

  let spinnerIndex = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;

  const startSpinner = (): void => {
    process.stderr.write('Starting Makaio... ');
    spinnerInterval = setInterval(() => {
      process.stderr.write(`\r${SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]} Starting Makaio... `);
      spinnerIndex++;
    }, 80);
  };

  const stopSpinner = (): void => {
    if (spinnerInterval !== undefined) {
      clearInterval(spinnerInterval);
      spinnerInterval = undefined;
      process.stderr.write('\r\x1b[K');
    }
  };

  startSpinner();

  try {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const health = await probeHealth(busUrl);
      if (health !== null) {
        return { health, launched: true };
      }
    }

    return { health: null, launched: true };
  } finally {
    stopSpinner();
  }
}
