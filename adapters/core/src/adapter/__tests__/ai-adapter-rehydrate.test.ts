/* eslint max-lines: ["error", { "max": 467 }] */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type SystemPrompt } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  MockConnector,
  TestAdapter,
  createTestAdapter as createTestAdapterShared,
  type TestBus,
  type BaseAgentConnectorConfig,
  type NormalizedMessageInput,
  MessageHandle,
  type AgentStartResult,
} from './shared.js';

const TEST_PROVIDER_CONTEXT = { providerConfigId: 'test-config', definitionId: 'provider-1', credentialRefs: {} };

/**
 * Observation-only test double that captures the systemPrompt passed to initialize().
 *
 * Does not delegate to super — MockConnector.initialize() is a no-op and the
 * base AIAgentConnector.initialize() is abstract, so there is no base behavior
 * to preserve. We are testing the orchestration layer (does rehydrateAgent pass
 * the right systemPrompt?), not the connector itself.
 */
class TrackingConnector extends MockConnector {
  public capturedSystemPrompt: SystemPrompt | undefined;

  public override async initialize(options?: { systemPrompt?: SystemPrompt }): Promise<void> {
    this.capturedSystemPrompt = options?.systemPrompt;
  }

  public override async start(message: NormalizedMessageInput): Promise<AgentStartResult> {
    return {
      adapterSessionId: 'mock-adapter-session-id',
      agentId: this.getAgentId(),
      messageHandle: new MessageHandle('mock-message-id', message, 'enqueue'),
    };
  }
}

function createTestAdapter(options?: { throwOnModel?: string; useTrackingConnector?: boolean }): {
  adapter: TestAdapter;
  getLastConnector: () => TrackingConnector | undefined;
} {
  let lastConnector: TrackingConnector | undefined;

  const { adapter } = createTestAdapterShared('test-adapter-rehydrate', {
    connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) => {
      if (options?.throwOnModel && config.model === options.throwOnModel) {
        throw new Error(`connector failed for ${config.model}`);
      }
      if (options?.useTrackingConnector) {
        const connector = new TrackingConnector(config);
        lastConnector = connector;
        return connector;
      }
      return new MockConnector(config);
    },
  });
  return { adapter, getLastConnector: () => lastConnector };
}

describe('AIAdapter.handleRehydrateAgent', () => {
  let adapter: TestAdapter;
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

  it('persists explicit runtime overrides for in-memory agents', async () => {
    adapter = createTestAdapter().adapter;
    await adapter.init();

    const runtimeUpdates: Array<{ agentId: string; cwd?: string; model?: string }> = [];
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
        runtimeUpdates.push({
          agentId: ctx.payload.agentId,
          cwd: ctx.payload.cwd,
          model: ctx.payload.model,
        });
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'session-1',
      adapterSessionId: 'adapter-session-1',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('Failed to start agent');

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: startResult.agentId,
      cwd: os.tmpdir(),
      model: 'override-model',
    });

    const refreshed = adapter.getAgent(startResult.agentId);
    expect(refreshed?.adapterSessionId).toBe('mock-adapter-session-id');

    expect(runtimeUpdates).toContainEqual({
      agentId: startResult.agentId,
      cwd: os.tmpdir(),
      model: 'override-model',
    });
  });

  it('does not persist providerConfigId from adapter layer (orchestrator owns this field)', async () => {
    adapter = createTestAdapter().adapter;
    await adapter.init();

    let persistedProviderConfigId: string | undefined;
    let setCalls = 0;
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        setCalls += 1;
        persistedProviderConfigId = ctx.payload.agent.providerConfigId;
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'session-provider',
      adapterSessionId: 'adapter-session-provider',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    expect(startResult.success).toBe(true);

    // The adapter only has definitionId, not the config UUID needed for
    // rehydration. The orchestrator's persistAgentIdentity writes the
    // correct providerConfigId — adapter layer must not overwrite it.
    expect(setCalls).toBeGreaterThan(0);
    expect(persistedProviderConfigId).toBeUndefined();
  });

  it('wraps connector/swap failures with agent context', async () => {
    adapter = createTestAdapter({ throwOnModel: 'explode-model' }).adapter;
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'session-2',
      adapterSessionId: 'adapter-session-2',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('Failed to start agent');

    await expect(
      MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: startResult.agentId,
        model: 'explode-model',
      }),
    ).rejects.toThrow(`Failed to recover agent ${startResult.agentId}`);
  });

  it('uses connector session id when persisted adapterSessionId is missing', async () => {
    adapter = createTestAdapter().adapter;
    await adapter.init();

    const runtimeUpdates: Array<{ agentId: string; cwd?: string; model?: string }> = [];
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: adapter.adapterId,
            adapterName: 'test-adapter-rehydrate',
            sessionId: 'persisted-session',
            adapterSessionId: undefined,
            role: 'lead',
            status: 'dead' as const,
            model: 'persisted-model',
            cwd: os.tmpdir(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        });
      }),
      MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
        runtimeUpdates.push({
          agentId: ctx.payload.agentId,
          cwd: ctx.payload.cwd,
          model: ctx.payload.model,
        });
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'persisted-agent',
      cwd: os.tmpdir(),
    });

    const recovered = adapter.getAgent('persisted-agent');
    expect(recovered).toBeDefined();
    expect(recovered?.adapterSessionId).toBe('mock-adapter-session-id');
    expect(runtimeUpdates).toContainEqual({
      agentId: 'persisted-agent',
      cwd: os.tmpdir(),
      model: undefined,
    });
  });

  it('prefers connector session id over stale persisted adapterSessionId', async () => {
    adapter = createTestAdapter().adapter;
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: adapter.adapterId,
            adapterName: 'test-adapter-rehydrate',
            sessionId: 'persisted-session',
            adapterSessionId: 'stale-persisted-session',
            role: 'lead',
            status: 'dead' as const,
            model: 'persisted-model',
            cwd: os.tmpdir(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'persisted-agent-stale',
      cwd: os.tmpdir(),
    });

    const recovered = adapter.getAgent('persisted-agent-stale');
    expect(recovered?.adapterSessionId).toBe('mock-adapter-session-id');
  });

  // Why TrackingConnector, not a "real connector"?
  // MockConnector.initialize() is a no-op — it doesn't store systemPrompt.
  // AIAgentConnector.systemPrompt is `protected` — inaccessible from tests.
  // There is no concrete test connector that records and exposes systemPrompt.
  // TrackingConnector is the minimal observation point for verifying that the
  // orchestration layer (handleRehydrateAgent) passes the correct systemPrompt
  // to connector.initialize(). The rest of the flow (real bus, real adapter,
  // real connector creation) is exercised by the test infrastructure.
  describe('system prompt restoration', () => {
    /**
     * Sets up a rehydrate scenario with TrackingConnector, registers common bus
     * handlers (AgentStorageSubjects.get + updateStatus), invokes rehydrateAgent,
     * and returns the connector for assertion. Callers pass differing fixture data
     * (identity fields, resolution handlers) via the options bag.
     * @param options - Scenario config: agentId, sessionId, identityFields, resolutionHandlers
     * @returns The TrackingConnector used during rehydration
     */
    async function setupRehydrateScenario(options: {
      agentId: string;
      sessionId: string;
      identityFields?: { personaId?: string; profileId?: string };
      resolutionHandlers?: Array<() => void>;
    }): Promise<TrackingConnector | undefined> {
      const { adapter: testAdapter, getLastConnector } = createTestAdapter({ useTrackingConnector: true });
      adapter = testAdapter;
      await adapter.init();

      cleanupFns.push(
        MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
          ctx.setResult({
            agent: {
              agentId: ctx.payload.agentId,
              adapterId: adapter.adapterId,
              adapterName: 'test-adapter-rehydrate',
              sessionId: options.sessionId,
              adapterSessionId: 'old-adapter-session',
              role: 'lead',
              status: 'dead' as const,
              model: 'test-model',
              cwd: os.tmpdir(),
              ...options.identityFields,
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
            },
          });
        }),
        MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
          ctx.setResult({ success: true });
        }),
        ...(options.resolutionHandlers ?? []),
      );

      await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: options.agentId,
      });

      return getLastConnector();
    }

    it('restores system prompt via SessionSubjects.resolveSystemPrompt when personaId is persisted', async () => {
      const connector = await setupRehydrateScenario({
        agentId: 'agent-with-persona',
        sessionId: 'session-persona',
        identityFields: { personaId: 'persona-1' },
        resolutionHandlers: [
          MakaioBus.on(SessionSubjects.resolveSystemPrompt, (ctx) => {
            ctx.setResult({
              systemPrompt: 'You are a helpful assistant.',
            });
          }),
        ],
      });

      expect(connector).toBeDefined();
      expect(connector?.capturedSystemPrompt).toBe('You are a helpful assistant.');
    });

    it('restores system prompt via SessionSubjects.resolveSystemPrompt when only profileId is persisted', async () => {
      const connector = await setupRehydrateScenario({
        agentId: 'agent-with-profile',
        sessionId: 'session-profile',
        identityFields: { profileId: 'profile-1' },
        resolutionHandlers: [
          MakaioBus.on(SessionSubjects.resolveSystemPrompt, (ctx) => {
            ctx.setResult({
              systemPrompt: 'You are a profile-scoped assistant.',
            });
          }),
        ],
      });

      expect(connector).toBeDefined();
      expect(connector?.capturedSystemPrompt).toBe('You are a profile-scoped assistant.');
    });

    it('initialises without system prompt when persona service is unavailable (graceful degradation)', async () => {
      // No PersonaSubjects.resolve handler registered — requestOptional returns unhandled
      const connector = await setupRehydrateScenario({
        agentId: 'agent-no-service',
        sessionId: 'session-no-service',
        identityFields: { personaId: 'persona-unavailable' },
      });

      expect(connector).toBeDefined();
      expect(connector?.capturedSystemPrompt).toBeUndefined();
      expect(adapter.getAgent('agent-no-service')).toBeDefined();
    });

    it('initialises without system prompt when no identity fields are persisted', async () => {
      const connector = await setupRehydrateScenario({
        agentId: 'agent-no-identity',
        sessionId: 'session-no-identity',
      });

      expect(connector).toBeDefined();
      expect(connector?.capturedSystemPrompt).toBeUndefined();
    });
  });
});
