/**
 * Restart and reconnect support for the setup command.
 *
 * The setup package owns business state only; this module owns CLI transport
 * mechanics such as health polling, desktop auto-launch fallback, WebSocket
 * reconnection, and kernel readiness probing.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { HealthResult } from '@makaio/utils/health-probe';
import { KernelSubjects } from '@makaio/kernel';
import type { SetupRestartAndReconnect } from '@makaio/setup';
import { requestKernelRestart } from '@makaio/setup';
import {
  connectBusClient,
  probeHealth,
  resolveBusUrl,
  resolveClientAuth,
  type ConnectBusClientOptions,
} from './bus-client.js';
import { launchAppAndWaitForBus } from './app-launch.js';

const HEALTH_DOWN_TIMEOUT_MS = 10_000;
const HEALTH_UP_TIMEOUT_MS = 20_000;
const KERNEL_READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;
const HEALTH_WAIT_TIMEOUT_PREFIX = 'Timed out waiting for Makaio host health';

/**
 * Injectable dependencies for restart/reconnect tests.
 */
export interface SetupReconnectDeps {
  /** Resolve the active bus URL. */
  readonly resolveBusUrl: () => string;
  /** Probe bus host health. */
  readonly probeHealth: (busUrl: string) => Promise<HealthResult | null>;
  /** Launch the desktop app and wait for bus health. */
  readonly launchAppAndWaitForBus: (busUrl: string) => Promise<{ readonly health: HealthResult | null }>;
  /** Resolve client transport auth from health. */
  readonly resolveClientAuth: (health: HealthResult) => ConnectBusClientOptions['auth'];
  /** Connect a fresh bus client. */
  readonly connectBusClient: (busUrl: string, options: ConnectBusClientOptions) => Promise<IMakaioBus>;
  /** Request host restart on the current bus. */
  readonly requestKernelRestart: (bus: IMakaioBus, reason?: string) => Promise<void>;
  /** Sleep between polling attempts. */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Timing options for setup reconnect polling.
 */
export interface SetupReconnectOptions {
  /** Maximum time to wait for the old host health endpoint to disappear. */
  readonly healthDownTimeoutMs?: number;
  /** Maximum time to wait for the restarted host health endpoint to reappear. */
  readonly healthUpTimeoutMs?: number;
  /** Maximum time to wait for `kernel.ready` / `kernel.isReady`. */
  readonly kernelReadyTimeoutMs?: number;
  /** Delay between health probes. */
  readonly pollIntervalMs?: number;
}

/**
 * Builds the production reconnect dependency set.
 * @returns Default reconnect dependencies.
 */
function defaultDeps(): SetupReconnectDeps {
  return {
    resolveBusUrl,
    probeHealth,
    launchAppAndWaitForBus,
    resolveClientAuth,
    connectBusClient,
    requestKernelRestart,
    sleep: async (ms) => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  };
}

/**
 * Waits until a health probe satisfies the predicate.
 * @param deps - Reconnect dependencies.
 * @param busUrl - Bus URL to probe.
 * @param predicate - Predicate over the latest health probe result.
 * @param timeoutMs - Maximum wait duration.
 * @param pollIntervalMs - Delay between probes.
 * @returns The first health value that satisfied the predicate.
 */
async function waitForHealth(
  deps: SetupReconnectDeps,
  busUrl: string,
  predicate: (health: HealthResult | null) => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<HealthResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const health = await deps.probeHealth(busUrl);
    if (predicate(health)) {
      return health;
    }
    await deps.sleep(pollIntervalMs);
  }
  throw new Error(`${HEALTH_WAIT_TIMEOUT_PREFIX} after ${timeoutMs}ms`);
}

/**
 * Identifies timeout failures produced by {@link waitForHealth}.
 * @param error - Unknown caught error.
 * @returns True when the error is a host-health timeout.
 */
function isHealthWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(HEALTH_WAIT_TIMEOUT_PREFIX);
}

/**
 * Waits for the restarted kernel to become ready.
 * @param bus - Fresh bus connected to the restarted host.
 * @param timeoutMs - Maximum wait duration.
 * @returns Promise that resolves once the kernel reports readiness.
 */
async function waitForKernelReady(bus: IMakaioBus, timeoutMs: number): Promise<void> {
  let settled = false;
  let unsubscribe = (): void => {};

  await new Promise<void>((resolve, reject) => {
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for kernel readiness after ${timeoutMs}ms`));
    }, timeoutMs);

    unsubscribe = bus.on(KernelSubjects.ready, settle);

    void (async () => {
      try {
        const result = await bus.request(KernelSubjects.isReady, {});
        if (result.ready) {
          settle();
        }
      } catch (error) {
        fail(new Error('Kernel readiness probe failed', { cause: error }));
      }
    })();
  });
}

/**
 * Creates the restart/reconnect capability consumed by `@makaio/setup`.
 * @param options - Polling timeout options.
 * @param depsOverride - Optional test dependency overrides.
 * @returns Setup restart/reconnect function.
 */
export function createSetupRestartAndReconnect(
  options: SetupReconnectOptions = {},
  depsOverride: Partial<SetupReconnectDeps> = {},
): SetupRestartAndReconnect {
  const deps = { ...defaultDeps(), ...depsOverride };
  const healthDownTimeoutMs = options.healthDownTimeoutMs ?? HEALTH_DOWN_TIMEOUT_MS;
  const healthUpTimeoutMs = options.healthUpTimeoutMs ?? HEALTH_UP_TIMEOUT_MS;
  const kernelReadyTimeoutMs = options.kernelReadyTimeoutMs ?? KERNEL_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  return async (bus, reason) => {
    const busUrl = deps.resolveBusUrl();
    await deps.requestKernelRestart(bus, reason);
    try {
      await waitForHealth(deps, busUrl, (health) => health === null, healthDownTimeoutMs, pollIntervalMs);
    } catch (error) {
      if (!isHealthWaitTimeout(error)) {
        throw error;
      }
    } finally {
      bus.disconnect();
    }

    let health: HealthResult | null;
    try {
      health = await waitForHealth(deps, busUrl, (value) => value !== null, healthUpTimeoutMs, pollIntervalMs);
    } catch {
      health = (await deps.launchAppAndWaitForBus(busUrl)).health;
    }

    if (health === null) {
      throw new Error('Makaio host did not become reachable after restart');
    }

    const auth = deps.resolveClientAuth(health);
    const restartedBus = await deps.connectBusClient(busUrl, { auth, autoReconnect: true });
    try {
      await waitForKernelReady(restartedBus, kernelReadyTimeoutMs);
      return restartedBus;
    } catch (error) {
      restartedBus.disconnect();
      throw error;
    }
  };
}
