import { describe, expect, it, vi } from 'vitest';
import { createMockBus } from '@makaio/test-utils';
import { KernelSubjects } from '@makaio/kernel';
import { createSetupRestartAndReconnect, type SetupReconnectDeps } from './setup-reconnect.js';

/**
 * Builds reconnect dependencies with no real network or timers.
 * @param overrides - Dependency overrides for the scenario.
 */
function makeDeps(overrides: Partial<SetupReconnectDeps> = {}): SetupReconnectDeps {
  return {
    resolveBusUrl: vi.fn(() => 'ws://127.0.0.1:6252/bus'),
    probeHealth: vi.fn(),
    launchAppAndWaitForBus: vi.fn(async () => ({ health: { auth: false } })),
    resolveClientAuth: vi.fn(() => undefined),
    connectBusClient: vi.fn(),
    requestKernelRestart: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createSetupRestartAndReconnect', () => {
  it('waits for health down, reconnects to a fresh bus, and waits for kernel readiness', async () => {
    const oldBus = createMockBus();
    const freshBus = createMockBus();
    const disconnectSpy = vi.spyOn(oldBus.bus, 'disconnect');
    freshBus.request.mockImplementation((subject: unknown) => {
      if (subject === KernelSubjects.isReady) {
        return Promise.resolve({ ready: true, machineId: 'machine-1' });
      }
      return Promise.resolve({});
    });

    const deps = makeDeps({
      probeHealth: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ auth: false }),
      connectBusClient: vi.fn(async () => freshBus.bus),
    });

    const restartAndReconnect = createSetupRestartAndReconnect(
      { healthDownTimeoutMs: 1, healthUpTimeoutMs: 1, kernelReadyTimeoutMs: 1, pollIntervalMs: 0 },
      deps,
    );

    const result = await restartAndReconnect(oldBus.bus, 'setup');

    expect(result).toBe(freshBus.bus);
    expect(deps.requestKernelRestart).toHaveBeenCalledWith(oldBus.bus, 'setup');
    expect(disconnectSpy).toHaveBeenCalledOnce();
    expect(deps.connectBusClient).toHaveBeenCalledWith('ws://127.0.0.1:6252/bus', {
      auth: undefined,
      autoReconnect: true,
    });
    expect(freshBus.request).toHaveBeenCalledWith(KernelSubjects.isReady, {});
  });

  it('uses auth resolved from the restarted health response', async () => {
    const freshBus = createMockBus();
    freshBus.request.mockResolvedValue({ ready: true, machineId: 'machine-1' });
    const auth = { kind: 'test-auth' };
    const deps = makeDeps({
      probeHealth: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ auth: true }),
      resolveClientAuth: vi.fn(() => auth as never),
      connectBusClient: vi.fn(async () => freshBus.bus),
    });

    const restartAndReconnect = createSetupRestartAndReconnect(
      { healthDownTimeoutMs: 1, healthUpTimeoutMs: 1, kernelReadyTimeoutMs: 1, pollIntervalMs: 0 },
      deps,
    );

    await restartAndReconnect(createMockBus().bus, 'setup');

    expect(deps.resolveClientAuth).toHaveBeenCalledWith({ auth: true });
    expect(deps.connectBusClient).toHaveBeenCalledWith(expect.any(String), { auth, autoReconnect: true });
  });

  it('uses desktop launch fallback when health does not return after shutdown', async () => {
    const freshBus = createMockBus();
    freshBus.request.mockResolvedValue({ ready: true, machineId: 'machine-1' });
    const deps = makeDeps({
      probeHealth: vi.fn().mockResolvedValue(null),
      launchAppAndWaitForBus: vi.fn(async () => ({ health: { auth: false } })),
      connectBusClient: vi.fn(async () => freshBus.bus),
    });

    const restartAndReconnect = createSetupRestartAndReconnect(
      { healthDownTimeoutMs: 1, healthUpTimeoutMs: 1, kernelReadyTimeoutMs: 1, pollIntervalMs: 0 },
      deps,
    );

    await restartAndReconnect(createMockBus().bus, 'setup');

    expect(deps.launchAppAndWaitForBus).toHaveBeenCalledWith('ws://127.0.0.1:6252/bus');
    expect(deps.connectBusClient).toHaveBeenCalledOnce();
  });

  it('continues when restart downtime is too brief to observe', async () => {
    const oldBus = createMockBus();
    const freshBus = createMockBus();
    const disconnectSpy = vi.spyOn(oldBus.bus, 'disconnect');
    freshBus.request.mockResolvedValue({ ready: true, machineId: 'machine-1' });
    const deps = makeDeps({
      probeHealth: vi.fn(async () => ({ auth: false })),
      connectBusClient: vi.fn(async () => freshBus.bus),
    });

    const restartAndReconnect = createSetupRestartAndReconnect(
      { healthDownTimeoutMs: 1, healthUpTimeoutMs: 1, kernelReadyTimeoutMs: 1, pollIntervalMs: 0 },
      deps,
    );

    const result = await restartAndReconnect(oldBus.bus, 'setup');

    expect(result).toBe(freshBus.bus);
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });

  it('disconnects the restarted bus when kernel readiness fails', async () => {
    const freshBus = createMockBus();
    const disconnectSpy = vi.spyOn(freshBus.bus, 'disconnect');
    freshBus.request.mockRejectedValue(new Error('not ready'));
    const deps = makeDeps({
      probeHealth: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ auth: false }),
      connectBusClient: vi.fn(async () => freshBus.bus),
    });

    const restartAndReconnect = createSetupRestartAndReconnect(
      { healthDownTimeoutMs: 1, healthUpTimeoutMs: 1, kernelReadyTimeoutMs: 1, pollIntervalMs: 0 },
      deps,
    );

    await expect(restartAndReconnect(createMockBus().bus, 'setup')).rejects.toThrow('Kernel readiness probe failed');
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });
});
