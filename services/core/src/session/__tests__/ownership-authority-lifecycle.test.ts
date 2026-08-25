/**
 * Authority retirement lifecycle tests.
 *
 * These use the real bus and authority handlers. Storage handlers are kept
 * deliberately narrow because the invariant under test is ordering at the
 * service seam: admission, drain, teardown evidence, then retirement.
 */
import { describe, expect, it } from 'vitest';
import {
  createBusInstance,
  RequestError,
  type BusMessage,
  type BusTransport,
  type BusTransportRegistry,
} from '@makaio/bus-core';
import { SessionOwnershipStorageSubjects, SessionSubjects, type AdapterSessionClaimRecord } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMemorySessionBackends } from './shared.js';
import { OwnershipAuthorityClosedError, registerSessionOwnershipAuthority } from '../ownership/authority.js';
import { assessClaimOwner } from '../ownership/owner-liveness.js';

/** A promise whose completion a lifecycle test controls. */
interface Deferred {
  /** Promise observed by the subject under test. */
  readonly promise: Promise<void>;
  /** Complete the promise. */
  readonly resolve: () => void;
}

/** @returns A new externally controlled promise. */
function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('ownership authority lifecycle', () => {
  it('drains an admitted operation before retiring and makes repeated close a no-op', async () => {
    const bus = createBusInstance();
    const releaseGate = deferred();
    const releaseEntered = deferred();
    const order: string[] = [];
    let retireCalls = 0;

    const storageCleanups = [
      bus.on(SessionOwnershipStorageSubjects.releaseAgentClaims, async (ctx) => {
        releaseEntered.resolve();
        await releaseGate.promise;
        order.push('operation-committed');
        ctx.setResult({ releasedProviderSessionIds: [], markedClaims: [], claimTokenNotFound: false });
      }),
      bus.on(SessionOwnershipStorageSubjects.retireInstance, (ctx) => {
        retireCalls += 1;
        order.push('instance-retired');
        ctx.setResult({ retiredMachines: 1 });
      }),
    ];
    const registered = registerSessionOwnershipAuthority({
      bus,
      machineId: 'machine-1',
      instanceId: 'instance-1',
      topology: 'shared-machine',
    });

    try {
      const operation = bus.request(SessionSubjects.ownership.release, {
        agentId: 'agent-1',
        disposition: 'released',
      });
      await releaseEntered.promise;
      await bus.emit(AdapterRuntimeSubjects.teardownCompleted, {
        ownerInstanceId: registered.ownership.instanceId,
        evidence: 'released',
      });

      let closeSettled = false;
      const closing = registered.ownership.close().then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      expect(retireCalls).toBe(0);

      releaseGate.resolve();
      await operation;
      await closing;
      expect(order).toEqual(['operation-committed', 'instance-retired']);

      await registered.ownership.close();
      expect(retireCalls).toBe(1);
    } finally {
      for (const cleanup of [...registered.cleanups, ...storageCleanups]) cleanup();
    }
  });

  it('rejects a handler snapshotted before close without reaching storage', async () => {
    const bus = createBusInstance();
    const transportReady = deferred();
    let storageWrites = 0;
    const transport: BusTransport = {
      name: 'ownership-captured-handler',
      ready: transportReady.promise,
      send: (async (_message: BusMessage) => true) as BusTransport['send'],
      onReceive: () => () => undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    };
    const transportRegistration = bus
      .getContext()
      .transportRegistry.registerTransport('ownership-captured-handler' as keyof BusTransportRegistry, transport);
    const storageCleanup = bus.on(SessionOwnershipStorageSubjects.releaseAgentClaims, (ctx) => {
      storageWrites += 1;
      ctx.setResult({ releasedProviderSessionIds: [], markedClaims: [], claimTokenNotFound: false });
    });
    const registered = registerSessionOwnershipAuthority({
      bus,
      machineId: 'machine-1',
      instanceId: 'instance-1',
      topology: 'shared-machine',
    });

    try {
      const captured = bus.request(SessionSubjects.ownership.release, {
        agentId: 'agent-late',
        disposition: 'released',
      });
      await Promise.resolve();
      await registered.ownership.close();
      transportReady.resolve();

      const refusal = await captured.catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(RequestError);
      expect((refusal as RequestError).cause).toBeInstanceOf(OwnershipAuthorityClosedError);
      expect(storageWrites).toBe(0);
    } finally {
      for (const cleanup of registered.cleanups) cleanup();
      storageCleanup();
      transportRegistration.unregister();
    }
  });

  it.each([
    { evidence: undefined, expectedRetireCalls: 0 },
    { evidence: 'detached' as const, expectedRetireCalls: 0 },
    { evidence: 'unknown' as const, expectedRetireCalls: 0 },
    { evidence: 'closed' as const, expectedRetireCalls: 1 },
  ])('retires only after observed aggregate evidence: $evidence', async ({ evidence, expectedRetireCalls }) => {
    const bus = createBusInstance();
    let retireCalls = 0;
    const retireCleanup = bus.on(SessionOwnershipStorageSubjects.retireInstance, (ctx) => {
      retireCalls += 1;
      ctx.setResult({ retiredMachines: 1 });
    });
    const registered = registerSessionOwnershipAuthority({
      bus,
      machineId: 'machine-1',
      instanceId: 'instance-1',
      topology: 'shared-machine',
    });

    try {
      if (evidence !== undefined) {
        await bus.emit(AdapterRuntimeSubjects.teardownCompleted, {
          ownerInstanceId: registered.ownership.instanceId,
          evidence,
        });
      }
      await registered.ownership.close();
      expect(retireCalls).toBe(expectedRetireCalls);
    } finally {
      for (const cleanup of registered.cleanups) cleanup();
      retireCleanup();
    }
  });

  it('ignores teardown evidence produced by another runtime incarnation', async () => {
    const bus = createBusInstance();
    let retireCalls = 0;
    const retireCleanup = bus.on(SessionOwnershipStorageSubjects.retireInstance, (ctx) => {
      retireCalls += 1;
      ctx.setResult({ retiredMachines: 1 });
    });
    const registered = registerSessionOwnershipAuthority({
      bus,
      machineId: 'machine-1',
      instanceId: 'instance-1',
      topology: 'shared-machine',
    });

    try {
      await bus.emit(AdapterRuntimeSubjects.teardownCompleted, {
        ownerInstanceId: 'instance-foreign',
        evidence: 'released',
      });
      await registered.ownership.close();
      expect(retireCalls).toBe(0);
    } finally {
      for (const cleanup of registered.cleanups) cleanup();
      retireCleanup();
    }
  });

  it('mints a new owner identity when a destroyed service is initialized again', async () => {
    const bus = createBusInstance();
    const storageCleanups = registerMemorySessionBackends(bus);
    const service = new MakaioSessionService(bus, { machineId: 'machine-reinit' });

    /**
     * Allocate one real generation through the current authority lifecycle.
     * @param suffix - Unique agent and provider-key suffix.
     * @returns Owner identity persisted on the resulting claim.
     */
    async function allocate(suffix: string): Promise<string> {
      const sessionId = 'session-reinit';
      const agentId = `agent-${suffix}`;
      const now = Date.now();
      const existing = await bus.request(SessionSubjects.get, { sessionId });
      if (existing.session === null) await bus.request(SessionSubjects.create, { sessionId });
      await bus.request(AgentStorageSubjects.set, {
        agentId,
        agent: {
          agentId,
          adapterId: 'adapter-reinit',
          adapterName: 'test-adapter',
          sessionId,
          role: 'member',
          status: 'idle',
          createdAt: now,
          lastActivityAt: now,
        },
      });
      const result = await bus.request(SessionSubjects.ownership.reserveStart, {
        sessionId,
        agentId,
        adapterId: 'adapter-reinit',
        adapterName: 'test-adapter',
        ownerInstanceId: service.requireOwnershipInstanceId(),
        role: 'member',
        resumeProviderSessionId: `provider-${suffix}`,
        claimToken: crypto.randomUUID(),
      });
      if (result.outcome !== 'reserved' || result.reservation.claim === null) {
        throw new Error(`Expected keyed reservation, received ${result.outcome}`);
      }
      const ownerInstanceId = result.reservation.claim.ownerInstanceId;
      if (ownerInstanceId === null) throw new Error('New generation did not carry owner identity');
      return ownerInstanceId;
    }

    try {
      await service.init();
      const firstAccessorInstanceId = service.requireOwnershipInstanceId();
      const firstInstanceId = await allocate('first');
      expect(firstInstanceId).toBe(firstAccessorInstanceId);
      await bus.emit(AdapterRuntimeSubjects.teardownCompleted, {
        ownerInstanceId: firstInstanceId,
        evidence: 'released',
      });
      await service.destroy();
      expect(() => service.requireOwnershipInstanceId()).toThrow('not initialized');

      const retired = await bus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
        instanceId: firstInstanceId,
        machineId: 'machine-reinit',
      });
      expect(retired.instance?.retiredAt).not.toBeNull();

      await service.init();
      const secondAccessorInstanceId = service.requireOwnershipInstanceId();
      const secondInstanceId = await allocate('second');
      expect(secondInstanceId).not.toBe(firstInstanceId);
      expect(secondInstanceId).toBe(secondAccessorInstanceId);
      const live = await bus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
        instanceId: secondInstanceId,
        machineId: 'machine-reinit',
      });
      expect(live.instance?.retiredAt).toBeNull();

      await bus.emit(AdapterRuntimeSubjects.teardownCompleted, {
        ownerInstanceId: secondInstanceId,
        evidence: 'released',
      });
      await service.destroy();
    } finally {
      await service.destroy().catch(() => undefined);
      for (const cleanup of storageCleanups) cleanup();
    }
  });

  it('reports a retired owner before considering the topology-gated adapter probe', async () => {
    const bus = createBusInstance();
    const now = Date.now();
    const claim: AdapterSessionClaimRecord = {
      claimId: 'claim-retired',
      machineId: 'machine-1',
      adapterId: 'adapter-1',
      adapterName: 'test-adapter',
      providerSessionId: 'provider-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      ownerInstanceId: 'instance-retired',
      claimToken: 'token-retired',
      fence: 1,
      status: 'held',
      claimedAt: now,
      updatedAt: now,
    };
    const cleanups = [
      bus.on(AgentStorageSubjects.get, (ctx) => {
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: 'adapter-1',
            adapterName: 'test-adapter',
            sessionId: 'session-1',
            role: 'lead',
            status: 'idle',
            createdAt: now,
            lastActivityAt: now,
          },
        });
      }),
      bus.on(SessionOwnershipStorageSubjects.getRuntimeInstance, (ctx) => {
        ctx.setResult({
          instance: {
            instanceId: ctx.payload.instanceId,
            machineId: ctx.payload.machineId,
            incarnation: 1,
            startedAt: now - 1,
            retiredAt: now,
          },
        });
      }),
    ];

    try {
      await expect(assessClaimOwner(bus, 'shared-machine', claim)).resolves.toBe('owner-instance-retired');
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  });
});
