import { afterEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { FrameworkContractNamespaces } from '@makaio/contracts';
import { FrameworkServicesCoreNamespaces } from '@makaio/services-core';
import { AdapterRuntimeSubjects, buildDeterministicAdapterId } from '@makaio/services-core/adapter-runtime';
import { activateAdapterRuntimeIdentity } from '../compose-adapter-runtime.js';

/**
 * These tests exercise the locality kernel of the self-contained Worker
 * runtime: `activateAdapterRuntimeIdentity` registers `resolveId` so that an
 * adapter name resolves to the deterministic id derived from THIS runtime's
 * machine id. An adapter started inside a container must therefore resolve to
 * an id scoped to the container's machine id — routing to the container's own
 * adapter, never the host's.
 */
describe('activateAdapterRuntimeIdentity', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  /**
   * Build a fresh, transport-less bus with the namespaces a real runtime
   * registers, so identity subjects are locally schema-routed.
   * @returns An isolated bus instance ready for identity-handler registration.
   */
  function makeBus(): IMakaioBus {
    const bus = createBusInstance();
    bus.registerNamespaces(FrameworkContractNamespaces);
    bus.registerNamespaces(FrameworkServicesCoreNamespaces);
    return bus;
  }

  it('resolves an adapter name to the deterministic id derived from the runtime machine id', async () => {
    const bus = makeBus();
    const machineId = 'container-machine-id';
    const { cleanup } = activateAdapterRuntimeIdentity({ bus, currentMachineId: machineId });
    cleanups.push(cleanup);

    const { adapterId } = await bus.request(AdapterRuntimeSubjects.resolveId, { adapterName: 'claude-code-cli' });

    expect(adapterId).toBe(buildDeterministicAdapterId(machineId, 'claude-code-cli'));
  });

  it('derives machine-scoped ids: host and container resolve the same name to different ids', async () => {
    const hostBus = makeBus();
    const containerBus = makeBus();
    const host = activateAdapterRuntimeIdentity({ bus: hostBus, currentMachineId: 'host-machine' });
    const container = activateAdapterRuntimeIdentity({ bus: containerBus, currentMachineId: 'container-machine' });
    cleanups.push(host.cleanup, container.cleanup);

    const hostResolved = await hostBus.request(AdapterRuntimeSubjects.resolveId, { adapterName: 'claude-code-cli' });
    const containerResolved = await containerBus.request(AdapterRuntimeSubjects.resolveId, {
      adapterName: 'claude-code-cli',
    });

    expect(hostResolved.adapterId).toBe(buildDeterministicAdapterId('host-machine', 'claude-code-cli'));
    expect(containerResolved.adapterId).toBe(buildDeterministicAdapterId('container-machine', 'claude-code-cli'));
    // The locality invariant: a container-resolved id is NOT the host's id, so a
    // container-started adapter routes to the container, not the dispatcher.
    expect(containerResolved.adapterId).not.toBe(hostResolved.adapterId);
  });

  it('honours an explicit machineId in the request over the runtime default', async () => {
    const bus = makeBus();
    const { cleanup } = activateAdapterRuntimeIdentity({ bus, currentMachineId: 'runtime-default' });
    cleanups.push(cleanup);

    const { adapterId } = await bus.request(AdapterRuntimeSubjects.resolveId, {
      adapterName: 'claude-code-cli',
      machineId: 'explicit-machine',
    });

    expect(adapterId).toBe(buildDeterministicAdapterId('explicit-machine', 'claude-code-cli'));
  });

  it('uses the supplied live resolver for local requests, including an explicit live adapter ID', async () => {
    const bus = makeBus();
    const resolvedNames: string[] = [];
    const { cleanup } = activateAdapterRuntimeIdentity({
      bus,
      currentMachineId: 'runtime-machine',
      resolveLiveAdapterId: (adapterName) => {
        resolvedNames.push(adapterName);
        return 'host-configured-live-adapter-id';
      },
    });
    cleanups.push(cleanup);

    await expect(bus.request(AdapterRuntimeSubjects.resolveId, { adapterName: 'claude-code-cli' })).resolves.toEqual({
      adapterId: 'host-configured-live-adapter-id',
    });
    await expect(
      bus.request(AdapterRuntimeSubjects.resolveId, {
        adapterName: 'claude-code-cli',
        machineId: 'runtime-machine',
      }),
    ).resolves.toEqual({ adapterId: 'host-configured-live-adapter-id' });
    expect(resolvedNames).toEqual(['claude-code-cli', 'claude-code-cli']);
  });

  it('refuses a local name when the authoritative live resolver has no instance', async () => {
    const bus = makeBus();
    const { cleanup } = activateAdapterRuntimeIdentity({
      bus,
      currentMachineId: 'runtime-machine',
      resolveLiveAdapterId: () => undefined,
    });
    cleanups.push(cleanup);

    await expect(bus.request(AdapterRuntimeSubjects.resolveId, { adapterName: 'not-live' })).rejects.toThrow(
      /No live local adapter is registered/,
    );
  });

  it('derives explicitly foreign requests without reading a local live instance', async () => {
    const bus = makeBus();
    let resolverCalls = 0;
    const { cleanup } = activateAdapterRuntimeIdentity({
      bus,
      currentMachineId: 'runtime-machine',
      resolveLiveAdapterId: () => {
        resolverCalls += 1;
        return 'local-live-adapter-id';
      },
    });
    cleanups.push(cleanup);

    await expect(
      bus.request(AdapterRuntimeSubjects.resolveId, {
        adapterName: 'claude-code-cli',
        machineId: 'foreign-machine',
      }),
    ).resolves.toEqual({
      adapterId: buildDeterministicAdapterId('foreign-machine', 'claude-code-cli'),
    });
    expect(resolverCalls).toBe(0);
  });

  it('cleanup unregisters the identity handlers (resolveId + resolveName)', async () => {
    const bus = makeBus();
    const { cleanup } = activateAdapterRuntimeIdentity({ bus, currentMachineId: 'm' });

    cleanup();

    const idResult = await bus.requestOptional(AdapterRuntimeSubjects.resolveId, { adapterName: 'claude-code-cli' });
    expect(idResult.handled).toBe(false);
    const nameResult = await bus.requestOptional(AdapterRuntimeSubjects.resolveName, { adapterId: 'some-id' });
    expect(nameResult.handled).toBe(false);
  });
});
