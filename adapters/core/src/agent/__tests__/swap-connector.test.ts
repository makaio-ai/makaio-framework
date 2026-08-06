import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import { asAgentConnector, MockConnector } from './helpers/mock-agent.js';
import { AIAgent } from '../ai-agent.js';
import type { AgentConnectorConfigOverrides, AIAgentConfig } from '../types.js';
import type { AIAgentConnector } from '../../connector/agent-connector.js';
import {
  AdapterNamespace,
  AdapterSubjects,
  AuthCredentialRefSchema,
  CredentialSubjects,
  type NativeForkDirective,
  type ProviderAuthMethodDefinition,
  type ProviderContext,
} from '@makaio/contracts';
import type { ConfigFactoryInput } from '../../adapter/ai-adapter-config.js';
import type { AdapterProviderDefinition } from '../../types/provider-definition.js';
import { createTestProviderAuth } from '../../__tests__/__fixtures__/adapter-provider-auth.js';
import { AgentTeardownArbiter } from '../agent-teardown-arbiter.js';

const TEST_API_KEY_METHOD = {
  id: 'api-key',
  mode: 'explicit',
  label: 'API key',
  fields: [{ id: 'apiKey', label: 'API key', required: true, secret: true, sourceHints: [] }],
} satisfies ProviderAuthMethodDefinition;

/** Create a manually released async boundary for swap interleaving tests. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve: () => resolve?.() };
}

/**
 * Build a normalized explicit provider context matching createTestProviderAuth.
 * @param providerDefinitionId - Provider definition selected by the context
 * @returns Resolved explicit-auth provider context
 */
function explicitProviderContext(providerDefinitionId: string): ProviderContext {
  const sourceEnvVar = `${providerDefinitionId.replaceAll('-', '_').toUpperCase()}_API_KEY`;
  return {
    state: 'resolved',
    providerConfigId: `${providerDefinitionId}-config`,
    definitionId: providerDefinitionId,
    auth: {
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
      definition: TEST_API_KEY_METHOD,
      credentialRefs: { apiKey: AuthCredentialRefSchema.parse(`env:${sourceEnvVar}`) },
    },
  };
}

/** Build a managed native-account context for direct public-swap coverage. */
function inferredProviderContext(): ProviderContext {
  return {
    state: 'resolved',
    providerConfigId: 'native-config',
    definitionId: 'test-provider',
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native client' },
      account: { managerId: 'account-manager', accountId: 'account-1' },
    },
  };
}

/**
 * Extended test agent for swap-connector tests.
 * Tracks wireEvents calls and exposes swapConnector for direct testing.
 */
class SwapTestAgent extends AIAgent {
  public currentConnector!: MockConnector;
  public wireEventsCalls = 0;
  private mockConnectorFactory: (config: { model: string; cwd: string }) => MockConnector;

  /**
   * Create a swap test agent.
   * @param config - Agent configuration
   * @param mockConnectorFactory - Factory for creating mock connectors
   */
  public constructor(
    config: AIAgentConfig,
    mockConnectorFactory: (config: { model: string; cwd: string }) => MockConnector,
  ) {
    super(config);
    this.mockConnectorFactory = mockConnectorFactory;
  }

  /**
   * Expose swapConnector for testing.
   * @param configOverrides - Optional config overrides
   */
  public async testSwapConnector(configOverrides?: AgentConnectorConfigOverrides): Promise<void> {
    await this.swapConnector(configOverrides);
  }

  /** Return the connector synchronously published as the active primary. */
  public testPrimaryConnector(): MockConnector {
    // @ts-expect-error -- this test agent is constructed only with MockConnector factories
    return this.connector;
  }

  /**
   * Required abstract implementation - tracks calls.
   * @param connector - The connector to wire events for
   */
  protected async wireEvents(connector: AIAgentConnector): Promise<void> {
    this.wireEventsCalls++;
    // @ts-expect-error -- the factory always produces MockConnector instances; narrowing is safe here
    this.currentConnector = connector;
  }
}

/**
 * Create a SwapTestAgent instance with factory support.
 * @param mockConnectorFactory - Factory function for creating mock connectors
 * @param options - Optional provider metadata and config-input observer
 * @returns A configured SwapTestAgent
 */
function createSwapTestAgent(
  mockConnectorFactory: (config: { model: string; cwd: string }) => MockConnector,
  options?: {
    providerContext?: AIAgentConfig['providerContext'];
    definitionProviders?: AIAgentConfig['definitionProviders'];
    prepareAuthRuntime?: AIAgentConfig['prepareAuthRuntime'];
    resumeAdapterSessionId?: AIAgentConfig['resumeAdapterSessionId'];
    onConfigInput?: (input: ConfigFactoryInput) => void;
  },
): SwapTestAgent {
  const { bus: mockBus } = createMockScopedBus();

  const config: AIAgentConfig = {
    agentId: 'test-agent-swap',
    adapterId: 'test-adapter',
    adapterName: 'test',
    capabilities: [],
    nativeTools: [],
    adapterBus: mockBus,
    teardownArbiter: new AgentTeardownArbiter(),
    globalBus: MakaioBus,
    model: 'test-model-1',
    cwd: '/test/cwd1',
    ...(options?.providerContext !== undefined && { providerContext: options.providerContext }),
    ...(options?.definitionProviders !== undefined && { definitionProviders: options.definitionProviders }),
    ...(options?.prepareAuthRuntime !== undefined && { prepareAuthRuntime: options.prepareAuthRuntime }),
    ...(options?.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: options.resumeAdapterSessionId }),
    configFactory: async (input) => {
      options?.onConfigInput?.(input);
      return {
        bus: mockBus,
        agentId: 'test-agent-swap',
        adapterId: 'test-adapter',
        adapterName: 'test',
        model: input.model ?? 'test-model-1',
        cwd: input.cwd ?? '/test/cwd1',
      };
    },
    connectorFactory: async (factoryConfig) => {
      // MockConnector satisfies the runtime contract for all exercised methods
      return asAgentConnector(
        mockConnectorFactory({
          model: factoryConfig.model,
          cwd: factoryConfig.cwd,
        }),
      );
    },
  };

  return new SwapTestAgent(config, mockConnectorFactory);
}

describe('AIAgent.swapConnector', () => {
  let agent: SwapTestAgent;
  let createdConnectors: MockConnector[] = [];
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    createdConnectors = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await agent?.close();
  });

  it('creates a new connector via factories', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    expect(createdConnectors).toHaveLength(1);
    const initialConnector = createdConnectors[0];

    await agent.testSwapConnector({ model: 'test-model-2' });

    expect(createdConnectors).toHaveLength(2);
    expect(initialConnector.closeCalled).toBe(true);
    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(agent.currentConnector.cwd).toBe('/test/cwd1');
  });

  it('publishes an explicit fresh decision so later swaps do not resurrect the start-time resume target', async () => {
    const observedResumeIds: Array<string | undefined> = [];
    agent = createSwapTestAgent((config) => new MockConnector(config.model, config.cwd), {
      resumeAdapterSessionId: 'start-time-resume',
      onConfigInput: (input) => observedResumeIds.push(input.resumeAdapterSessionId),
    });
    await agent.init();

    // Explicit fresh decision (key present, value undefined) — e.g. a
    // non-native warm rehydrate.
    await agent.testSwapConnector({ resumeAdapterSessionId: undefined });
    // Later mutation swap without the key must inherit the published fresh
    // decision, not the consumed start-time resume target.
    await agent.testSwapConnector({ model: 'test-model-2' });

    expect(observedResumeIds).toEqual(['start-time-resume', undefined, undefined]);
  });

  it('queued swaps observe the published resume decision of an in-flight swap', async () => {
    // The fresh decision must be published inside the serialized swap
    // transaction: a swap queued behind the rehydrate must not build its
    // connector from the consumed start-time resume target.
    const observedResumeIds: Array<string | undefined> = [];
    agent = createSwapTestAgent((config) => new MockConnector(config.model, config.cwd), {
      resumeAdapterSessionId: 'start-time-resume',
      onConfigInput: (input) => observedResumeIds.push(input.resumeAdapterSessionId),
    });
    await agent.init();

    const freshSwap = agent.testSwapConnector({ resumeAdapterSessionId: undefined });
    const queuedSwap = agent.testSwapConnector({ model: 'test-model-2' });
    await Promise.all([freshSwap, queuedSwap]);

    expect(observedResumeIds).toEqual(['start-time-resume', undefined, undefined]);
  });

  it('publishes the provider-confirmed identity of a resumed swap for later swaps to inherit', async () => {
    const observedResumeIds: Array<string | undefined> = [];
    agent = createSwapTestAgent((config) => new MockConnector(config.model, config.cwd), {
      resumeAdapterSessionId: 'start-time-resume',
      onConfigInput: (input) => observedResumeIds.push(input.resumeAdapterSessionId),
    });
    await agent.init();

    // MockConnector confirms 'test-session-id' — the provider rotated the
    // session on resume. Later swaps must continue the live conversation,
    // not the abandoned requested target.
    await agent.testSwapConnector({ resumeAdapterSessionId: 'resumed-session' });
    await agent.testSwapConnector({ model: 'test-model-2' });

    expect(observedResumeIds).toEqual(['start-time-resume', 'resumed-session', 'test-session-id']);
  });

  it('re-points a pending resume target at the provider-confirmed session of a keyless swap', async () => {
    const observedResumeIds: Array<string | undefined> = [];
    agent = createSwapTestAgent((config) => new MockConnector(config.model, config.cwd), {
      resumeAdapterSessionId: 'start-time-resume',
      onConfigInput: (input) => observedResumeIds.push(input.resumeAdapterSessionId),
    });
    await agent.init();

    // A mutation swap without a resume key consumes the still-pending
    // start-time target; its replacement confirms 'test-session-id'. The
    // pending target must track that confirmed continuation so the next
    // keyless swap continues the live thread — not the stale target the
    // provider has already rotated away from (or that a suppressed turn
    // abandoned).
    await agent.testSwapConnector({ model: 'test-model-2' });
    await agent.testSwapConnector({ cwd: '/test/cwd2' });

    expect(observedResumeIds).toEqual(['start-time-resume', 'start-time-resume', 'test-session-id']);
  });

  it('rejects when connector is processing', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    // Set connector to processing state
    agent.currentConnector.setProcessingState('processing_started');

    await expect(agent.testSwapConnector({ model: 'test-model-2' })).rejects.toThrow(
      /Cannot swap connector while processing/,
    );
  });

  it('preserves agent identity (agentId unchanged)', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    const initialAgentId = agent.agentId;

    await agent.testSwapConnector({ cwd: '/test/cwd2' });

    expect(agent.agentId).toBe(initialAgentId);
  });

  it('calls wireEvents on new connector', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    expect(agent.wireEventsCalls).toBe(1);

    await agent.testSwapConnector({ cwd: '/test/cwd2' });

    expect(agent.wireEventsCalls).toBe(2);
  });

  it('uses the injected auth preparer for initial creation and every swap', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });
    const prepareAuthRuntime = vi.fn(
      async (config: Parameters<NonNullable<AIAgentConfig['prepareAuthRuntime']>>[0]) => {
        const { boundProviderAuth: _boundProviderAuth, ...runtimeConfig } = config;
        return { config: { ...runtimeConfig, contextEnv: Object.freeze({}) } };
      },
    );

    agent = createSwapTestAgent(mockFactory, { prepareAuthRuntime });
    await agent.init();
    await agent.testSwapConnector({ model: 'test-model-2' });

    expect(prepareAuthRuntime).toHaveBeenCalledTimes(2);
  });

  it('applies both cwd and model overrides', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    await agent.testSwapConnector({ model: 'test-model-3', cwd: '/test/cwd3' });

    expect(agent.currentConnector.model).toBe('test-model-3');
    expect(agent.currentConnector.cwd).toBe('/test/cwd3');
  });

  it('preserves runtime overrides across sequential swaps (composability)', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    // Initial state: model='test-model-1', cwd='/test/cwd1'
    expect(agent.currentConnector.model).toBe('test-model-1');
    expect(agent.currentConnector.cwd).toBe('/test/cwd1');

    // Swap 1: Change cwd only - model should be preserved
    await agent.testSwapConnector({ cwd: '/test/cwd2' });
    expect(agent.currentConnector.model).toBe('test-model-1');
    expect(agent.currentConnector.cwd).toBe('/test/cwd2');

    // Swap 2: Change model only - cwd should stay at '/test/cwd2', NOT reset to '/test/cwd1'
    await agent.testSwapConnector({ model: 'test-model-2' });
    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(agent.currentConnector.cwd).toBe('/test/cwd2');

    // Verify both values were preserved through sequential swaps
    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(agent.currentConnector.cwd).toBe('/test/cwd2');
  });

  it('serializes concurrent public swaps so each replacement owns the latest generation', async () => {
    const firstInitializeStarted = createDeferred();
    const releaseFirstInitialize = createDeferred();
    let factoryCalls = 0;
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      factoryCalls += 1;
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      if (factoryCalls === 2) {
        connector.initialize = vi.fn(async () => {
          firstInitializeStarted.resolve();
          await releaseFirstInitialize.promise;
        });
      }
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    const cwdSwap = agent.testSwapConnector({ cwd: '/test/cwd2' });
    await firstInitializeStarted.promise;
    const modelSwap = agent.testSwapConnector({ model: 'test-model-2' });
    await Promise.resolve();

    // The model swap cannot create from generation A while the CWD swap owns it.
    expect(createdConnectors).toHaveLength(2);

    releaseFirstInitialize.resolve();
    await Promise.all([cwdSwap, modelSwap]);

    expect(createdConnectors).toHaveLength(3);
    expect(createdConnectors[0]?.closeCalled).toBe(true);
    expect(createdConnectors[1]?.closeCalled).toBe(true);
    expect(agent.currentConnector.cwd).toBe('/test/cwd2');
    expect(agent.currentConnector.model).toBe('test-model-2');
  });

  it('activates a managed account before a direct public provider-context swap publishes', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });
    const order: string[] = [];
    cleanupFns.push(
      MakaioBus.on(CredentialSubjects.activation.prepare, (ctx) => {
        order.push('prepare');
        ctx.setResult({ success: true, transactionId: crypto.randomUUID() });
      }),
      MakaioBus.on(CredentialSubjects.activation.commit, (ctx) => {
        order.push('commit');
        expect(agent.testPrimaryConnector()).toBe(createdConnectors[0]);
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(CredentialSubjects.activation.rollback, (ctx) => {
        order.push('rollback');
        ctx.setResult({ success: true });
      }),
    );
    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    await agent.testSwapConnector({ providerContext: inferredProviderContext() });

    expect(order).toEqual(['prepare', 'commit']);
    expect(agent.currentConnector).toBe(createdConnectors[1]);
  });

  it('keeps the new connector primary and emits a sanitized diagnostic when old cleanup fails', async () => {
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });
    MakaioBus.registerNamespaces([AdapterNamespace]);
    const diagnostics: string[] = [];
    cleanupFns.push(
      MakaioBus.on(AdapterSubjects.log, (ctx) => {
        diagnostics.push(ctx.payload.message);
      }),
    );

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    const initialConnector = createdConnectors[0];
    initialConnector.close = vi.fn(async () => {
      throw new Error('close failed');
    });

    await expect(agent.testSwapConnector({ model: 'test-model-2' })).resolves.toBeUndefined();

    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(diagnostics).toContain('previous-connector-cleanup-failed:swap-old-runtime');
    expect(diagnostics.join(' ')).not.toContain('close failed');
  });

  it('does not forward nativeFork to swapped connector (one-shot consumption)', async () => {
    const capturedInputs: Array<ConfigFactoryInput & { nativeFork?: NativeForkDirective }> = [];
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    const { bus: mockBus } = createMockScopedBus();
    const forkDirective: NativeForkDirective = {
      sourceSessionId: 'makaio-source',
      sourceAdapterSessionId: 'provider-source',
    };

    const config: AIAgentConfig = {
      agentId: 'test-agent-fork-swap',
      adapterId: 'test-adapter',
      adapterName: 'test',
      capabilities: [],
      nativeTools: [],
      adapterBus: mockBus,
      teardownArbiter: new AgentTeardownArbiter(),
      globalBus: MakaioBus,
      model: 'test-model-1',
      cwd: '/test/cwd1',
      nativeFork: forkDirective,
      configFactory: async (input) => {
        capturedInputs.push(input as ConfigFactoryInput & { nativeFork?: NativeForkDirective });
        return {
          bus: mockBus,
          agentId: 'test-agent-fork-swap',
          adapterId: 'test-adapter',
          adapterName: 'test',
          model: input.model ?? 'test-model-1',
          cwd: input.cwd ?? '/test/cwd1',
        };
      },
      connectorFactory: async (factoryConfig) => {
        return asAgentConnector(
          mockFactory({
            model: factoryConfig.model,
            cwd: factoryConfig.cwd,
          }),
        );
      },
    };

    agent = new SwapTestAgent(config, mockFactory);
    await agent.init();

    // init() must have forwarded the fork directive to the first connector
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].nativeFork).toEqual(forkDirective);

    // Swap: the fork directive must NOT be forwarded to the replacement
    await agent.testSwapConnector({ model: 'test-model-2' });

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[1].nativeFork).toBeUndefined();
  });

  it('selects auth metadata from the effective provider context for initial and replacement connectors', async () => {
    const capturedInputs: ConfigFactoryInput[] = [];
    const providerAAuth = createTestProviderAuth('provider-a');
    const providerBAuth = createTestProviderAuth('provider-b');
    const definitionProviders: AdapterProviderDefinition[] = [
      {
        definition: {
          id: 'provider-a',
          name: 'Provider A',
          availableModels: [],
          authMethods: [TEST_API_KEY_METHOD],
        },
        auth: providerAAuth,
      },
      {
        definition: {
          id: 'provider-b',
          name: 'Provider B',
          availableModels: [],
          authMethods: [TEST_API_KEY_METHOD],
        },
        auth: providerBAuth,
      },
    ];
    const providerAContext = explicitProviderContext('provider-a');
    const providerBContext = explicitProviderContext('provider-b');
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });
    agent = createSwapTestAgent(mockFactory, {
      providerContext: providerAContext,
      definitionProviders,
      onConfigInput: (input) => capturedInputs.push(input),
    });

    await agent.init();
    await agent.testSwapConnector({ model: 'test-model-2', providerContext: providerBContext });
    await agent.testSwapConnector({ cwd: '/test/cwd2' });

    expect(capturedInputs).toHaveLength(3);
    expect(capturedInputs[0]?.adapterProviderAuth).toEqual(providerAAuth);
    expect(capturedInputs[1]?.adapterProviderAuth).toEqual(providerBAuth);
    expect(capturedInputs[2]?.adapterProviderAuth).toEqual(providerBAuth);
  });

  it('does not fall back to single-provider auth across unresolved or mismatched connector swaps', async () => {
    const capturedInputs: ConfigFactoryInput[] = [];
    const adapterProviderAuth = createTestProviderAuth('provider-a');
    const mockFactory = vi.fn((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });
    agent = createSwapTestAgent(mockFactory, {
      definitionProviders: [
        {
          definition: {
            id: 'provider-a',
            name: 'Provider A',
            availableModels: [],
            authMethods: [TEST_API_KEY_METHOD],
          },
          auth: adapterProviderAuth,
        },
      ],
      onConfigInput: (input) => capturedInputs.push(input),
    });

    await agent.init();
    await agent.testSwapConnector({ cwd: '/test/unresolved-swap' });
    await agent.testSwapConnector({
      providerContext: explicitProviderContext('provider-b'),
    });
    await agent.testSwapConnector({ model: 'test-model-after-mismatch' });

    expect(capturedInputs).toHaveLength(4);
    expect(capturedInputs.map((input) => input.adapterProviderAuth)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
