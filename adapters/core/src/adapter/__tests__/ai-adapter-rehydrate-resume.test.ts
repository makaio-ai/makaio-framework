import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type NativeLocalityVerdict } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { createTestAdapter, MockConnector, TestAgent, type BaseAgentConnectorConfig, type TestBus } from './shared.js';
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
        allowedDirectories: ['/workspace'],
      }),
    );
    expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
    // Fresh generations mint their own provider identity downstream — the
    // used persisted session ID must not be pinned on the replacement.
    expect(capturedConfig).not.toHaveProperty('adapterSessionId');
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

      expect(capturedConfig).not.toHaveProperty('adapterSessionId');
      expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
    });

    it('sets resumeAdapterSessionId only when persisted record carries a native locality verdict (confirmed identity)', async () => {
      const capturedConfig = await rehydrateColdAgent({ kind: 'native' });

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig.resumeAdapterSessionId).toBe('persisted-native-session');
    });
  });

  describe('warm rehydrate native resume gate', () => {
    /**
     * Start a live agent, warm-rehydrate it, and return the replacement
     * connector config created by the swap.
     * @param rehydrateOverrides - Extra rehydrate RPC payload fields (adapterSessionId, resumeAdapterSessionId)
     * @param nativeLocality - Optional host-evaluated locality verdict served by the agent-storage handler
     * @param runtimeUpdates - When provided, captures storage:agent.updateRuntime payloads
     * @returns Captured replacement connector configuration
     */
    async function rehydrateWarmAgent(
      rehydrateOverrides: { adapterSessionId?: string; resumeAdapterSessionId?: string },
      nativeLocality?: NativeLocalityVerdict,
      runtimeUpdates?: Array<{ agentId: string; adapterSessionId?: string }>,
    ): Promise<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> {
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
        MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
          ctx.setResult({
            agent: {
              agentId: ctx.payload.agentId,
              adapterId: adapter.adapterId,
              adapterName: 'test-adapter-warm-rehydrate-config',
              sessionId: 'warm-session',
              adapterSessionId: 'live-native-session',
              role: 'lead' as const,
              status: 'idle' as const,
              model: 'test-model',
              cwd: os.tmpdir(),
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              ...(nativeLocality !== undefined && { nativeLocality }),
            },
          });
        }),
        MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
          ctx.setResult({ success: true });
        }),
        MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
          runtimeUpdates?.push({
            agentId: ctx.payload.agentId,
            ...(ctx.payload.adapterSessionId !== undefined && { adapterSessionId: ctx.payload.adapterSessionId }),
          });
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
        ...rehydrateOverrides,
      });

      const capturedConfig = capturedConfigs.at(-1);
      if (!capturedConfig) throw new Error('Expected connector config to be captured');
      return capturedConfig;
    }

    it('mints a fresh provider identity when the RPC supplies no resume decision', async () => {
      // The RPC contract makes the service layer own the resume decision:
      // adapterSessionId alone never implies resume, warm or cold. The fresh
      // replacement must not pin either the requested or the live session ID —
      // both refer to used provider sessions in the durable session store.
      const capturedConfig = await rehydrateWarmAgent({ adapterSessionId: 'persisted-native-session' });

      expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
      expect(capturedConfig.adapterSessionId).toBeDefined();
      expect(capturedConfig.adapterSessionId).not.toBe('persisted-native-session');
      expect(capturedConfig.adapterSessionId).not.toBe('live-native-session');
    });

    it('resumes with the RPC-supplied resumeAdapterSessionId', async () => {
      const capturedConfig = await rehydrateWarmAgent({
        adapterSessionId: 'persisted-native-session',
        resumeAdapterSessionId: 'persisted-native-session',
      });

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig.resumeAdapterSessionId).toBe('persisted-native-session');
    });

    it('resumes the live session when the stored record carries a native locality verdict', async () => {
      const capturedConfig = await rehydrateWarmAgent({}, { kind: 'native' });

      expect(capturedConfig.adapterSessionId).toBe('live-native-session');
      expect(capturedConfig.resumeAdapterSessionId).toBe('live-native-session');
    });

    it('starts the replacement connector fresh under foreign locality', async () => {
      const capturedConfig = await rehydrateWarmAgent({}, { kind: 'foreign', machineId: 'remote-machine' });

      expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
      expect(capturedConfig.adapterSessionId).toBeDefined();
      expect(capturedConfig.adapterSessionId).not.toBe('live-native-session');
    });

    it('persists the moved provider identity after a fresh warm rehydrate', async () => {
      // The replacement mints a new provider session; storage must follow the
      // registry, because the agent.started reconciliation is write-once and
      // restartAgents would otherwise resume the abandoned session from the
      // stale stored ID.
      const runtimeUpdates: Array<{ agentId: string; adapterSessionId?: string }> = [];
      await rehydrateWarmAgent({}, undefined, runtimeUpdates);

      expect(runtimeUpdates).toContainEqual(expect.objectContaining({ adapterSessionId: 'mock-adapter-session-id' }));
    });
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
      // locality — connector starts fresh (with a freshly minted provider
      // identity), first send must inject history.
      const capturedConfig = await rehydrateColdAgent(undefined, undefined);

      expect(capturedConfig).not.toHaveProperty('adapterSessionId');
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

  it('persists the moved provider identity after a fresh cold rehydrate', async () => {
    ({ adapter } = createTestAdapter('test-adapter-claim'));
    await adapter.init();

    // No locality verdict — the cold rehydrate starts fresh and the
    // connector confirms a new provider session ('mock-adapter-session-id').
    registerStorageHandlers(undefined, 'persisted-native-session');
    const runtimeUpdates: Array<{ agentId: string; adapterSessionId?: string }> = [];
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
        runtimeUpdates.push({
          agentId: ctx.payload.agentId,
          ...(ctx.payload.adapterSessionId !== undefined && { adapterSessionId: ctx.payload.adapterSessionId }),
        });
        ctx.setResult({ success: true });
      }),
    );

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'agent-fresh-persist',
    });

    // Storage must follow the confirmed identity — the agent.started
    // reconciliation is write-once and restartAgents would otherwise resume
    // the abandoned session from the stale stored ID.
    expect(runtimeUpdates).toContainEqual(
      expect.objectContaining({ agentId: 'agent-fresh-persist', adapterSessionId: 'mock-adapter-session-id' }),
    );
  });

  it('divergent RPC resume target leaves no dangling claim', async () => {
    ({ adapter } = createTestAdapter('test-adapter-claim'));
    await adapter.init();

    // Persisted identity differs from the RPC resume target: the resumed
    // generation must carry the resume target as its identity so that
    // registry.set() clears the matching claim instead of stranding it.
    registerStorageHandlers(undefined, 'persisted-native-session');

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'agent-divergent',
      resumeAdapterSessionId: 'rpc-override-session',
    });

    // Free the registered occupancy — only a stranded pending claim could
    // still lock the provider session afterwards.
    expect(adapter.disposeAgent('agent-divergent')).toBe(true);

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'claim-test-session',
      adapterSessionId: 'rpc-override-session',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: createNoAuthTestProviderContext('cfg', 'provider'),
    });

    expect(startResult.success).toBe(true);
  });

  it('warm rehydrate rejects a resume target owned by another live agent', async () => {
    ({ adapter } = createTestAdapter('test-adapter-claim'));
    await adapter.init();

    registerStorageHandlers(undefined, 'unused-persisted-session');

    /**
     * Start a live agent occupying the given provider session.
     * @param sessionId - Makaio session ID for the start request
     * @param adapterSessionId - Provider session the agent occupies
     * @returns The started agent's ID
     */
    async function startLiveAgent(sessionId: string, adapterSessionId: string): Promise<string> {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'resume',
        sessionId,
        adapterSessionId,
        model: 'test-model',
        cwd: os.tmpdir(),
        providerContext: createNoAuthTestProviderContext('cfg', 'provider'),
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Failed to start agent');
      return result.agentId;
    }

    const agentA = await startLiveAgent('claim-session-a', 'session-a');
    await startLiveAgent('claim-session-b', 'session-b');

    // Agent A must not be attachable to agent B's provider conversation.
    await expect(
      MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: agentA,
        resumeAdapterSessionId: 'session-b',
      }),
    ).rejects.toThrow('already claimed');
  });

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

    // The second rehydrate for the same provider session must be rejected
    // while the first still holds the claim — assert BEFORE releasing the
    // gate. (Releasing first would race: once the first rehydrate completes,
    // the resumed session is released again because the provider confirmed a
    // different identity, and a late second claim would legitimately succeed.)
    await expect(
      MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'agent-concurrent-2',
      }),
    ).rejects.toThrow('already claimed');

    // Unblock the first rehydrate connector creation.
    resolveGate();

    await expect(firstRehydrate).resolves.toBeDefined();
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

    // The entry is registered under the provider-confirmed identity
    // (MockConnector confirms 'mock-adapter-session-id', not the resumed
    // session).
    const rehydrated = adapter.getAgent('agent-clean');
    expect(rehydrated).toBeDefined();
    if (!rehydrated) throw new Error('Expected rehydrated agent handle');
    expect(rehydrated.adapterSessionId).toBe('mock-adapter-session-id');
    expect(rehydrated.agent).toBeInstanceOf(TestAgent);
    await expect(rehydrated.agent.getAdapterSessionId()).resolves.toBe('mock-adapter-session-id');

    const activeAgents = adapter.getActiveAgents();
    expect(activeAgents).toHaveLength(1);
    const activeAgent = activeAgents[0];
    if (!activeAgent) throw new Error('Expected active agent handle');
    expect(activeAgent.agent).toBe(rehydrated.agent);
    await expect(activeAgent.agent.getAdapterSessionId()).resolves.toBe('mock-adapter-session-id');

    // Because the provider confirmed a different identity, the claimed
    // resume target has no live writer anymore and must be released — a
    // dangling pending claim would lock the session forever. A resume-mode
    // start for it therefore succeeds.
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

    expect(startResult.success).toBe(true);
  });
});
