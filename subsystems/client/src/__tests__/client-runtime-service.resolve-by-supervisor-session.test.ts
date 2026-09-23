import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type ClientRuntimeObserved, type ClientRuntimeStarted } from '@makaio/contracts/client';
import { ClientAccountRegistry } from '../client-account-registry.js';
import { ClientRuntimeRegistry } from '../client-runtime-registry.js';
import { ClientRuntimeService } from '../client-runtime-service.js';
import { ClientRuntimeStorageSubjects } from '../storage/runtime-storage-namespace.js';

describe('ClientRuntimeService — runtime.resolveBySupervisorSessionId', () => {
  let bus: IMakaioBus;
  let registry: ClientRuntimeRegistry;
  let service: ClientRuntimeService;

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new ClientRuntimeRegistry(bus);
    service = new ClientRuntimeService(bus, new ClientAccountRegistry(), registry);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('reads a narrow, detached correlation for a known supervisor session without changing the registry', async () => {
    const supervisorSessionId = 'sup-codex-runtime-1';
    const beforeKnown = await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
      clientId: 'codex',
      supervisorSessionId,
    });

    expect(beforeKnown).toEqual({ runtime: null });
    expect(registry.size).toBe(0);

    const observed: ClientRuntimeObserved[] = [];
    const cleanup = bus.on(ClientSubjects.runtime.observed, ({ payload }) => {
      observed.push(payload);
    });

    const launched = await bus.request(ClientSubjects.runtime.observe, {
      clientId: 'codex',
      source: { layer: 'supervisor', producer: 'test-supervisor' },
      observedAt: 1_700_000_000_000,
      supervisorSessionId,
      pid: 4401,
      cwd: '/workspace/private-project',
      argv: ['codex', '--dangerously-bypass-approvals-and-sandbox'],
      metadata: { private: 'do-not-return' },
    });
    await bus.request(ClientSubjects.runtime.observe, {
      clientId: 'codex',
      source: { layer: 'adapter', producer: 'test-codex-adapter' },
      observedAt: 1_700_000_001_000,
      supervisorSessionId,
      pid: 4401,
      adapterSessionId: 'native-codex-session-1',
      sessionId: 'framework-session-1',
    });
    await bus.request(ClientSubjects.runtime.observe, {
      clientId: 'codex',
      source: { layer: 'adapter', producer: 'test-codex-adapter' },
      observedAt: 1_700_000_002_000,
      supervisorSessionId,
      pid: 4401,
      adapterSessionId: 'native-codex-session-1',
      sessionId: 'framework-session-1',
    });
    const recordBeforeRead = registry.getRuntime(launched.clientRuntimeId);

    const resolved = await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
      clientId: 'codex',
      supervisorSessionId,
    });

    expect(resolved).toEqual({
      runtime: {
        clientId: 'codex',
        supervisorSessionId,
        adapterSessionId: 'native-codex-session-1',
        sessionId: 'framework-session-1',
        updatedAt: expect.any(Number),
      },
    });
    expect(registry.size).toBe(1);
    expect(registry.getRuntime(launched.clientRuntimeId)).toEqual(recordBeforeRead);
    expect(observed).toEqual([
      expect.objectContaining({
        clientRuntimeId: launched.clientRuntimeId,
        supervisorSessionId,
      }),
      expect.objectContaining({
        clientRuntimeId: launched.clientRuntimeId,
        supervisorSessionId,
        adapterSessionId: 'native-codex-session-1',
      }),
      expect.objectContaining({
        clientRuntimeId: launched.clientRuntimeId,
        supervisorSessionId,
        adapterSessionId: 'native-codex-session-1',
      }),
    ]);
    expect(observed[0]!.adapterSessionId).toBeUndefined();
    expect(observed[1]!.updatedAt).toBeGreaterThan(observed[0]!.updatedAt);
    expect(observed[2]!.updatedAt).toBe(observed[1]!.updatedAt);

    expect(
      await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
        clientId: 'claude-code',
        supervisorSessionId,
      }),
    ).toEqual({ runtime: null });
    expect(
      await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
        clientId: 'codex',
        supervisorSessionId: 'sup-codex-runtime-other',
      }),
    ).toEqual({ runtime: null });

    if (resolved.runtime !== null) {
      resolved.runtime.adapterSessionId = 'mutated-by-caller';
    }
    cleanup();
    expect(registry.getRuntime(launched.clientRuntimeId)?.adapterSessionId).toBe('native-codex-session-1');
  });

  it('drains an admitted mutation before teardown, suppresses its late notification, and rejects a later observation', async () => {
    const persistenceEntered = Promise.withResolvers<void>();
    const releasePersistence = Promise.withResolvers<void>();
    const observed: ClientRuntimeObserved[] = [];
    const storageCleanup = bus.on(ClientRuntimeStorageSubjects.upsert, async (ctx) => {
      persistenceEntered.resolve();
      await releasePersistence.promise;
      ctx.setResult({ success: true });
    });
    const observedCleanup = bus.on(ClientSubjects.runtime.observed, (ctx) => {
      observed.push(ctx.payload);
    });

    try {
      const admitted = bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        observedAt: 1_700_000_003_000,
        supervisorSessionId: 'sup-destroy-drain',
      });
      await persistenceEntered.promise;

      let teardownComplete = false;
      const teardown = service.destroy().then(() => {
        teardownComplete = true;
      });
      await Promise.resolve();
      expect(teardownComplete).toBe(false);

      await expect(
        bus.request(ClientSubjects.runtime.observe, {
          clientId: 'codex',
          source: { layer: 'supervisor', producer: 'test-supervisor' },
          observedAt: 1_700_000_004_000,
          supervisorSessionId: 'sup-destroy-rejected',
        }),
      ).rejects.toThrow('client.runtime.observe: service is stopping');

      releasePersistence.resolve();
      await expect(admitted).resolves.toEqual({
        clientRuntimeId: expect.any(String),
        created: true,
        promoted: false,
      });
      await teardown;

      expect(registry.size).toBe(0);
      expect(observed).toEqual([]);
    } finally {
      observedCleanup();
      storageCleanup();
    }
  });

  it('rejects a stale selected observe handler after destroy and re-init', async () => {
    const dispatchEntered = Promise.withResolvers<void>();
    const releaseDispatch = Promise.withResolvers<void>();
    const gateCleanup = bus.on(
      ClientSubjects.runtime.observe,
      async (ctx) => {
        dispatchEntered.resolve();
        await releaseDispatch.promise;
        await ctx.next();
      },
      { priority: 100 },
    );

    try {
      const staleRequest = bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        observedAt: 1_700_000_004_500,
        supervisorSessionId: 'sup-stale-selected-handler',
      });
      await dispatchEntered.promise;

      await service.destroy();
      await service.init();
      releaseDispatch.resolve();

      await expect(staleRequest).rejects.toThrow('client.runtime.observe: service is stopping');
      expect(registry.size).toBe(0);

      await expect(
        bus.request(ClientSubjects.runtime.observe, {
          clientId: 'codex',
          source: { layer: 'supervisor', producer: 'test-supervisor' },
          observedAt: 1_700_000_005_000,
          supervisorSessionId: 'sup-current-handler',
        }),
      ).resolves.toEqual({
        clientRuntimeId: expect.any(String),
        created: true,
        promoted: false,
      });
      expect(registry.size).toBe(1);
    } finally {
      gateCleanup();
    }
  });

  it('does not block the observe response when an observed listener waits for service teardown', async () => {
    const started: ClientRuntimeStarted[] = [];
    const teardownFinished = Promise.withResolvers<void>();
    const observedCleanup = bus.on(ClientSubjects.runtime.observed, async () => {
      await service.destroy();
      teardownFinished.resolve();
    });
    const startedCleanup = bus.on(ClientSubjects.runtime.started, (ctx) => {
      started.push(ctx.payload);
    });

    try {
      await expect(
        bus.request(ClientSubjects.runtime.observe, {
          clientId: 'codex',
          source: { layer: 'supervisor', producer: 'test-supervisor' },
          observedAt: 1_700_000_005_000,
          supervisorSessionId: 'sup-observed-destroy',
        }),
      ).resolves.toEqual({
        clientRuntimeId: expect.any(String),
        created: true,
        promoted: false,
      });

      expect(registry.size).toBe(0);
      expect(started).toEqual([]);
      await teardownFinished.promise;
    } finally {
      observedCleanup();
      startedCleanup();
    }
  });

  it('delivers started to an observed listener that subscribes during its invocation', async () => {
    const startedSeenByObserved = Promise.withResolvers<ClientRuntimeStarted>();
    const observedCleanup = bus.on(ClientSubjects.runtime.observed, async () => {
      const started = await bus.once(ClientSubjects.runtime.started);
      startedSeenByObserved.resolve(started.payload);
    });

    try {
      const result = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        observedAt: 1_700_000_005_500,
        supervisorSessionId: 'sup-observed-subscribes-started',
      });

      await expect(startedSeenByObserved.promise).resolves.toMatchObject({
        clientRuntimeId: result.clientRuntimeId,
        supervisorSessionId: 'sup-observed-subscribes-started',
      });
    } finally {
      observedCleanup();
    }
  });

  it('delivers started to an observed listener through a synchronous interceptor', async () => {
    const startedSeenByObserved = Promise.withResolvers<ClientRuntimeStarted>();
    const interceptorCleanup = bus.intercept(ClientSubjects.runtime.observed, () => {});
    const observedCleanup = bus.on(ClientSubjects.runtime.observed, async () => {
      const started = await bus.once(ClientSubjects.runtime.started);
      startedSeenByObserved.resolve(started.payload);
    });

    try {
      const result = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        observedAt: 1_700_000_005_600,
        supervisorSessionId: 'sup-observed-sync-interceptor',
      });

      await expect(startedSeenByObserved.promise).resolves.toMatchObject({
        clientRuntimeId: result.clientRuntimeId,
        supervisorSessionId: 'sup-observed-sync-interceptor',
      });
    } finally {
      observedCleanup();
      interceptorCleanup();
    }
  });

  it('keeps a committed observation request successful when runtime event listeners throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deliveries: string[] = [];
    const observedCleanup = bus.on(ClientSubjects.runtime.observed, () => {
      deliveries.push('observed');
      throw new Error('observed listener failed');
    });
    const startedCleanup = bus.on(ClientSubjects.runtime.started, () => {
      deliveries.push('started');
      throw new Error('started listener failed');
    });
    try {
      const result = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        observedAt: 1_700_000_003_000,
        supervisorSessionId: 'sup-listener-failure',
      });

      expect(result.created).toBe(true);
      expect(deliveries).toEqual(['observed', 'started']);
      expect(
        await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
          clientId: 'codex',
          supervisorSessionId: 'sup-listener-failure',
        }),
      ).toEqual({
        runtime: {
          clientId: 'codex',
          supervisorSessionId: 'sup-listener-failure',
          updatedAt: expect.any(Number),
        },
      });
      expect(warn).toHaveBeenCalledWith(
        '[ClientRuntimeService] Failed to emit client.runtime.observed:',
        expect.any(Error),
      );
      expect(warn).toHaveBeenCalledWith(
        '[ClientRuntimeService] Failed to emit client.runtime.started:',
        expect.any(Error),
      );
    } finally {
      observedCleanup();
      startedCleanup();
      warn.mockRestore();
    }
  });

  it('does not commit or emit a runtime snapshot when storage explicitly rejects create or enrichment', async () => {
    let rejectPersistence = true;
    const observed: ClientRuntimeObserved[] = [];
    const started: ClientRuntimeStarted[] = [];
    const storageCleanup = bus.on(ClientRuntimeStorageSubjects.upsert, (ctx) => {
      ctx.setResult({ success: !rejectPersistence });
    });
    const observedCleanup = bus.on(ClientSubjects.runtime.observed, ({ payload }) => {
      observed.push(payload);
    });
    const startedCleanup = bus.on(ClientSubjects.runtime.started, ({ payload }) => {
      started.push(payload);
    });

    try {
      await expect(
        bus.request(ClientSubjects.runtime.observe, {
          clientId: 'codex',
          source: { layer: 'supervisor', producer: 'test-supervisor' },
          observedAt: 1_700_000_006_000,
          supervisorSessionId: 'sup-storage-rejected',
        }),
      ).rejects.toThrow('client runtime storage rejected persistence');

      expect(registry.size).toBe(0);
      expect(observed).toEqual([]);
      expect(started).toEqual([]);

      rejectPersistence = false;
      const created = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        observedAt: 1_700_000_007_000,
        supervisorSessionId: 'sup-storage-rejected',
      });
      const committed = registry.getRuntime(created.clientRuntimeId);
      const observedCount = observed.length;
      const startedCount = started.length;

      rejectPersistence = true;
      await expect(
        bus.request(ClientSubjects.runtime.observe, {
          clientId: 'codex',
          source: { layer: 'adapter', producer: 'test-codex-adapter' },
          observedAt: 1_700_000_008_000,
          supervisorSessionId: 'sup-storage-rejected',
          adapterSessionId: 'native-storage-rejected',
        }),
      ).rejects.toThrow('client runtime storage rejected persistence');

      expect(registry.getRuntime(created.clientRuntimeId)).toEqual(committed);
      expect(observed).toHaveLength(observedCount);
      expect(started).toHaveLength(startedCount);
    } finally {
      startedCleanup();
      observedCleanup();
      storageCleanup();
    }
  });
});
