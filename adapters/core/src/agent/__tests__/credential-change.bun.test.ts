import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, CredentialSubjects } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { createMockScopedBus } from '@makaio/test-utils';
import {
  asAgentConnector,
  createTestableAgent,
  createAgentTestLifecycle,
  TestableAgent,
} from './helpers/mock-agent.js';
import type { AIAgentConfig } from '../types.js';

/** Request payload type for `credential.change`, derived from the subject definition. */
type CredentialChangeRequest = (typeof AgentSubjects.credential.change)['$meta']['payload']['request'];

/** Response type for `credential.change`, derived from the subject definition. */
type CredentialChangeResponse = (typeof AgentSubjects.credential.change)['$meta']['payload']['response'];

/** Standard agent ID used by all credential-change tests. */
const TEST_AGENT_ID = 'test-agent-credential';

/** Credential ref fixture — a branded ref for the `apiKey` field of `test-config`. */
const API_KEY_REF = buildStoredCredentialRef('test-config', 'apiKey');

/**
 * Small deferred helper for coordinating overlapping async test flows.
 * @returns Promise plus explicit resolve handle
 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

/**
 * Minimal `AdapterSubsystemSubjects.buildProviderContext` and
 * `ProviderStorageSubjects.get` handlers required when a credential.change
 * request triggers `handleCredentialChanged`.
 *
 * Registers both handlers and pushes their cleanup functions into `cleanupFns`.
 * @param cleanupFns - Mutable array that collects unsubscribe callbacks
 */
function registerProviderContextHandlers(cleanupFns: Array<() => void>): void {
  cleanupFns.push(
    MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
      if (ctx.payload.providerConfigId !== 'test-config') {
        ctx.setResult({ context: null });
        return;
      }

      ctx.setResult({
        context: {
          providerConfigId: 'test-config',
          definitionId: 'test-def',
          credentialRefs: {
            apiKey: API_KEY_REF,
          },
          credentialEnvVars: {
            apiKey: 'TEST_API_KEY',
          },
          endpointOverrides: {
            anthropic: 'https://api.test.example.com',
          },
        },
      });
    }),
  );
  cleanupFns.push(
    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({
        provider: {
          id: 'test-def',
          packageName: '@makaio/provider-test',
          name: 'Test Provider',
          endpoints: { anthropic: 'https://api.anthropic.com' },
          credentialEnvVars: { apiKey: 'TEST_API_KEY' },
          availableModels: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }),
  );
}

/**
 * Send a `credential.change` request for the standard test agent.
 * @param overrides - Partial payload fields to merge into the base request
 * @returns The bus response
 */
async function sendCredentialChange(
  overrides: Partial<Omit<CredentialChangeRequest, 'agentId'>> = {},
): Promise<CredentialChangeResponse> {
  return MakaioBus.request(AgentSubjects.credential.change, {
    agentId: TEST_AGENT_ID,
    adapterId: 'test-adapter',
    adapterName: 'test',
    adapterSessionId: 'test-session-id',
    providerConfigId: 'test-config',
    definitionId: 'test-def',
    changeSequence: 1,
    credentialRefs: { apiKey: API_KEY_REF },
    ...overrides,
  });
}

describe('AIAgent credential.change handler', () => {
  const ctx = createAgentTestLifecycle();

  beforeEach(() => ctx.reset());
  afterEach(async () => await ctx.teardown());

  it('credential.change triggers connector swap and returns { success: true, swapped: true }', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    registerProviderContextHandlers(ctx.cleanupFns);
    // credential.activate is a request subject — register a no-op handler.
    ctx.cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activate, (activateCtx) => {
        activateCtx.setResult({});
      }),
    );

    const response = await sendCredentialChange();

    expect(response).toEqual({ success: true, swapped: true });
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('credential.change for a different provider returns { success: false, reason: provider_mismatch }', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: {
        providerConfigId: 'other-config',
        definitionId: 'other-def',
        credentialRefs: {},
      },
    });
    await ctx.agent.init();

    // Send credential.change targeting 'test-config' while agent uses 'other-config'.
    const response = await sendCredentialChange();

    expect(response).toEqual({ success: false, reason: 'provider_mismatch' });
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('credential.change during active turn returns { success: false, reason: turn_active }', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();
    ctx.agent.currentConnector.setProcessingState('processing_started');

    const response = await sendCredentialChange();

    expect(response).toEqual({ success: false, reason: 'turn_active' });
    // No second connector should have been created.
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('ignores a stale credential.change sequence after a newer change already applied', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    registerProviderContextHandlers(ctx.cleanupFns);
    ctx.cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activate, (activateCtx) => {
        activateCtx.setResult({});
      }),
    );

    const newerResponse = await sendCredentialChange({
      changeSequence: 2,
      credentialRefs: { apiKey: buildStoredCredentialRef('test-config', 'newerApiKey') },
    });
    expect(newerResponse).toEqual({ success: true, swapped: true });

    const staleResponse = await sendCredentialChange({
      changeSequence: 1,
      credentialRefs: { apiKey: buildStoredCredentialRef('test-config', 'staleApiKey') },
    });

    expect(staleResponse).toEqual({ success: false, reason: 'stale_change' });
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('rejects an older in-flight credential.change once a newer sequence supersedes it', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    registerProviderContextHandlers(ctx.cleanupFns);
    const firstActivateStarted = createDeferred();
    const releaseFirstActivate = createDeferred();

    ctx.cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activate, async (activateCtx) => {
        const ref = activateCtx.payload.credentialRefs['apiKey'];
        if (ref === buildStoredCredentialRef('test-config', 'staleApiKey')) {
          firstActivateStarted.resolve();
          await releaseFirstActivate.promise;
        }
        activateCtx.setResult({});
      }),
    );

    const staleRequest = sendCredentialChange({
      changeSequence: 1,
      credentialRefs: { apiKey: buildStoredCredentialRef('test-config', 'staleApiKey') },
    });

    await firstActivateStarted.promise;

    const newerRequest = sendCredentialChange({
      changeSequence: 2,
      credentialRefs: { apiKey: buildStoredCredentialRef('test-config', 'newerApiKey') },
    });

    releaseFirstActivate.resolve();

    await expect(staleRequest).resolves.toEqual({ success: false, reason: 'stale_change' });
    await expect(newerRequest).resolves.toEqual({ success: true, swapped: true });
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('credential.activate is emitted before connector swap with correct payload fields', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    registerProviderContextHandlers(ctx.cleanupFns);

    // Capture ordering: set up the event trace AFTER init() so only the
    // credential-swap factory call (not the init call) contributes 'swap'.
    const eventOrder: string[] = [];

    const activatePayloads: Array<{
      providerConfigId: string;
      definitionId: string;
      credentialRefs: Record<string, string>;
    }> = [];

    ctx.cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activate, (activateCtx) => {
        eventOrder.push('activate');
        activatePayloads.push({
          providerConfigId: activateCtx.payload.providerConfigId,
          definitionId: activateCtx.payload.definitionId,
          credentialRefs: activateCtx.payload.credentialRefs as Record<string, string>,
        });
        activateCtx.setResult({});
      }),
    );

    const originalImpl = ctx.mockFactory.getMockImplementation();
    if (!originalImpl) {
      throw new Error('mockFactory has no implementation in createAgentTestLifecycle');
    }
    ctx.mockFactory.mockImplementation((config) => {
      const connector = originalImpl(config);
      eventOrder.push('swap');
      return connector;
    });

    await sendCredentialChange();

    expect(activatePayloads).toHaveLength(1);
    expect(activatePayloads[0]).toEqual({
      providerConfigId: 'test-config',
      definitionId: 'test-def',
      credentialRefs: { apiKey: API_KEY_REF },
    });
    // Prove ordering: activate must have fired before the connector was swapped.
    expect(eventOrder).toEqual(['activate', 'swap']);
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('credential.activate failure blocks the connector swap', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    registerProviderContextHandlers(ctx.cleanupFns);
    ctx.cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activate, () => {
        throw new Error('activate handler failure');
      }),
    );

    const response = await sendCredentialChange();

    expect(response.success).toBe(false);
    if (response.success) {
      throw new Error('Expected credential change failure when credential.activate throws');
    }
    expect(response.reason).toContain('credential_swap_failed:');
    expect(response.reason).toContain('activate handler failure');
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('rechecks connector idleness after credential activation and before swap', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();
    const agent = ctx.agent;
    if (!agent) {
      throw new Error('Expected test agent to be initialized');
    }

    registerProviderContextHandlers(ctx.cleanupFns);
    ctx.cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activate, (activateCtx) => {
        agent.currentConnector.setProcessingState('processing_started');
        activateCtx.setResult({});
      }),
    );

    const response = await sendCredentialChange();

    expect(response).toEqual({ success: false, reason: 'turn_active' });
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('providerContext is updated after swap via setProviderContext', async () => {
    // Build a custom agent with a spied configFactory so we can assert on the
    // providerContext that arrives at the second connector swap, without accessing
    // the private agent config directly.
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
        // MockConnector satisfies all exercised AIAgentConnector methods;
        // the cast via Partial matches the pattern used in createTestableAgent.
        asAgentConnector(
          ctx.mockFactory({
            model: factoryConfig.model,
            cwd: factoryConfig.cwd,
          }),
        ),
    };

    ctx.agent = new TestableAgent(config, ctx.mockFactory);
    await ctx.agent.init();

    registerProviderContextHandlers(ctx.cleanupFns);
    ctx.cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activate, (activateCtx) => {
        activateCtx.setResult({});
      }),
    );

    const newRef = buildStoredCredentialRef('test-config', 'rotatedApiKey');
    await sendCredentialChange({ credentialRefs: { apiKey: newRef } });
    await ctx.agent.swapConnector();

    // The second configFactory call (for the credential-triggered swap) and the
    // third call (for a later public swap with no override) must both carry the
    // rotated refs. This proves the providerContext was persisted on the agent.
    expect(capturedContexts).toHaveLength(3);
    expect(capturedContexts[1]).toMatchObject({
      credentialRefs: { apiKey: newRef },
    });
    expect(capturedContexts[2]).toMatchObject({
      credentialRefs: { apiKey: newRef },
    });
  });

  it('credential.change returns a structured failure when provider context rebuild fails', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    const response = await sendCredentialChange();

    expect(response.success).toBe(false);
    // Narrow type: test already asserts success is false.
    if (response.success) return;
    expect(response.reason).toContain('credential_swap_failed');
    expect(response).not.toHaveProperty('swapped');
    expect(ctx.createdConnectors).toHaveLength(1);
  });
});
