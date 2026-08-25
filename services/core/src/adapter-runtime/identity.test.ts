import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusContext, createBusInstance, MakaioBus } from '@makaio/bus-core';
import { AdapterNamespace, AdapterSubjects } from '@makaio/contracts';
import { WebSocketServer } from 'ws';
import { createBidirectionalTransportPair } from '../../../../core/bus-core/src/__tests__/helpers/transport-fixtures.js';
import { ServerTransport } from '../../../../transports/ws/src/server-transport.js';
import { WebSocketClientTransport } from '../../../../transports/ws/src/ws-client-transport.js';
import { buildDeterministicAdapterId, registerAdapterRuntimeIdentityHandlers } from './identity.js';
import { AdapterRuntimeNamespace, AdapterRuntimeSubjects } from './namespace.js';

describe('registerAdapterRuntimeIdentityHandlers', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    MakaioBus.__resetHandlers?.();
  });

  it('uses the live resolver for local requests and remembers its explicit ID for reverse lookup', async () => {
    cleanup = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
      currentMachineId: 'local-machine',
      resolveLiveAdapterId: (adapterName) => (adapterName === 'local-adapter' ? 'explicit-live-id' : undefined),
    }).cleanup;

    await expect(
      MakaioBus.request(AdapterRuntimeSubjects.resolveId, { adapterName: 'local-adapter' }),
    ).resolves.toEqual({ adapterId: 'explicit-live-id' });
    await expect(
      MakaioBus.request(AdapterRuntimeSubjects.resolveName, { adapterId: 'explicit-live-id' }),
    ).resolves.toEqual({ adapterName: 'local-adapter' });
  });

  it('refuses a local name absent from the live resolver instead of deriving an ID', async () => {
    cleanup = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
      currentMachineId: 'local-machine',
      resolveLiveAdapterId: () => undefined,
    }).cleanup;

    await expect(
      MakaioBus.request(AdapterRuntimeSubjects.resolveId, { adapterName: 'disabled-adapter' }),
    ).rejects.toThrow(/No live local adapter is registered/);
  });

  it('delegates a same-machine name miss to the sibling runtime that owns the adapter', async () => {
    const ownerBus = createBusInstance({ context: createBusContext() });
    const siblingBus = createBusInstance({ context: createBusContext() });
    for (const bus of [ownerBus, siblingBus]) bus.registerNamespace(AdapterRuntimeNamespace);

    const ownerHandlers = registerAdapterRuntimeIdentityHandlers(ownerBus, {
      currentMachineId: 'shared-machine',
      resolveLiveAdapterId: (adapterName) => (adapterName === 'owned-adapter' ? 'owned-adapter-id' : undefined),
    });
    const siblingHandlers = registerAdapterRuntimeIdentityHandlers(siblingBus, {
      currentMachineId: 'shared-machine',
      resolveLiveAdapterId: () => undefined,
    });
    const { sideA, sideB } = createBidirectionalTransportPair({ label: 'same-machine-resolve-id' });
    ownerBus.registerTransport(sideA);
    siblingBus.registerTransport(sideB);
    siblingBus
      .getContext()
      .remoteRequestHandlers.set('adapterRuntime.resolveId', [{ transport: sideB.name, priority: 0 }]);

    try {
      await expect(
        siblingBus.request(AdapterRuntimeSubjects.resolveId, {
          adapterName: 'owned-adapter',
          machineId: 'shared-machine',
        }),
      ).resolves.toEqual({ adapterId: 'owned-adapter-id' });
    } finally {
      siblingBus.disconnect();
      ownerBus.disconnect();
      siblingHandlers.cleanup();
      ownerHandlers.cleanup();
    }
  });

  it('keeps explicitly foreign requests deterministic without consulting the local resolver', async () => {
    let resolverCalls = 0;
    cleanup = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
      currentMachineId: 'local-machine',
      resolveLiveAdapterId: () => {
        resolverCalls += 1;
        return 'explicit-live-id';
      },
    }).cleanup;

    await expect(
      MakaioBus.request(AdapterRuntimeSubjects.resolveId, {
        adapterName: 'local-adapter',
        machineId: 'foreign-machine',
      }),
    ).resolves.toEqual({
      adapterId: buildDeterministicAdapterId('foreign-machine', 'local-adapter'),
    });
    expect(resolverCalls).toBe(0);
  });

  it('indexes opaque initialized IDs by their exact adapter name and machine', async () => {
    cleanup = registerAdapterRuntimeIdentityHandlers(MakaioBus, { currentMachineId: 'local-machine' }).cleanup;

    await MakaioBus.emit(AdapterSubjects.initialized, {
      adapterId: 'host-issued/opaque:id',
      adapterName: 'opaque-adapter',
      machineId: 'foreign-machine',
      ownerInstanceId: 'foreign-owner',
      capabilities: [],
    });

    await expect(
      MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, {
        adapterId: 'host-issued/opaque:id',
        adapterName: 'opaque-adapter',
        machineId: 'foreign-machine',
      }),
    ).resolves.toEqual({
      adapterId: 'host-issued/opaque:id',
      adapterName: 'opaque-adapter',
      machineId: 'foreign-machine',
      ownerInstanceId: 'foreign-owner',
    });
    await expect(
      MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, {
        adapterId: 'host-issued/opaque:id',
        adapterName: 'opaque-adapter',
        machineId: 'local-machine',
      }),
    ).rejects.toThrow(/No live adapter matches/);
  });

  it('uses the current runtime snapshot after handlers register and refuses it after retraction', async () => {
    let live = true;
    cleanup = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
      currentMachineId: 'local-machine',
      listLiveAdapterIdentities: () =>
        live
          ? [
              {
                adapterId: 'opaque-local-id',
                adapterName: 'local-adapter',
                machineId: 'local-machine',
                ownerInstanceId: 'local-owner',
              },
            ]
          : [],
      resolveLiveAdapterIdentity: (adapterId) =>
        live && adapterId === 'opaque-local-id'
          ? { adapterId, adapterName: 'local-adapter', machineId: 'local-machine', ownerInstanceId: 'local-owner' }
          : undefined,
    }).cleanup;

    const request = { adapterId: 'opaque-local-id', adapterName: 'local-adapter', machineId: 'local-machine' };
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, request)).resolves.toEqual({
      ...request,
      ownerInstanceId: 'local-owner',
    });
    live = false;
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, request)).rejects.toThrow(
      /No live adapter matches/,
    );
  });

  it('evicts a remote announcement when its lifecycle retraction arrives', async () => {
    cleanup = registerAdapterRuntimeIdentityHandlers(MakaioBus, { currentMachineId: 'local-machine' }).cleanup;
    const identity = {
      adapterId: 'opaque-remote-id',
      adapterName: 'remote-adapter',
      machineId: 'remote-machine',
      ownerInstanceId: 'remote-owner',
    };
    await MakaioBus.emit(AdapterSubjects.initialized, { ...identity, capabilities: [] });
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, identity)).resolves.toEqual(identity);
    await MakaioBus.emit(AdapterSubjects.deinitialized, identity);
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, identity)).rejects.toThrow(
      /No live adapter matches/,
    );
  });

  it('delegates a sibling runtime miss to the adapter-owning runtime on the same machine', async () => {
    const targetBus = createBusInstance({ context: createBusContext() });
    const lateBus = createBusInstance({ context: createBusContext() });
    for (const bus of [targetBus, lateBus]) {
      bus.registerNamespace(AdapterNamespace);
      bus.registerNamespace(AdapterRuntimeNamespace);
    }

    const identity = {
      adapterId: 'opaque-target-id',
      adapterName: 'target-adapter',
      machineId: 'shared-machine',
      ownerInstanceId: 'target-owner',
    };
    const targetHandlers = registerAdapterRuntimeIdentityHandlers(targetBus, {
      currentMachineId: identity.machineId,
      resolveLiveAdapterIdentity: (adapterId) => (adapterId === identity.adapterId ? identity : undefined),
    });
    await targetBus.emit(AdapterSubjects.initialized, { ...identity, capabilities: [] });

    const lateHandlers = registerAdapterRuntimeIdentityHandlers(lateBus, {
      currentMachineId: identity.machineId,
      resolveLiveAdapterIdentity: () => undefined,
    });
    expect(lateHandlers.registry.resolveLiveIdentity(identity)).toBeUndefined();

    const { sideA, sideB } = createBidirectionalTransportPair({ label: 'late-identity' });
    targetBus.registerTransport(sideA);
    lateBus.registerTransport(sideB);
    lateBus
      .getContext()
      .remoteRequestHandlers.set('adapterRuntime.resolveLiveIdentity', [{ transport: sideB.name, priority: 0 }]);

    try {
      await expect(lateBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, identity)).resolves.toEqual(identity);
    } finally {
      lateBus.disconnect();
      targetBus.disconnect();
      lateHandlers.cleanup();
      targetHandlers.cleanup();
    }
  });

  it('retains shared-machine owners and retracts only the withdrawn owner', async () => {
    const handlers = registerAdapterRuntimeIdentityHandlers(MakaioBus, { currentMachineId: 'local-machine' });
    cleanup = handlers.cleanup;
    const triple = { adapterId: 'shared-adapter', adapterName: 'shared', machineId: 'shared-machine' };
    const first = { ...triple, ownerInstanceId: 'owner-a' };
    const second = { ...triple, ownerInstanceId: 'owner-b' };
    await MakaioBus.emit(AdapterSubjects.initialized, { ...first, capabilities: [] });
    await MakaioBus.emit(AdapterSubjects.initialized, { ...second, capabilities: [] });
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, triple)).rejects.toThrow(
      /No live adapter matches/,
    );
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, first)).resolves.toEqual(first);
    await MakaioBus.emit(AdapterSubjects.deinitialized, first);
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, first)).rejects.toThrow(
      /No live adapter matches/,
    );
    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, triple)).resolves.toEqual(second);
  });

  it('does not let a local resolver choose an ownerless shared-machine target', async () => {
    cleanup = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
      currentMachineId: 'shared-machine',
      resolveLiveAdapterIdentity: () => ({
        adapterId: 'shared-adapter',
        adapterName: 'shared',
        machineId: 'shared-machine',
        ownerInstanceId: 'owner-a',
      }),
    }).cleanup;
    const triple = { adapterId: 'shared-adapter', adapterName: 'shared', machineId: 'shared-machine' };
    await MakaioBus.emit(AdapterSubjects.initialized, { ...triple, ownerInstanceId: 'owner-a', capabilities: [] });
    await MakaioBus.emit(AdapterSubjects.initialized, { ...triple, ownerInstanceId: 'owner-b', capabilities: [] });

    await expect(MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, triple)).rejects.toThrow(
      /No live adapter matches/,
    );
  });

  it('delegates an exact owner target past a non-owning same-machine runtime', async () => {
    const targetBus = createBusInstance({ context: createBusContext() });
    const nonOwnerBus = createBusInstance({ context: createBusContext() });
    for (const bus of [targetBus, nonOwnerBus]) {
      bus.registerNamespace(AdapterNamespace);
      bus.registerNamespace(AdapterRuntimeNamespace);
    }
    const target = {
      adapterId: 'shared-adapter',
      adapterName: 'shared',
      machineId: 'shared-machine',
      ownerInstanceId: 'owner-target',
    };
    const nonOwner = { ...target, ownerInstanceId: 'owner-other' };
    const targetHandlers = registerAdapterRuntimeIdentityHandlers(targetBus, {
      currentMachineId: target.machineId,
      resolveLiveAdapterIdentity: () => target,
    });
    const nonOwnerHandlers = registerAdapterRuntimeIdentityHandlers(nonOwnerBus, {
      currentMachineId: target.machineId,
      resolveLiveAdapterIdentity: () => nonOwner,
    });
    const { sideA, sideB } = createBidirectionalTransportPair({ label: 'owner-targeted-identity' });
    targetBus.registerTransport(sideA);
    nonOwnerBus.registerTransport(sideB);
    nonOwnerBus
      .getContext()
      .remoteRequestHandlers.set('adapterRuntime.resolveLiveIdentity', [{ transport: sideB.name, priority: 0 }]);

    try {
      await expect(nonOwnerBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, target)).resolves.toEqual(target);
    } finally {
      nonOwnerBus.disconnect();
      targetBus.disconnect();
      nonOwnerHandlers.cleanup();
      targetHandlers.cleanup();
    }
  });

  it('routes same-machine resolver misses through a real WebSocket hub to the owning runtime', async () => {
    const hubBus = createBusInstance({ context: createBusContext() });
    const callerBus = createBusInstance({ context: createBusContext() });
    const ownerBus = createBusInstance({ context: createBusContext() });
    for (const bus of [hubBus, callerBus, ownerBus]) {
      bus.registerNamespace(AdapterNamespace);
      bus.registerNamespace(AdapterRuntimeNamespace);
    }

    const websocket = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      websocket.once('listening', resolve);
      websocket.once('error', reject);
    });
    const address = websocket.address();
    if (address === null || typeof address === 'string') throw new Error('Test WebSocket server did not expose a port');

    const hubTransport = new ServerTransport({ websocket, name: 'owner-routing-hub' });
    const callerTransport = new WebSocketClientTransport({
      url: `ws://localhost:${address.port}`,
      name: 'owner-routing-caller',
      autoReconnect: false,
    });
    const ownerTransport = new WebSocketClientTransport({
      url: `ws://localhost:${address.port}`,
      name: 'owner-routing-owner',
      autoReconnect: false,
    });
    hubBus.registerTransport(hubTransport);
    callerBus.registerTransport(callerTransport);
    ownerBus.registerTransport(ownerTransport);

    const identity = {
      adapterId: 'shared-adapter-id',
      adapterName: 'shared-adapter',
      machineId: 'shared-machine',
      ownerInstanceId: 'owner-runtime',
    };
    const nonOwnerHandlers = registerAdapterRuntimeIdentityHandlers(hubBus, {
      currentMachineId: identity.machineId,
      resolveLiveAdapterId: () => undefined,
      resolveLiveAdapterIdentity: () => undefined,
    });
    const ownerHandlers = registerAdapterRuntimeIdentityHandlers(ownerBus, {
      currentMachineId: identity.machineId,
      resolveLiveAdapterId: (adapterName) => (adapterName === identity.adapterName ? identity.adapterId : undefined),
      resolveLiveAdapterIdentity: (adapterId) => (adapterId === identity.adapterId ? identity : undefined),
    });

    try {
      await Promise.all([hubBus.connect(), callerBus.connect(), ownerBus.connect()]);
      await Promise.all([hubBus.ready, callerBus.ready, ownerBus.ready]);
      await expect.poll(() => callerBus.getContext().remoteRequestHandlers.has('adapterRuntime.resolveId')).toBe(true);
      await expect
        .poll(() => callerBus.getContext().remoteRequestHandlers.has('adapterRuntime.resolveLiveIdentity'))
        .toBe(true);

      await expect(
        callerBus.request(AdapterRuntimeSubjects.resolveId, {
          adapterName: identity.adapterName,
          machineId: identity.machineId,
        }),
      ).resolves.toEqual({ adapterId: identity.adapterId });
      await expect(callerBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, identity)).resolves.toEqual(identity);
    } finally {
      nonOwnerHandlers.cleanup();
      ownerHandlers.cleanup();
      callerBus.disconnect();
      ownerBus.disconnect();
      hubBus.disconnect();
    }
  });
});
