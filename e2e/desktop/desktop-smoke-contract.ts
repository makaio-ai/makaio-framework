/**
 * Shared desktop smoke contract.
 *
 * Host-specific tests provide only the launcher and expected UI surface; this
 * module owns the bus-level assertions that prove the desktop runtime, window
 * manager, selected shell extension, and shared renderer all started.
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import type { SurfaceType } from '@makaio/contracts';
import { HostSubjects } from '@makaio/host-shared';
import { BootSubjects, ExtensionSubjects, KernelSubjects } from '@makaio/kernel';
import type { SpawnedProcess } from '../shared/spawn-helpers.js';
import { connectTestBus, waitForBoot, waitForRuntimeReady, waitForUiReady } from '../shared/bus-helpers.js';
import { resolveFreeLoopbackPort } from '../shared/free-port.js';
import {
  attributeMidBootDependencyReoptimization,
  expectNoMidBootDependencyReoptimization,
} from '../shared/vite-optimizer-guard.js';

/** Start function supplied by a host-specific desktop launcher. */
export type StartMakaioDevDesktopHost = (options: {
  /** Environment variables forwarded to the host process. */
  env: Record<string, string>;
  /** Milliseconds to wait for the host to announce its bus port. */
  timeoutMs: number;
}) => Promise<SpawnedProcess>;

/** Options for {@link runMakaioDevDesktopSmoke}. */
export interface MakaioDevDesktopSmokeOptions {
  /** Human-readable host name used in logs and temporary directory names. */
  hostLabel: string;
  /** Shared renderer surface expected to emit `ui.ready`. */
  expectedUiSurface: Extract<SurfaceType, 'electron' | 'electrobun'>;
  /** Extension expected to be active before the window assertion runs. */
  expectedExtensionName?: string;
  /** Window registration expected to open during startup. */
  expectedRegistrationId?: string;
  /** Service failures accepted for this desktop smoke. */
  allowedFailedServices?: readonly string[];
  /** Host-specific launcher. */
  startHost: StartMakaioDevDesktopHost;
}

/**
 * Product packages that may fail in a fresh local E2E home without optional
 * provider credentials, local Docker, or disabled feature flags.
 */
export const OPTIONAL_MAKAIO_DEV_DESKTOP_FAILURES = [
  'makaio-dev.docker',
  'makaio-dev.voice',
  'claude-code-cli',
  'github-copilot-sdk',
  'qwen-acp',
  'gemini-sdk',
  'anthropic-sdk',
  'claude-agent-sdk',
  'pi-sdk',
  'codex-app-server',
  'openai-node',
  'claude-code-tmux',
] as const;

const DEFAULT_EXPECTED_EXTENSION_NAME = 'makaio-dev';
const DEFAULT_EXPECTED_REGISTRATION_ID = 'makaio-dev.project-overview:main';
const STARTUP_TIMEOUT_MS = 60_000;
const WINDOW_TIMEOUT_MS = 120_000;

type RemoveDirectory = typeof fs.rm;

/**
 * Remove the isolated desktop E2E home after the native host exits.
 *
 * Linux desktop stacks can write graphics cache entries under `XDG_CACHE_HOME`
 * during teardown. Node's retry-capable recursive removal handles the short
 * `ENOTEMPTY` window without masking a persistent leaked process.
 * @param homeDir - Temporary home directory owned by the desktop smoke test.
 * @param remove - Directory removal implementation; injectable for focused tests.
 */
export async function removeDesktopE2eHome(homeDir: string, remove: RemoveDirectory = fs.rm): Promise<void> {
  await remove(homeDir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
}

/**
 * Connect a bus client to a desktop host, retrying until the startup deadline
 * for socket readiness.
 * @param port - Bus server port announced by the host.
 * @param hostLabel - Host label used in diagnostics.
 * @param timeoutMs - Milliseconds to wait before failing.
 * @returns Connected bus client.
 */
async function connectDesktopBus(
  port: number,
  hostLabel: string,
  timeoutMs: number = STARTUP_TIMEOUT_MS,
): Promise<IMakaioBus> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      return await connectTestBus(port);
    } catch (err) {
      console.info(
        '[desktop-e2e:%s] Bus connection attempt %d failed: %s',
        hostLabel,
        attempt,
        err instanceof Error ? err.message : err,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`[desktop-e2e:${hostLabel}] Failed to connect to bus within ${timeoutMs}ms`);
}

/**
 * Assert that startup reported no failures outside the host's expected set.
 * @param actual - Failed service names reported by boot state.
 * @param allowed - Failed service names accepted for this smoke scenario.
 * @param hostLabel - Host label used in assertion diagnostics.
 */
function expectOnlyAllowedFailedServices(
  actual: readonly string[],
  allowed: readonly string[],
  hostLabel: string,
): void {
  const unexpected = actual.filter((serviceName) => !allowed.includes(serviceName));
  expect(unexpected, `[desktop-e2e:${hostLabel}] unexpected failed services`).toEqual([]);
}

/**
 * Wait until the host reports a window with the expected registration ID.
 * @param bus - Connected test bus.
 * @param registrationId - Window registration ID to find.
 * @param hostLabel - Host label used in diagnostics.
 * @returns Matching window state.
 */
export async function waitForWindowRegistration(
  bus: IMakaioBus,
  registrationId: string,
  hostLabel: string,
): Promise<{ windowId: number; registrationId: string }> {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const { windows } = await bus.request(HostSubjects.window.list, {});
      const match = windows.find((window) => window.registrationId === registrationId);
      if (match) {
        return { windowId: match.windowId, registrationId: match.registrationId };
      }
    } catch (err) {
      // Window list is a readiness probe during host startup; transient bus
      // failures should consume a poll attempt, not fail the whole smoke.
      console.info(
        '[desktop-e2e:%s] Window list request failed while waiting for registration %s: %s',
        hostLabel,
        registrationId,
        err instanceof Error ? err.message : err,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`[desktop-e2e:${hostLabel}] Timed out waiting for window '${registrationId}'`);
}

/**
 * Run the full Makaio Dev desktop boot smoke against a concrete desktop host.
 * @param options - Host-specific launcher and expected renderer surface.
 */
export async function runMakaioDevDesktopSmoke(options: MakaioDevDesktopSmokeOptions): Promise<void> {
  const {
    allowedFailedServices = [],
    expectedExtensionName = DEFAULT_EXPECTED_EXTENSION_NAME,
    expectedRegistrationId = DEFAULT_EXPECTED_REGISTRATION_ID,
    expectedUiSurface,
    hostLabel,
    startHost,
  } = options;
  const e2eTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `makaio-${hostLabel}-desktop-e2e-`));
  const hostPort = await resolveFreeLoopbackPort();
  let host: SpawnedProcess | null = null;
  let bus: IMakaioBus | null = null;
  let hostExited = false;

  try {
    const startedHost = await startHost({
      timeoutMs: STARTUP_TIMEOUT_MS,
      env: {
        HOME: e2eTmpDir,
        XDG_CACHE_HOME: path.join(e2eTmpDir, '.cache'),
        XDG_CONFIG_HOME: path.join(e2eTmpDir, '.config'),
        MAKAIO_DATABASE_PATH: path.join(e2eTmpDir, 'makaio.db'),
        MAKAIO_PORT: String(hostPort),
      },
    });
    host = startedHost;
    console.info('[desktop-e2e:%s] Host started, bus port: %d', hostLabel, startedHost.port);
    expect(startedHost.port).toBe(hostPort);

    bus = await connectDesktopBus(startedHost.port, hostLabel);
    console.info('[desktop-e2e:%s] Bus connected on port %d', hostLabel, startedHost.port);

    // A mid-boot re-optimization reloads the renderer and can crash the
    // webview, which makes the boot/wait sequence below time out before the
    // success-path drift guard runs. Attribute such failures from the
    // captured host output so the drift diagnostic survives the error path.
    try {
      const uiReadyPromise = waitForUiReady(bus, expectedUiSurface, WINDOW_TIMEOUT_MS);

      const bootPayload = await waitForBoot(bus, STARTUP_TIMEOUT_MS);
      expect(Number.isFinite(bootPayload.totalDurationMs)).toBe(true);
      expect(bootPayload.totalDurationMs).toBeGreaterThanOrEqual(0);
      expectOnlyAllowedFailedServices(bootPayload.failedServices, allowedFailedServices, hostLabel);

      const bootState = await bus.request(BootSubjects.getState, {});
      expect(bootState.complete).toBe(true);
      expect(bootState.completedCount).toBe(bootState.totalCount);
      expect(bootState.totalCount).toBeGreaterThan(0);
      expectOnlyAllowedFailedServices(bootState.failedServices, allowedFailedServices, hostLabel);

      const { ready, machineId } = await waitForRuntimeReady(bus, STARTUP_TIMEOUT_MS);
      expect(ready).toBe(true);
      expect(machineId.length).toBeGreaterThan(0);

      const runtimeProbe = await bus.request(KernelSubjects.isReady, {});
      expect(runtimeProbe.ready).toBe(true);
      expect(runtimeProbe.machineId).toBe(machineId);

      const extResp = await bus.request(ExtensionSubjects.list, {});
      const { extensions } = extResp as { extensions: Array<{ name: string; state: string }> };
      expect(extensions.find((extension) => extension.name === expectedExtensionName)?.state).toBe('active');

      const openedWindow = await waitForWindowRegistration(bus, expectedRegistrationId, hostLabel);
      expect(openedWindow.registrationId).toBe(expectedRegistrationId);
      expect(openedWindow.windowId).toBeGreaterThan(0);

      const { windows } = await bus.request(HostSubjects.window.list, {});
      expect(windows.length).toBeGreaterThanOrEqual(1);
      const mainWindow = windows.find((window) => window.registrationId === expectedRegistrationId);
      expect(mainWindow).toBeDefined();
      expect(mainWindow!.windowId).toBe(openedWindow.windowId);

      const uiReady = await uiReadyPromise;
      expect(uiReady.surface).toBe(expectedUiSurface);
      expect(uiReady.timestamp).toBeGreaterThan(0);
    } catch (error) {
      attributeMidBootDependencyReoptimization(error, startedHost.getOutput(), hostLabel);
    }

    expectNoMidBootDependencyReoptimization(startedHost.getOutput(), hostLabel);

    await bus.request(HostSubjects.app.shutdown, {});
    bus.disconnect();
    bus = null;
    const exitCode = await host.sendSignal('SIGTERM');
    hostExited = true;
    expect(exitCode === null || exitCode === 0).toBe(true);
    host = null;
  } finally {
    bus?.disconnect();
    if (host && !hostExited) {
      await host.kill();
    }
    await removeDesktopE2eHome(e2eTmpDir);
  }
}
