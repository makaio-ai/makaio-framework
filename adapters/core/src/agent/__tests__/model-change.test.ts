import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { AIModel, AIReasoningLevel } from '@makaio/contracts';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { createMockScopedBus } from '@makaio/test-utils';
import {
  asAgentConnector,
  createTestableAgent,
  createAgentTestLifecycle,
  TestableAgent,
} from './helpers/mock-agent.js';
import type { AgentTestLifecycle } from './helpers/mock-agent.js';
import type { AIAgentConfig } from '../types.js';

/** Request payload type for `model.change`, derived from the subject definition. */
type ModelChangeRequest = (typeof AgentSubjects.model.change)['$meta']['payload']['request'];

/** Response type for `model.change`, derived from the subject definition. */
type ModelChangeResponse = (typeof AgentSubjects.model.change)['$meta']['payload']['response'];

const TEST_PROVIDER_CONTEXT = { providerConfigId: 'test-config', definitionId: 'test', credentialRefs: {} };
const TEST_PROVIDER_CONTEXT_2 = {
  providerConfigId: 'provider-config-2',
  definitionId: 'test',
  endpointOverrides: { anthropic: 'https://api.example.test' },
  credentialRefs: { apiKey: buildStoredCredentialRef('provider-config-2', 'apiKey') },
};
const TEST_PROVIDER_CONTEXT_3 = {
  providerConfigId: 'provider-config-3',
  definitionId: 'test',
  credentialRefs: { apiKey: buildStoredCredentialRef('provider-config-3', 'apiKey') },
  credentialEnvVars: { apiKey: 'TEST_API_KEY' },
};

/** Standard agent ID used by all model-change tests. */
const TEST_AGENT_ID = 'test-agent-model';

/**
 * Options for creating a reasoning-capable test agent.
 * Only the fields that vary between reasoning test cases.
 */
interface ReasoningAgentOptions {
  /** Initial reasoning effort to configure on the agent. */
  initialReasoningEffort?: AIReasoningLevel;
  /** Available models exposed by the adapter for capability resolution. */
  availableModels?: AIModel[];
}

/**
 * Create and initialise a standard reasoning-capable agent for model-change tests.
 * Assigns `ctx.agent` and calls `init()`.
 * @param ctx - Shared test lifecycle context
 * @param options - Reasoning-specific agent options
 */
async function createReasoningAgent(ctx: AgentTestLifecycle, options: ReasoningAgentOptions = {}): Promise<void> {
  ctx.agent = createTestableAgent({
    agentId: TEST_AGENT_ID,
    mockConnectorFactory: ctx.mockFactory,
    initialModel: 'test-model-1',
    initialCwd: '/test/cwd',
    initialReasoningEffort: options.initialReasoningEffort,
    availableModels: options.availableModels,
    providerContext: TEST_PROVIDER_CONTEXT,
  });
  await ctx.agent.init();
}

/**
 * Send a `model.change` request for the standard test agent with optional overrides.
 * @param overrides - Partial payload fields to merge into the base request
 * @returns The bus response
 */
async function sendModelChange(
  overrides: Partial<Omit<ModelChangeRequest, 'agentId'>> = {},
): Promise<ModelChangeResponse> {
  return MakaioBus.request(AgentSubjects.model.change, {
    agentId: TEST_AGENT_ID,
    adapterId: 'test-adapter',
    adapterName: 'test',
    adapterSessionId: 'test-session-id',
    providerContext: TEST_PROVIDER_CONTEXT,
    ...overrides,
  });
}

describe('AIAgent Model change handler', () => {
  const ctx = createAgentTestLifecycle();

  beforeEach(() => ctx.reset());
  afterEach(async () => await ctx.teardown());

  it('model.change request triggers connector swap and emits model.changed with previousModel/newModel', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-model',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    await ctx.agent.init();
    const initialConnector = ctx.createdConnectors[0];

    const changedEvents: Array<{ previousModel: string; newModel: string }> = [];
    ctx.cleanupFns.push(
      MakaioBus.withFilter({ agentId: 'test-agent-model' }).on(AgentSubjects.model.changed, (evtCtx) => {
        changedEvents.push({ previousModel: evtCtx.payload.previousModel, newModel: evtCtx.payload.newModel });
      }),
    );

    const response = await MakaioBus.request(AgentSubjects.model.change, {
      agentId: 'test-agent-model',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newModel: 'test-model-2',
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(response.success).toBe(true);
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(initialConnector.closeCalled).toBe(true);
    expect(ctx.agent.currentConnector.model).toBe('test-model-2');
    expect(changedEvents).toEqual([{ previousModel: 'test-model-1', newModel: 'test-model-2' }]);
  });

  it('model.change during active turn returns success: false, reason: turn_active', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-model',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    await ctx.agent.init();
    ctx.agent.currentConnector.setProcessingState('processing_started');

    const response = await MakaioBus.request(AgentSubjects.model.change, {
      agentId: 'test-agent-model',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newModel: 'test-model-2',
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(response).toEqual({ success: false, reason: 'turn_active' });
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(ctx.agent.currentConnector.model).toBe('test-model-1');
  });

  it('model.change with same model is a no-op (success: true, no swap)', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-model',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    await ctx.agent.init();
    const initialConnector = ctx.createdConnectors[0];

    const changedEvents: Array<{ previousModel: string; newModel: string }> = [];
    ctx.cleanupFns.push(
      MakaioBus.withFilter({ agentId: 'test-agent-model' }).on(AgentSubjects.model.changed, (evtCtx) => {
        changedEvents.push({ previousModel: evtCtx.payload.previousModel, newModel: evtCtx.payload.newModel });
      }),
    );

    const response = await MakaioBus.request(AgentSubjects.model.change, {
      agentId: 'test-agent-model',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newModel: 'test-model-1',
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(response).toEqual({ success: true, swapped: false });
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(initialConnector.closeCalled).toBe(false);
    expect(ctx.agent.currentConnector).toBe(initialConnector);
    expect(changedEvents).toHaveLength(0);
  });

  it('applies reasoningEffort when newModel matches the current model', async () => {
    await createReasoningAgent(ctx, {
      initialReasoningEffort: 'low',
      availableModels: [
        {
          name: 'test-model-1',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
      ],
    });

    const response = await sendModelChange({ newModel: 'test-model-1', reasoningEffort: 'medium' });

    expect(response).toEqual({
      success: true,
      swapped: false,
      model: 'test-model-1',
      appliedReasoningEffort: 'medium',
      supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
    });
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(ctx.agent!.currentConnector.currentReasoningEffort).toBe('medium');
  });

  it('forces a connector swap when providerContext changes without a model change', async () => {
    await createReasoningAgent(ctx, {
      initialReasoningEffort: 'low',
      availableModels: [
        {
          name: 'test-model-1',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
      ],
    });

    const response = await sendModelChange({
      providerContext: TEST_PROVIDER_CONTEXT_2,
    });

    expect(response).toEqual({
      success: true,
      swapped: true,
      model: 'test-model-1',
      appliedReasoningEffort: 'low',
      supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
    });
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('forces a connector swap when providerContext changes during a reasoning-only request', async () => {
    await createReasoningAgent(ctx, {
      initialReasoningEffort: 'low',
      availableModels: [
        {
          name: 'test-model-1',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
      ],
    });

    const response = await sendModelChange({
      reasoningEffort: 'high',
      providerContext: TEST_PROVIDER_CONTEXT_3,
    });

    expect(response).toEqual({
      success: true,
      swapped: true,
      model: 'test-model-1',
      appliedReasoningEffort: 'high',
      supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
    });
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(ctx.agent!.currentConnector.currentReasoningEffort).toBe('high');
  });

  it('preserves populated credentialRefs and endpointOverrides across a model swap', async () => {
    const { bus: mockBus } = createMockScopedBus();
    const capturedContexts: Array<unknown> = [];

    const config: AIAgentConfig = {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      adapterName: 'test',
      capabilities: [],
      nativeTools: [],
      adapterBus: mockBus,
      globalBus: MakaioBus,
      model: 'test-model-1',
      cwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT_2,
      configFactory: async (input) => {
        capturedContexts.push(input.providerContext);
        return {
          bus: mockBus,
          agentId: TEST_AGENT_ID,
          adapterId: 'test-adapter',
          adapterName: 'test',
          model: input.model ?? 'test-model-1',
          cwd: input.cwd ?? '/test/cwd',
        };
      },
      connectorFactory: async (factoryConfig) =>
        asAgentConnector(
          ctx.mockFactory({
            model: factoryConfig.model,
            cwd: factoryConfig.cwd,
          }),
        ),
    };

    ctx.agent = new TestableAgent(config, ctx.mockFactory);
    await ctx.agent.init();

    // Model swap with same provider — skipWarning bypasses the dialog handler.
    // The providerContext matches the initial config, so no provider change is detected.
    await sendModelChange({ newModel: 'test-model-2', providerContext: TEST_PROVIDER_CONTEXT_2, skipWarning: true });

    // Both the init call and the swap call must carry the full provider context
    // with credentialRefs and endpointOverrides intact.
    expect(capturedContexts).toHaveLength(2);
    for (const captured of capturedContexts) {
      expect(captured).toMatchObject({
        credentialRefs: TEST_PROVIDER_CONTEXT_2.credentialRefs,
        endpointOverrides: TEST_PROVIDER_CONTEXT_2.endpointOverrides,
      });
    }
  });

  it('preserves runtime reasoningEffort across a later connector swap', async () => {
    await createReasoningAgent(ctx, {
      initialReasoningEffort: 'low',
      availableModels: [
        {
          name: 'test-model-1',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
        {
          name: 'test-model-2',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
      ],
    });

    const reasoningResponse = await sendModelChange({ reasoningEffort: 'high' });
    expect(reasoningResponse.success).toBe(true);

    const swapResponse = await sendModelChange({ newModel: 'test-model-2' });

    expect(swapResponse.success).toBe(true);
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(ctx.createdConnectors[1]?.currentReasoningEffort).toBe('high');
  });

  it('model.change returns cancelled when validateModelChange handler returns proceed: false', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-model',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    await ctx.agent.init();

    ctx.cleanupFns.push(
      MakaioBus.on(AgentSubjects.validateModelChange, (ctx) => {
        ctx.setResult({ proceed: false });
      }),
    );

    const response = await MakaioBus.request(AgentSubjects.model.change, {
      agentId: 'test-agent-model',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newModel: 'test-model-2',
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(response).toEqual({ success: false, reason: 'cancelled' });
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(ctx.agent.currentConnector.model).toBe('test-model-1');
  });

  it('model.change emits connectorSwap.editRequested when validateModelChange returns requestEditHistory: true', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-model',
      sessionId: 'session-1',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    await ctx.agent.init();

    const editEvents: Array<{ sessionId: string; agentId: string; previousModel?: string; newModel?: string }> = [];
    ctx.cleanupFns.push(
      MakaioBus.on(SessionSubjects.connectorSwap.editRequested, (ctx) => {
        editEvents.push(ctx.payload);
      }),
      MakaioBus.on(AgentSubjects.validateModelChange, (ctx) =>
        ctx.setResult({ proceed: true, requestEditHistory: true }),
      ),
    );

    const response = await MakaioBus.request(AgentSubjects.model.change, {
      agentId: 'test-agent-model',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newModel: 'test-model-2',
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(response.success).toBe(true);
    expect(editEvents).toEqual([
      { sessionId: 'session-1', agentId: 'test-agent-model', previousModel: 'test-model-1', newModel: 'test-model-2' },
    ]);
  });

  it('model.change does not emit connectorSwap.editRequested when swap fails', async () => {
    let isFirstFactoryCall = true;
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      if (!isFirstFactoryCall) throw new Error('swap failed');
      isFirstFactoryCall = false;
      return ctx.mockFactory(config);
    });

    ctx.agent = createTestableAgent({
      agentId: 'test-agent-model',
      sessionId: 'session-1',
      mockConnectorFactory: mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    await ctx.agent.init();

    const editEvents: Array<{ sessionId: string; agentId: string; previousModel?: string; newModel?: string }> = [];
    ctx.cleanupFns.push(
      MakaioBus.on(SessionSubjects.connectorSwap.editRequested, (ctx) => {
        editEvents.push(ctx.payload);
      }),
      MakaioBus.on(AgentSubjects.validateModelChange, (ctx) =>
        ctx.setResult({ proceed: true, requestEditHistory: true }),
      ),
    );

    const response = await MakaioBus.request(AgentSubjects.model.change, {
      agentId: 'test-agent-model',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newModel: 'test-model-2',
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(response.success).toBe(false);
    expect(response.reason).toContain('model_change_failed:');
    expect(editEvents).toEqual([]);
  });

  it('model.change proceeds without a validator registered (OSS / headless default)', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-model',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    await ctx.agent.init();

    // No AgentSubjects.validateModelChange handler registered — framework must
    // auto-approve the change (OSS / headless behaviour).
    const response = await MakaioBus.request(AgentSubjects.model.change, {
      agentId: 'test-agent-model',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newModel: 'test-model-2',
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(response.success).toBe(true);
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(ctx.agent.currentConnector.model).toBe('test-model-2');
  });

  it('model.change uses native path when changeModelInPlace returns true (no swap, no validation RPC)', async () => {
    await createReasoningAgent(ctx);
    ctx.agent!.currentConnector.changeModelInPlaceResult = true;
    const initialConnector = ctx.createdConnectors[0];

    let validateCalled = false;
    const changedEvents: Array<{ previousModel: string; newModel: string }> = [];
    ctx.cleanupFns.push(
      MakaioBus.on(AgentSubjects.validateModelChange, () => {
        validateCalled = true;
      }),
      MakaioBus.withFilter({ agentId: TEST_AGENT_ID }).on(AgentSubjects.model.changed, (evtCtx) => {
        changedEvents.push({ previousModel: evtCtx.payload.previousModel, newModel: evtCtx.payload.newModel });
      }),
    );

    const response = await sendModelChange({ newModel: 'test-model-2' });

    expect(response).toMatchObject({ success: true, swapped: false, model: 'test-model-2' });
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(initialConnector!.closeCalled).toBe(false);
    expect(ctx.agent!.currentConnector).toBe(initialConnector);
    expect(ctx.agent!.currentConnector.model).toBe('test-model-2');
    expect(changedEvents).toEqual([{ previousModel: 'test-model-1', newModel: 'test-model-2' }]);
    expect(validateCalled).toBe(false);
  });

  it('model.change falls back to swap when changeModelInPlace returns false', async () => {
    await createReasoningAgent(ctx);
    const initialConnector = ctx.createdConnectors[0];

    const response = await sendModelChange({ newModel: 'test-model-2' });

    expect(response).toMatchObject({ success: true, swapped: true, model: 'test-model-2' });
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(initialConnector!.closeCalled).toBe(true);
    expect(ctx.agent!.currentConnector.model).toBe('test-model-2');
  });

  it('model.change response includes swapped: false for no-op (same model)', async () => {
    await createReasoningAgent(ctx);

    const response = await sendModelChange({ newModel: 'test-model-1' });

    expect(response).toEqual({ success: true, swapped: false });
  });

  it('reasoning-only change triggers swap when changeReasoningInPlace returns false', async () => {
    await createReasoningAgent(ctx, {
      initialReasoningEffort: 'low',
      availableModels: [
        {
          name: 'test-model-1',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
      ],
    });
    // Force changeReasoningInPlace to return false so the swap path is taken.
    ctx.agent!.currentConnector.changeReasoningInPlaceResult = false;

    const response = await sendModelChange({ reasoningEffort: 'high' });

    expect(response).toMatchObject({ success: true, swapped: true });
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(ctx.createdConnectors[1]?.currentReasoningEffort).toBe('high');
  });

  it('resolveReasoningEffort falls back to medium when prior effort is unsupported by new model', async () => {
    await createReasoningAgent(ctx, {
      initialReasoningEffort: 'high',
      availableModels: [
        {
          name: 'test-model-1',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
        {
          name: 'test-model-2',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          // 'high' is absent; fallback chain should land on 'medium'.
          supportedReasoningLevels: { low: 1, medium: 2 },
        },
      ],
    });

    const response = await sendModelChange({ newModel: 'test-model-2' });

    expect(response).toMatchObject({ success: true, appliedReasoningEffort: 'medium' });
  });

  it('resolveReasoningEffort falls back to first supported key when medium is also unsupported', async () => {
    await createReasoningAgent(ctx, {
      initialReasoningEffort: 'high',
      availableModels: [
        {
          name: 'test-model-1',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          supportedReasoningLevels: { low: 1, medium: 2, high: 3 },
        },
        {
          name: 'test-model-2',
          contextWindowSize: 1_000,
          labId: 'test-lab',
          // Neither 'high' nor 'medium' — only 'extra-high'.
          supportedReasoningLevels: { 'extra-high': 16384 },
        },
      ],
    });

    const response = await sendModelChange({ newModel: 'test-model-2' });

    expect(response).toMatchObject({ success: true, appliedReasoningEffort: 'extra-high' });
  });

  it('no-op when neither newModel nor reasoningEffort is provided', async () => {
    await createReasoningAgent(ctx);
    const initialConnector = ctx.createdConnectors[0];

    const response = await sendModelChange();

    expect(response).toEqual({ success: true, swapped: false });
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(ctx.agent!.currentConnector).toBe(initialConnector);
    expect(ctx.agent!.currentConnector.model).toBe('test-model-1');
  });
});
