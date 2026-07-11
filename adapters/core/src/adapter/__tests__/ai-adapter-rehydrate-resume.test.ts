import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type NativeLocalityVerdict } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { createTestAdapter, MockConnector, type BaseAgentConnectorConfig, type TestBus } from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

describe('AIAdapter.handleRehydrateAgent native resume context', () => {
  let adapter: ReturnType<typeof createTestAdapter>['adapter'];
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await adapter?.closeAsync();
  });

  /**
   * Rehydrate a persisted agent and return the connector config created by the cold path.
   * @param nativeLocality - Optional host-evaluated locality verdict attached to the stored agent fixture
   * @param rpcResumeId - Optional resumeAdapterSessionId passed in the RPC payload (service-evaluated)
   * @returns Captured connector configuration
   */
  async function rehydrateColdAgent(
    nativeLocality?: NativeLocalityVerdict,
    rpcResumeId?: string,
  ): Promise<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> {
    const capturedConfigs: Array<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> = [];
    ({ adapter } = createTestAdapter('test-adapter-rehydrate-config', {
      configFactory: async (input) => ({
        bus: input.bus,
        agentId: input.agentId,
        adapterId: input.adapterId,
        adapterName: input.adapterName,
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
        ...(input.allowedDirectories !== undefined && { allowedDirectories: input.allowedDirectories }),
        ...(input.adapterSessionId !== undefined && { adapterSessionId: input.adapterSessionId }),
        ...(input.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: input.resumeAdapterSessionId }),
      }),
      connectorFactory: async (config) => {
        capturedConfigs.push(config);
        return new MockConnector(config);
      },
    }));
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        const persistedAgent = {
          agentId: ctx.payload.agentId,
          adapterId: adapter.adapterId,
          adapterName: 'test-adapter-rehydrate-config',
          sessionId: 'persisted-session',
          adapterSessionId: 'persisted-native-session',
          role: 'lead' as const,
          status: 'idle' as const,
          model: 'persisted-model',
          cwd: os.tmpdir(),
          allowedDirectories: ['/workspace'],
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          ...(nativeLocality !== undefined && { nativeLocality }),
        };
        ctx.setResult({
          agent: persistedAgent,
        });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'persisted-agent-resume',
      ...(rpcResumeId !== undefined && { resumeAdapterSessionId: rpcResumeId }),
    });

    const capturedConfig = capturedConfigs.at(-1);
    if (!capturedConfig) throw new Error('Expected connector config to be captured');
    return capturedConfig;
  }

  it('passes persisted adapterSessionId as native resume context during local cold rehydrate', async () => {
    const capturedConfig = await rehydrateColdAgent({ kind: 'native' });

    expect(capturedConfig).toEqual(
      expect.objectContaining({
        adapterSessionId: 'persisted-native-session',
        resumeAdapterSessionId: 'persisted-native-session',
        allowedDirectories: ['/workspace'],
      }),
    );
  });

  const nonNativeColdRehydrateCases: Array<{
    name: string;
    nativeLocality: NativeLocalityVerdict | undefined;
  }> = [
    { name: 'missing locality verdict', nativeLocality: undefined },
    {
      name: 'degraded missing-machine locality',
      nativeLocality: { kind: 'degrade', reason: 'missing-machine-id' },
    },
    { name: 'foreign locality', nativeLocality: { kind: 'foreign', machineId: 'remote-machine' } },
  ];

  it.each(nonNativeColdRehydrateCases)('omits native resume context during cold rehydrate for $name', async ({
    nativeLocality,
  }) => {
    const capturedConfig = await rehydrateColdAgent(nativeLocality);

    expect(capturedConfig).toEqual(
      expect.objectContaining({
        adapterSessionId: 'persisted-native-session',
        allowedDirectories: ['/workspace'],
      }),
    );
    expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
  });

  describe('unconfirmed identity invariant', () => {
    // Invariant: nativeLocality is never persisted to agent storage.
    // resolveNativeLocalityKind returns undefined for storage-loaded records,
    // so cold rehydration never sets resumeAdapterSessionId — even when the
    // persisted adapterSessionId is a placeholder the provider never confirmed.

    it('does not set resumeAdapterSessionId when persisted record has no locality verdict (unconfirmed identity)', async () => {
      // Simulates a crash-after-persist, before provider confirmation:
      // the record carries a placeholder adapterSessionId but no nativeLocality.
      const capturedConfig = await rehydrateColdAgent(undefined);

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
    });

    it('sets resumeAdapterSessionId only when persisted record carries a native locality verdict (confirmed identity)', async () => {
      const capturedConfig = await rehydrateColdAgent({ kind: 'native' });

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig.resumeAdapterSessionId).toBe('persisted-native-session');
    });
  });

  it('passes requested adapterSessionId as native resume context during warm rehydrate', async () => {
    const capturedConfigs: Array<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> = [];
    ({ adapter } = createTestAdapter('test-adapter-warm-rehydrate-config', {
      configFactory: async (input) => ({
        bus: input.bus,
        agentId: input.agentId,
        adapterId: input.adapterId,
        adapterName: input.adapterName,
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
        ...(input.adapterSessionId !== undefined && { adapterSessionId: input.adapterSessionId }),
        ...(input.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: input.resumeAdapterSessionId }),
      }),
      connectorFactory: async (config) => {
        capturedConfigs.push(config);
        return new MockConnector(config);
      },
    }));
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'warm-session',
      adapterSessionId: 'live-native-session',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: createNoAuthTestProviderContext('provider-config', 'provider'),
    });
    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('Failed to start agent');

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: startResult.agentId,
      adapterSessionId: 'persisted-native-session',
    });

    expect(capturedConfigs.at(-1)).toEqual(
      expect.objectContaining({
        adapterSessionId: 'persisted-native-session',
        resumeAdapterSessionId: 'persisted-native-session',
      }),
    );
  });

  describe('RPC-supplied resumeAdapterSessionId (service-evaluated locality)', () => {
    it('sets resumeAdapterSessionId from RPC payload even without persisted locality verdict', async () => {
      // The service layer evaluated locality and decided native resume is safe.
      // The persisted record carries no locality verdict (as expected — locality
      // is never persisted), but the RPC payload carries the explicit resume ID.
      const capturedConfig = await rehydrateColdAgent(undefined, 'persisted-native-session');

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig.resumeAdapterSessionId).toBe('persisted-native-session');
    });

    it('RPC resumeAdapterSessionId takes precedence over persisted locality verdict', async () => {
      // Edge case: persisted locality says native but the RPC supplies a different
      // resume ID (unlikely in practice, but the contract is clear: RPC wins).
      const capturedConfig = await rehydrateColdAgent({ kind: 'native' }, 'rpc-override-session');

      expect(capturedConfig.resumeAdapterSessionId).toBe('rpc-override-session');
    });

    it('omits resumeAdapterSessionId when RPC does not supply it and no persisted verdict', async () => {
      // Neither the RPC payload nor the persisted record confirms native
      // locality — connector starts fresh, first send must inject history.
      const capturedConfig = await rehydrateColdAgent(undefined, undefined);

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
    });
  });
});

describe('AIAdapter.handleRehydrateAgent adapter-session claim discipline', () => {
  let adapter: ReturnType<typeof createTestAdapter>['adapter'];
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await adapter?.closeAsync();
  });

  /**
   * Register standard bus handlers used by all cold-rehydrate claim tests.
   *
   * Attaches AgentStorageSubjects.get and updateStatus handlers to the global
   * bus and pushes their cleanup into `cleanupFns`.
   * @param nativeLocality - Locality verdict attached to the persisted agent fixture
   * @param adapterSessionId - Provider session ID stamped on the persisted record
   */
  function registerStorageHandlers(nativeLocality: NativeLocalityVerdict | undefined, adapterSessionId: string): void {
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        const persistedAgent = {
          agentId: ctx.payload.agentId,
          adapterId: adapter.adapterId,
          adapterName: 'test-adapter-claim',
          sessionId: 'claim-test-session',
          adapterSessionId,
          role: 'lead' as const,
          status: 'idle' as const,
          model: 'test-model',
          cwd: os.tmpdir(),
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          // nativeLocality is not part of MakaioSessionAgent — it is a host-tier
          // extension read by resolveNativeLocalityKind via a Record cast.
          ...(nativeLocality !== undefined && { nativeLocality }),
        };
        ctx.setResult({ agent: persistedAgent });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );
  }

  it('concurrent cold rehydrate for same native resume ID is rejected', async () => {
    // Two promises coordinate the race:
    // - `gate`: blocks the first connector creation until we are ready.
    // - `connectorEntered`: resolves when the first connector factory is
    //   entered, confirming the claim is already held before the second
    //   rehydrate fires.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let resolveConnectorEntered!: () => void;
    const connectorEntered = new Promise<void>((resolve) => {
      resolveConnectorEntered = resolve;
    });
    let connectorCreations = 0;

    ({ adapter } = createTestAdapter('test-adapter-claim', {
      connectorFactory: async (config) => {
        connectorCreations++;
        if (connectorCreations === 1) {
          // Signal that we have entered the connector factory (claim is held).
          resolveConnectorEntered();
          // Block until the test releases the gate.
          await gate;
        }
        return new MockConnector(config);
      },
    }));
    await adapter.init();

    registerStorageHandlers({ kind: 'native' }, 'native-session-concurrent');

    // Fire the first rehydrate — it will block inside the connector factory.
    const firstRehydrate = MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'agent-concurrent-1',
    });

    // Wait until the first rehydrate has entered the connector factory and
    // therefore holds the claim before we fire the second.
    await connectorEntered;

    // The second rehydrate for the same provider session must be rejected while
    // the first holds the claim.
    const secondRehydrate = MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'agent-concurrent-2',
    });

    // Unblock the first rehydrate connector creation.
    resolveGate();

    await expect(firstRehydrate).resolves.toBeDefined();
    await expect(secondRehydrate).rejects.toThrow('already claimed');
  });

  it('failed cold rehydrate releases the adapter-session claim', async () => {
    let failNextCreation = true;

    ({ adapter } = createTestAdapter('test-adapter-claim', {
      connectorFactory: async (config) => {
        if (failNextCreation) {
          failNextCreation = false;
          throw new Error('connector creation failed');
        }
        return new MockConnector(config);
      },
    }));
    await adapter.init();

    registerStorageHandlers({ kind: 'native' }, 'native-session-release');

    // First rehydrate fails — claim must be released.
    await expect(
      MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'agent-release-1',
      }),
    ).rejects.toThrow('Failed to recover agent');

    // Second rehydrate for the same provider session must now succeed because
    // the first call's failure released the claim.
    await expect(
      MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'agent-release-2',
      }),
    ).resolves.toBeDefined();
  });

  it('successful cold rehydrate registers an entry and leaves no dangling claim', async () => {
    ({ adapter } = createTestAdapter('test-adapter-claim'));
    await adapter.init();

    registerStorageHandlers({ kind: 'native' }, 'native-session-clean');

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'agent-clean',
    });

    // The registry entry must exist.
    expect(adapter.getAgent('agent-clean')).toBeDefined();

    // The entry occupies the provider session so a concurrent resume-mode
    // startAgent for the same adapterSessionId must be rejected.
    // This also confirms the claim was replaced by the real entry (not left
    // as a dangling pending claim) — the registry.set() auto-clears claims.
    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'claim-test-session',
      adapterSessionId: 'native-session-clean',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: createNoAuthTestProviderContext('cfg', 'provider'),
    });

    expect(startResult.success).toBe(false);
  });
});
