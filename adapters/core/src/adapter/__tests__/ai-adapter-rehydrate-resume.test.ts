import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, type AdapterSessionMoved } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { createTestAdapter, MockConnector, TestAgent, type BaseAgentConnectorConfig, type TestBus } from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

/**
 * Connector that reports the provider session it was configured with.
 *
 * {@link MockConnector} always reports one fixed ID, which makes every rehydrate
 * look like an identity movement. A real connector that resumed its target
 * reports that target back, which is what the no-movement case needs.
 */
class ConfiguredSessionConnector extends MockConnector {
  public override async getAdapterSessionId(): Promise<string> {
    return this.config.adapterSessionId ?? (await super.getAdapterSessionId());
  }
}

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
   * @param rpcResumeId - Optional resumeAdapterSessionId passed in the RPC payload (service-evaluated)
   * @param echoConfiguredSession - When true the connector reports the provider session it was
   *   configured with, mirroring a real connector that genuinely resumed its target instead of
   *   {@link MockConnector}'s fixed ID
   * @param createdAgents - When provided, receives every agent instance the rehydrate created, so a
   *   test can drive the real agent (not {@link AIAdapter.getAgent}'s flattened copy, which drops
   *   prototype methods)
   * @returns Captured connector configuration
   */
  async function rehydrateColdAgent(
    rpcResumeId?: string,
    echoConfiguredSession = false,
    createdAgents?: TestAgent[],
  ): Promise<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> {
    const capturedConfigs: Array<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> = [];
    ({ adapter } = createTestAdapter('test-adapter-rehydrate-config', {
      agentFactory: (agentConfig) => {
        const agent = new TestAgent(agentConfig);
        createdAgents?.push(agent);
        return agent;
      },
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
        return echoConfiguredSession ? new ConfiguredSessionConnector(config) : new MockConnector(config);
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
        };
        ctx.setResult({
          agent: persistedAgent,
        });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true, transitioned: true });
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

  describe('provider-session movement seam', () => {
    /**
     * Capture every `agent.adapterSession.moved` announcement for a test.
     * @returns Array receiving announced payloads
     */
    function captureMovements(): AdapterSessionMoved[] {
      const movements: AdapterSessionMoved[] = [];
      cleanupFns.push(
        MakaioBus.on(AgentSubjects.adapterSession.moved, ({ payload }) => {
          movements.push(payload);
        }),
      );
      return movements;
    }

    it('announces a moved provider identity after a fresh cold rehydrate', async () => {
      // Cold rehydration dispatches no turn, so `agent.started` cannot carry the
      // movement — the dedicated seam is the only signal a currency consumer gets.
      const movements = captureMovements();
      await rehydrateColdAgent();

      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        sessionId: 'persisted-session',
        adapterName: 'test-adapter-rehydrate-config',
        adapterSessionId: 'mock-adapter-session-id',
        confirmed: true,
      });
    });

    it('stays silent when the rehydrated identity did not move', async () => {
      const movements = captureMovements();
      // Resuming the persisted provider session keeps the identity put, so the
      // seam has nothing to announce.
      await rehydrateColdAgent('persisted-native-session', true);

      expect(movements).toHaveLength(0);
    });

    it('announces the movement before the agent row advertises the recovered identity', async () => {
      // Ordering duty of the seam contract: the session row must carry the new
      // currency before anything else exposes it, so a concurrent attach reading
      // the agent row cannot find an identity the session row does not know.
      const steps: string[] = [];
      cleanupFns.push(
        MakaioBus.on(AgentSubjects.adapterSession.moved, () => {
          steps.push('announced');
        }),
        MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
          if (ctx.payload.adapterSessionId !== undefined) steps.push('agent-row-written');
          ctx.setResult({ success: true });
        }),
      );

      await rehydrateColdAgent();

      expect(steps).toEqual(['announced', 'agent-row-written']);
    });

    it('keeps a rejected movement retryable after the agent row advanced', async () => {
      // Retryability duty of the seam contract. The agent row is what a later
      // rehydrate compares against, so once it holds the recovered ID no later
      // rehydrate reports movement again. Routing the announcement through the
      // rehydrated agent's own tracker is what preserves the retry: the
      // unacknowledged announcement stays armed and the agent's next confirmed
      // identity re-drives it.
      // Registered before the rejecting consumer: a failed announcement still
      // reaches the other subscribers, which is what makes it observable here.
      const movements = captureMovements();
      let rejectNext = true;
      const runtimeUpdates: Array<string | undefined> = [];
      cleanupFns.push(
        MakaioBus.on(AgentSubjects.adapterSession.moved, async () => {
          if (rejectNext) throw new Error('currency write failed');
        }),
        MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
          runtimeUpdates.push(ctx.payload.adapterSessionId);
          ctx.setResult({ success: true });
        }),
      );

      const createdAgents: TestAgent[] = [];
      await rehydrateColdAgent(undefined, false, createdAgents);

      // The rejected announcement did not fail the rehydrate, and the agent row
      // still advanced so a later restart resumes the recovered thread.
      expect(movements).toHaveLength(1);
      expect(runtimeUpdates).toEqual(['mock-adapter-session-id']);

      // The retry anchor survived on the agent: re-recording the same identity
      // announces again instead of deduplicating it as delivered. This is the
      // path payload enrichment drives on the agent's next emitted event.
      const agent = createdAgents.at(-1);
      if (!agent) throw new Error('Expected the rehydrate to have created an agent');
      rejectNext = false;
      await agent.recordConfirmedAdapterSession('mock-adapter-session-id');

      expect(movements.map((movement) => movement.adapterSessionId)).toEqual([
        'mock-adapter-session-id',
        'mock-adapter-session-id',
      ]);
    });
  });

  describe('unconfirmed identity invariant', () => {
    // Invariant: the persisted adapterSessionId is an identity marker, never a
    // resume decision. Cold rehydration only resumes on the caller's explicit
    // resumeAdapterSessionId — even when the persisted marker is a placeholder
    // the provider never confirmed.

    it('does not set resumeAdapterSessionId when the RPC supplies no resume target', async () => {
      // Simulates a crash-after-persist, before provider confirmation: the
      // record carries a placeholder adapterSessionId, and no caller evaluated
      // locality. The fresh generation must not pin the used session ID.
      const capturedConfig = await rehydrateColdAgent();

      expect(capturedConfig).toEqual(
        expect.objectContaining({
          allowedDirectories: ['/workspace'],
        }),
      );
      expect(capturedConfig).not.toHaveProperty('adapterSessionId');
      expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
    });
  });

  describe('warm rehydrate native resume gate', () => {
    /**
     * Start a live agent, warm-rehydrate it, and return the replacement
     * connector config created by the swap.
     * @param rehydrateOverrides - Extra rehydrate RPC payload fields (resumeAdapterSessionId)
     * @param runtimeUpdates - When provided, captures storage:agent.updateRuntime payloads
     * @returns Captured replacement connector configuration
     */
    async function rehydrateWarmAgent(
      rehydrateOverrides: { resumeAdapterSessionId?: string },
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
            },
          });
        }),
        MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
          ctx.setResult({ success: true, transitioned: true });
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
      // The RPC contract makes the service layer own the resume decision: a
      // known live session never implies resume, warm or cold. The fresh
      // replacement must not pin the live session ID — it refers to a used
      // provider session in the durable session store.
      const capturedConfig = await rehydrateWarmAgent({});

      expect(capturedConfig).not.toHaveProperty('resumeAdapterSessionId');
      expect(capturedConfig.adapterSessionId).toBeDefined();
      expect(capturedConfig.adapterSessionId).not.toBe('live-native-session');
    });

    it('resumes with the RPC-supplied resumeAdapterSessionId', async () => {
      const capturedConfig = await rehydrateWarmAgent({
        resumeAdapterSessionId: 'persisted-native-session',
      });

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig.resumeAdapterSessionId).toBe('persisted-native-session');
    });

    it('persists the moved provider identity after a fresh warm rehydrate', async () => {
      // The replacement mints a new provider session; storage must follow the
      // registry, because the agent.started reconciliation is write-once and
      // restartAgents would otherwise resume the abandoned session from the
      // stale stored ID.
      const runtimeUpdates: Array<{ agentId: string; adapterSessionId?: string }> = [];
      await rehydrateWarmAgent({}, runtimeUpdates);

      expect(runtimeUpdates).toContainEqual(expect.objectContaining({ adapterSessionId: 'mock-adapter-session-id' }));
    });
  });

  describe('RPC-supplied resumeAdapterSessionId (service-evaluated locality)', () => {
    it('sets resumeAdapterSessionId from RPC payload (service-evaluated resume)', async () => {
      // The service layer evaluated locality and decided native resume is
      // safe; the resumed generation adopts the target as its identity.
      const capturedConfig = await rehydrateColdAgent('persisted-native-session');

      expect(capturedConfig.adapterSessionId).toBe('persisted-native-session');
      expect(capturedConfig.resumeAdapterSessionId).toBe('persisted-native-session');
    });

    it('omits resumeAdapterSessionId when the RPC does not supply it', async () => {
      // The RPC payload carries no resume decision — connector starts fresh
      // (with a freshly minted provider identity), first send must inject
      // history.
      const capturedConfig = await rehydrateColdAgent(undefined);

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
   * @param adapterSessionId - Provider session ID stamped on the persisted record
   */
  function registerStorageHandlers(adapterSessionId: string): void {
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
        };
        ctx.setResult({ agent: persistedAgent });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true, transitioned: true });
      }),
    );
  }

  it('persists the moved provider identity after a fresh cold rehydrate', async () => {
    ({ adapter } = createTestAdapter('test-adapter-claim'));
    await adapter.init();

    // No locality verdict — the cold rehydrate starts fresh and the
    // connector confirms a new provider session ('mock-adapter-session-id').
    registerStorageHandlers('persisted-native-session');
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
    registerStorageHandlers('persisted-native-session');

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

  it('start that rotates away from its resume target leaves no dangling claim', async () => {
    ({ adapter } = createTestAdapter('test-adapter-claim'));
    await adapter.init();
    registerStorageHandlers('persisted-native-session');

    // A resume-mode start with an initialMessage runs the turn pipeline, which
    // abandons the armed resume target when native resume is suppressed; the
    // connector then mints its own provider session ('mock-adapter-session-id').
    // The start claimed 'abandoned-target' up front, so settling only the
    // confirmed identity would strand that claim for the adapter's lifetime.
    const firstStart = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'claim-test-session',
      adapterSessionId: 'abandoned-target',
      initialMessage: 'hello',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: createNoAuthTestProviderContext('cfg', 'provider'),
    });
    expect(firstStart.success).toBe(true);

    // The registered entry occupies 'mock-adapter-session-id', not the abandoned
    // target, so only a stranded pending claim could still lock the latter.
    const secondStart = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'claim-test-session',
      adapterSessionId: 'abandoned-target',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: createNoAuthTestProviderContext('cfg', 'provider'),
    });

    expect(secondStart.success).toBe(true);
  });

  it('warm rehydrate rejects a resume target owned by another live agent', async () => {
    // Occupancy must be real, not implied by a leftover pending claim: the
    // default MockConnector reports one fixed ID for every agent, so a start
    // pinned to a provider session would not actually occupy it. Echoing the
    // configured session is what makes agent B the live writer of 'session-b'.
    ({ adapter } = createTestAdapter('test-adapter-claim', {
      configFactory: async (input) => ({
        bus: input.bus,
        agentId: input.agentId ?? 'test-agent',
        adapterId: input.adapterId ?? 'test-adapter-id',
        adapterName: 'test-adapter-claim',
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
        ...(input.adapterSessionId !== undefined && { adapterSessionId: input.adapterSessionId }),
        ...(input.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: input.resumeAdapterSessionId }),
      }),
      connectorFactory: async (config) => new ConfiguredSessionConnector(config),
    }));
    await adapter.init();

    registerStorageHandlers('unused-persisted-session');

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

    registerStorageHandlers('native-session-concurrent');

    // Fire the first rehydrate — it will block inside the connector factory.
    const firstRehydrate = MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'agent-concurrent-1',
      resumeAdapterSessionId: 'native-session-concurrent',
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
        resumeAdapterSessionId: 'native-session-concurrent',
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

    registerStorageHandlers('native-session-release');

    // First rehydrate fails — claim must be released.
    await expect(
      MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'agent-release-1',
        resumeAdapterSessionId: 'native-session-release',
      }),
    ).rejects.toThrow('Failed to recover agent');

    // Second rehydrate for the same provider session must now succeed because
    // the first call's failure released the claim.
    await expect(
      MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'agent-release-2',
        resumeAdapterSessionId: 'native-session-release',
      }),
    ).resolves.toBeDefined();
  });

  it('successful cold rehydrate registers an entry and leaves no dangling claim', async () => {
    ({ adapter } = createTestAdapter('test-adapter-claim'));
    await adapter.init();

    registerStorageHandlers('native-session-clean');

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'agent-clean',
      resumeAdapterSessionId: 'native-session-clean',
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
