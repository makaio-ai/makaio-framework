import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { createBusInstance, MakaioBus, RequestError, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  CredentialSubjects,
  SessionSubjects,
  type ConnectorTeardownResult,
} from '@makaio/contracts';
import type {
  ProviderAuthMethodDefinition,
  ResolvedProviderContext,
  ResponseSchemaDescriptor,
} from '@makaio/contracts';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { registerPreUserMessageHook, resetPreUserMessageHooks } from '@makaio/hooks';
import { createMockScopedBus } from '@makaio/test-utils';
import { AIAdapter } from '../ai-adapter.js';
import { EPHEMERAL_CLEANUP_COMPLETION_TIMEOUT_MS } from '../ai-adapter-start-handler.js';
import { createAdapterNamespace } from '../../factory/create-adapter-namespace.js';
import { AIAgent } from '../../agent/ai-agent.js';
import { AIAgentConnector } from '../../connector/agent-connector.js';
import { MessageHandle } from '../../message-handle/index.js';
import type {
  AIAgentConfig,
  AgentStartResult,
  BaseAgentConnectorConfig,
  ConnectorSendMessageOptions,
} from '../../agent/types.js';
import type { ConfigFactoryInput } from '../ai-adapter-config.js';
import type { AIAdapterConfig } from '../types.js';
import type { NormalizedMessageInput } from '../../utils/normalizeMessageInput.js';
import type { AdapterProviderDefinition } from '../../types/provider-definition.js';
import { createTestProviderAuth } from '../../__tests__/__fixtures__/adapter-provider-auth.js';
import { registerAgentRowStorage, registerStartReservationAuthority } from './shared.js';

type TestBus = ReturnType<typeof createMockScopedBus>['bus'];

const TEST_API_KEY_METHOD = {
  id: 'api-key',
  mode: 'explicit',
  label: 'API key',
  fields: [
    {
      id: 'apiKey',
      label: 'API key',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'TEST_PROVIDER_API_KEY' }],
    },
  ],
} satisfies ProviderAuthMethodDefinition;

interface ConnectorBehavior {
  inferredText: string;
  retryInferredText?: string;
  throwOnCreate?: Error;
  throwOnInitialize?: Error;
  throwOnStart?: Error;
  throwOnClose?: Error;
  completeOnStart?: boolean;
  onInitialize?: () => void;
  onStart?: () => void;
  onClose?: () => void;
}

class ConfigurableConnector extends AIAgentConnector {
  public closeCalls = 0;
  public initializeCalls = 0;
  private readonly behavior: ConnectorBehavior;
  public capturedStartMessage?: NormalizedMessageInput;
  public capturedStartSystemPrompt?: string;
  public capturedStartResponseSchema?: ResponseSchemaDescriptor;
  public capturedSendMessageOptions?: ConnectorSendMessageOptions;
  public capturedInitializeSystemPrompt?: string;
  public capturedInitializeResponseSchema?: ResponseSchemaDescriptor;
  public readonly startedHandles: MessageHandle[] = [];
  public sendMessageCalls = 0;

  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }, behavior: ConnectorBehavior) {
    super(config);
    this.behavior = behavior;
  }

  public async initialize(options?: {
    systemPrompt?: string;
    responseSchema?: ResponseSchemaDescriptor;
  }): Promise<void> {
    this.initializeCalls += 1;
    this.capturedInitializeSystemPrompt = options?.systemPrompt;
    this.capturedInitializeResponseSchema = options?.responseSchema;
    this.behavior.onInitialize?.();
    if (this.behavior.throwOnInitialize) {
      throw this.behavior.throwOnInitialize;
    }
  }

  public async start(
    message: NormalizedMessageInput,
    options?: { systemPrompt?: string; responseSchema?: ResponseSchemaDescriptor },
  ): Promise<AgentStartResult> {
    this.capturedStartMessage = message;
    this.capturedStartSystemPrompt = options?.systemPrompt;
    this.capturedStartResponseSchema = options?.responseSchema;
    this.behavior.onStart?.();

    if (this.behavior.throwOnStart) {
      throw this.behavior.throwOnStart;
    }

    const handle = new MessageHandle('infer-msg', message, 'enqueue');
    this.startedHandles.push(handle);
    if (this.behavior.completeOnStart ?? true) {
      handle.markCompleted({
        outcome: 'completed',
        result: { message: this.behavior.inferredText },
      });
    }

    return {
      adapterSessionId: 'infer-session',
      agentId: this.getAgentId(),
      messageHandle: handle,
    };
  }

  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    if (this.behavior.retryInferredText === undefined) {
      throw new Error('sendMessage should not be called in infer tests');
    }

    this.sendMessageCalls += 1;
    this.capturedSendMessageOptions = options;
    const handle = new MessageHandle(
      options?.messageId ?? 'infer-retry-msg',
      message,
      options?.deliveryMode ?? 'enqueue',
    );
    handle.markCompleted({
      outcome: 'completed',
      result: { message: this.behavior.retryInferredText },
    });
    return handle;
  }

  public abort(): void {}
  public async complete(): Promise<null> {
    return null;
  }
  public async interrupt(): Promise<void> {}
  public async close(): Promise<ConnectorTeardownResult> {
    this.closeCalls += 1;
    this.behavior.onClose?.();
    if (this.behavior.throwOnClose) {
      throw this.behavior.throwOnClose;
    }
    return { evidence: 'released' };
  }
  public async getAdapterSessionId(): Promise<string> {
    return 'infer-session';
  }
}

class TestAgent extends AIAgent<TestBus, ConfigurableConnector> {
  protected async wireEvents(_connector: ConfigurableConnector): Promise<void> {}
}

type AdapterConfigExtensions = {
  agentFactory: (config: AIAgentConfig<TestBus, ConfigurableConnector>) => TestAgent;
  configFactory: (
    input: ConfigFactoryInput<TestBus>,
  ) => Promise<BaseAgentConnectorConfig<TestBus> & { adapterId: string }>;
  connectorFactory: (
    config: BaseAgentConnectorConfig<TestBus> & { adapterId: string },
  ) => ConfigurableConnector | Promise<ConfigurableConnector>;
};

class TestAdapter extends AIAdapter<TestBus, ConfigurableConnector, TestAgent> {
  public constructor(config: AIAdapterConfig<TestBus> & AdapterConfigExtensions) {
    super(config);
  }
}

class InitDefaultsAdapter extends TestAdapter {
  protected override async onInit(): Promise<void> {
    this.platformDefaults = { cwd: os.tmpdir(), env: { TEST_DEFAULT: '1' } };
  }
}

type AdapterCapture = {
  configFactoryInputs: ConfigFactoryInput<TestBus>[];
  connectors: ConfigurableConnector[];
  agentConfigs: Array<AIAgentConfig<TestBus, ConfigurableConnector>>;
};

type AdapterCtor<T extends TestAdapter> = new (config: AIAdapterConfig<TestBus> & AdapterConfigExtensions) => T;

function buildAdapter<T extends TestAdapter>(
  Ctor: AdapterCtor<T>,
  name: string,
  behavior: ConnectorBehavior,
  capture: AdapterCapture,
  options?: {
    definitionProviders?: AdapterProviderDefinition[];
    globalBus?: IMakaioBus;
    prepareAuthRuntime?: AIAdapterConfig<TestBus>['prepareAuthRuntime'];
  },
): T {
  const { bus: scopedBus } = createMockScopedBus();
  const namespace = createAdapterNamespace(name, {});

  return new Ctor({
    name,
    machineId: 'test-machine',
    ownerInstanceId: 'test-owner-instance',
    capabilities: [],
    nativeTools: [],
    namespace,
    scopedBus,
    globalBus: options?.globalBus ?? MakaioBus,
    agentFactory: (config: AIAgentConfig<TestBus, ConfigurableConnector>) => {
      capture.agentConfigs.push(config);
      return new TestAgent(config);
    },
    configFactory: async (input: ConfigFactoryInput<TestBus>) => {
      capture.configFactoryInputs.push(input);
      return {
        bus: scopedBus,
        agentId: input.agentId ?? 'test-agent',
        adapterId: input.adapterId ?? 'test-adapter-id',
        adapterName: name,
        model: input.model ?? 'default-model',
        cwd: input.cwd ?? os.tmpdir(),
      };
    },
    connectorFactory: async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) => {
      if (behavior.throwOnCreate) {
        throw behavior.throwOnCreate;
      }
      const connector = new ConfigurableConnector(config, behavior);
      capture.connectors.push(connector);
      return connector;
    },
    definitionProviders: options?.definitionProviders,
    prepareAuthRuntime: options?.prepareAuthRuntime,
  });
}

function createTestAdapter(
  behavior: ConnectorBehavior,
  capture: AdapterCapture,
  options?: {
    definitionProviders?: AdapterProviderDefinition[];
    prepareAuthRuntime?: AIAdapterConfig<TestBus>['prepareAuthRuntime'];
  },
): TestAdapter {
  return buildAdapter(TestAdapter, 'test-adapter-infer', behavior, capture, options);
}

function createInitDefaultsAdapter(behavior: ConnectorBehavior, capture: AdapterCapture): InitDefaultsAdapter {
  return buildAdapter(InitDefaultsAdapter, 'test-adapter-init-defaults', behavior, capture);
}

/**
 * Build a normalized explicit-auth context for provider-selection tests.
 * @param definitionId - Provider definition selected by the context
 * @param providerConfigId - Provider config identity selected by the context
 * @returns Resolved explicit-auth provider context
 */
function createResolvedProviderContext(
  definitionId: string,
  providerConfigId = `${definitionId}-config`,
): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId,
    auth: {
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: definitionId, methodId: 'api-key' },
      definition: TEST_API_KEY_METHOD,
      credentialRefs: { apiKey: buildStoredCredentialRef(providerConfigId, 'apiKey') },
    },
  };
}

/**
 * Build a managed inferred-auth context for atomic activation tests.
 * @param selectedAccount - Whether the inferred method selects a managed native account
 * @returns Resolved inferred provider context
 */
function createManagedInferredProviderContext(selectedAccount = true): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId: 'native-provider-config',
    definitionId: 'native-provider',
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native account' },
      ...(selectedAccount && { account: { managerId: 'account-manager', accountId: 'account-1' } }),
    },
  };
}

/** Activation transaction fixture controls for adapter lifecycle tests. */
interface ActivationFixtureOptions {
  /** Result code returned by each commit attempt; undefined means success. */
  readonly commitCode?: (attempt: number) => 'commit-failed' | 'commit-rollback-failed' | undefined;
  /** Whether rollback reports a native/durable restoration failure. */
  readonly rollbackFails?: boolean;
  /** Optional assertion executed while commit still owns the activation lock. */
  readonly onCommit?: () => void;
}

/**
 * Register an opaque account activation transaction fixture.
 * @param events - Ordered lifecycle event sink
 * @param options - Commit/rollback behavior controls
 * @returns Cleanup function for all transaction handlers
 */
function registerActivationFixture(events: string[], options: ActivationFixtureOptions = {}): () => void {
  let transactionSequence = 0;
  let commitAttempts = 0;
  const cleanups = [
    MakaioBus.on(CredentialSubjects.activation.prepare, (ctx) => {
      events.push('prepare');
      transactionSequence += 1;
      ctx.setResult({ success: true, transactionId: `activation-${transactionSequence}` });
    }),
    MakaioBus.on(CredentialSubjects.activation.commit, (ctx) => {
      events.push('commit');
      options.onCommit?.();
      commitAttempts += 1;
      const code = options.commitCode?.(commitAttempts);
      ctx.setResult(code === undefined ? { success: true } : { success: false, code });
    }),
    MakaioBus.on(CredentialSubjects.activation.rollback, (ctx) => {
      events.push('rollback');
      ctx.setResult(options.rollbackFails ? { success: false, code: 'rollback-failed' } : { success: true });
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Build a host-local auth preparer that records exact lease materialization.
 * @param events - Ordered lifecycle event sink
 * @returns Test auth runtime preparer
 */
function createRecordingAuthPreparer(events: string[]): NonNullable<AIAdapterConfig<TestBus>['prepareAuthRuntime']> {
  return async (config) => {
    events.push('materialize');
    const { boundProviderAuth: _boundProviderAuth, ...runtimeConfig } = config;
    return { config: { ...runtimeConfig, contextEnv: Object.freeze({}) } };
  };
}

describe('AIAdapter.handleInfer', () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await adapter?.closeAsync();
  });

  it('commits managed account activation after infer initialization and before dispatch', async () => {
    const events: string[] = [];
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter(
      {
        inferredText: 'managed inference',
        onInitialize: () => events.push('initialize'),
        onStart: () => events.push('start'),
        onClose: () => events.push('close'),
      },
      capture,
      { prepareAuthRuntime: createRecordingAuthPreparer(events) },
    );
    await adapter.init();
    const cleanupActivation = registerActivationFixture(events);

    try {
      const result = await MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'infer with selected native account',
        providerContext: createManagedInferredProviderContext(),
      });

      expect(result.text).toBe('managed inference');
      expect(events).toEqual(['prepare', 'materialize', 'initialize', 'commit', 'start', 'close']);
    } finally {
      cleanupActivation();
    }
  });

  it('fails direct infer before runtime materialization when the selected account manager is missing', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: 'must not run' }, capture);
    await adapter.init();

    await expect(
      MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'infer with unavailable account manager',
        providerContext: createManagedInferredProviderContext(),
      }),
    ).rejects.toThrow('selected account manager is unavailable');
    expect(capture.configFactoryInputs).toEqual([]);
    expect(capture.connectors).toEqual([]);
  });

  it('keeps unresolved, explicit, none, and unselected inferred auth activation-free', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: 'side-effect-free' }, capture);
    await adapter.init();
    let prepareCalls = 0;
    const cleanupPrepare = MakaioBus.on(CredentialSubjects.activation.prepare, (ctx) => {
      prepareCalls += 1;
      ctx.setResult({ success: false, code: 'activation-failed' });
    });
    const inferredWithoutAccount = createManagedInferredProviderContext(false);
    const noAuth: ResolvedProviderContext = {
      state: 'resolved',
      providerConfigId: 'no-auth-config',
      definitionId: 'no-auth-provider',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'no-auth-provider', methodId: 'none' },
        definition: { id: 'none', mode: 'none', label: 'No authentication' },
      },
    };

    try {
      await MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'unresolved',
      });
      await MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'explicit',
        providerContext: createResolvedProviderContext('explicit-provider'),
      });
      await MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'none',
        providerContext: noAuth,
      });
      await MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'unselected inferred',
        providerContext: inferredWithoutAccount,
      });

      expect(prepareCalls).toBe(0);
      expect(capture.connectors).toHaveLength(4);
    } finally {
      cleanupPrepare();
    }
  });

  it('closes infer runtime without dispatch when account activation commit fails', async () => {
    const events: string[] = [];
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter(
      {
        inferredText: 'must not dispatch',
        onInitialize: () => events.push('initialize'),
        onStart: () => events.push('start'),
        onClose: () => events.push('close'),
      },
      capture,
      { prepareAuthRuntime: createRecordingAuthPreparer(events) },
    );
    await adapter.init();
    const cleanupActivation = registerActivationFixture(events, { commitCode: () => 'commit-failed' });

    try {
      await expect(
        MakaioBus.request(AdapterSubjects.infer, {
          adapterId: adapter.adapterId,
          prompt: 'do not dispatch after failed commit',
          providerContext: createManagedInferredProviderContext(),
        }),
      ).rejects.toThrow('selected account could not be activated');
      expect(events).toEqual(['prepare', 'materialize', 'initialize', 'commit', 'close']);
      expect(capture.connectors[0]?.closeCalls).toBe(1);
    } finally {
      cleanupActivation();
    }
  });

  it('holds managed account activation through idle start readiness and commits before registry publication', async () => {
    const events: string[] = [];
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '', onInitialize: () => events.push('initialize') }, capture, {
      prepareAuthRuntime: createRecordingAuthPreparer(events),
    });
    await adapter.init();
    const cleanupActivation = registerActivationFixture(events, {
      onCommit: () => expect(adapter.getActiveAgents()).toEqual([]),
    });

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        providerContext: createManagedInferredProviderContext(),
      });

      expect(result.success).toBe(true);
      expect(events).toEqual(['prepare', 'materialize', 'initialize', 'commit']);
      expect(adapter.getActiveAgents()).toHaveLength(1);
    } finally {
      cleanupActivation();
    }
  });

  it('fails direct start before connector creation when the selected account manager is missing', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: 'must not run' }, capture);
    await adapter.init();

    await expect(
      MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        providerContext: createManagedInferredProviderContext(),
      }),
    ).rejects.toThrow('selected account manager is unavailable');
    expect(capture.configFactoryInputs).toEqual([]);
    expect(capture.connectors).toEqual([]);
    expect(adapter.getActiveAgents()).toEqual([]);
  });

  it('releases the resume claim and closes the agent when activation commit fails', async () => {
    const events: string[] = [];
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '', onInitialize: () => events.push('initialize') }, capture, {
      prepareAuthRuntime: createRecordingAuthPreparer(events),
    });
    await adapter.init();
    const cleanupActivation = registerActivationFixture(events, {
      commitCode: (attempt) => (attempt === 1 ? 'commit-failed' : undefined),
    });
    // The start below is an adapter-owned resume, which now writes a
    // pre-dispatch row and reserves its provider session before dispatching.
    const cleanupHost = [registerStartReservationAuthority(), registerAgentRowStorage()];
    const request = {
      adapterId: adapter.adapterId,
      role: 'lead' as const,
      mode: 'resume' as const,
      sessionId: 'resume-session',
      adapterSessionId: 'native-resume-session',
      providerContext: createManagedInferredProviderContext(),
    };

    try {
      await expect(MakaioBus.request(AdapterSubjects.startAgent, request)).rejects.toThrow(
        'selected account could not be activated',
      );
      expect(capture.connectors[0]?.closeCalls).toBe(1);
      expect(adapter.getActiveAgents()).toEqual([]);

      const retry = await MakaioBus.request(AdapterSubjects.startAgent, request);
      expect(retry.success).toBe(true);
      expect(capture.connectors).toHaveLength(2);
    } finally {
      cleanupActivation();
      for (const cleanup of cleanupHost) cleanup();
    }
  });

  it('sanitizes startup secrets when connector failure and account rollback both fail', async () => {
    const events: string[] = [];
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter(
      {
        inferredText: '',
        throwOnInitialize: new Error('connector leaked secret-token-value'),
        onInitialize: () => events.push('initialize'),
        onClose: () => events.push('close'),
      },
      capture,
      { prepareAuthRuntime: createRecordingAuthPreparer(events) },
    );
    await adapter.init();
    const cleanupActivation = registerActivationFixture(events, { rollbackFails: true });

    try {
      const error = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        providerContext: createManagedInferredProviderContext(),
      }).catch((value: unknown) => value);

      expect(error).toBeInstanceOf(RequestError);
      const aggregate = (error as RequestError).cause;
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect((aggregate as AggregateError).cause).toBeUndefined();
      expect((aggregate as AggregateError).errors.map(String).join(' ')).not.toContain('secret-token-value');
      expect(events).toEqual(['prepare', 'materialize', 'initialize', 'close', 'rollback']);
      expect(adapter.getActiveAgents()).toEqual([]);
    } finally {
      cleanupActivation();
    }
  });

  it('sanitizes startup secrets when connector creation and auth lease rollback both fail', async () => {
    const events: string[] = [];
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter(
      {
        inferredText: '',
        throwOnCreate: new Error('connector creation leaked secret-create-value'),
      },
      capture,
      {
        prepareAuthRuntime: async (config) => {
          events.push('materialize');
          const { boundProviderAuth: _boundProviderAuth, ...runtimeConfig } = config;
          return {
            config: { ...runtimeConfig, contextEnv: Object.freeze({}) },
            lease: {
              clientId: 'test-client',
              leaseId: 'failing-lease',
              release: async () => {
                throw new Error('lease rollback leaked secret-lease-value');
              },
            },
          };
        },
      },
    );
    await adapter.init();
    const cleanupActivation = registerActivationFixture(events);

    try {
      const error = await MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'fail during connector creation',
        providerContext: createManagedInferredProviderContext(),
      }).catch((value: unknown) => value);

      expect(error).toBeInstanceOf(RequestError);
      const aggregate = (error as RequestError).cause;
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect((aggregate as AggregateError).cause).toBeUndefined();
      const diagnostics = (aggregate as AggregateError).errors.map(String).join(' ');
      expect(diagnostics).not.toContain('secret-create-value');
      expect(diagnostics).not.toContain('secret-lease-value');
      expect(events).toEqual(['prepare', 'materialize', 'rollback']);
      expect(capture.connectors).toEqual([]);
    } finally {
      cleanupActivation();
    }
  });

  it('returns inferred text and forwards model/systemPrompt/providerContext', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: 'inferred output' }, capture);
    await adapter.init();

    const providerContext = createResolvedProviderContext('test-provider', 'test-config');
    const result = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer this',
      model: 'override-model',
      systemPrompt: 'classification-system-prompt',
      providerContext,
    });

    expect(result.text).toBe('inferred output');
    expect(capture.configFactoryInputs).toHaveLength(1);
    expect(capture.configFactoryInputs[0]?.model).toBe('override-model');
    expect(capture.configFactoryInputs[0]?.providerContext).toEqual(providerContext);
    expect(capture.configFactoryInputs[0]?.adapterProviderAuth).toBeUndefined();
    // Infer connectors are one-shot: they must declare ephemeral so
    // persistence-capable connectors never write orphaned transcripts.
    expect(capture.configFactoryInputs[0]?.ephemeral).toBe(true);
    expect(capture.connectors).toHaveLength(1);
    expect(capture.connectors[0]?.initializeCalls).toBe(1);
    expect(capture.connectors[0]?.capturedInitializeSystemPrompt).toBe('classification-system-prompt');
    expect(capture.connectors[0]?.capturedStartMessage?.message).toBe('infer this');
    expect(capture.connectors[0]?.capturedStartSystemPrompt).toBe('classification-system-prompt');
    expect(capture.connectors[0]?.closeCalls).toBe(1);
  });

  it('forwards auth metadata for the provider selected by inference context', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    const adapterProviderAuth = createTestProviderAuth('provider-a');
    adapter = createTestAdapter({ inferredText: 'authenticated output' }, capture, {
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
    });
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer with selected auth',
      providerContext: createResolvedProviderContext('provider-a'),
    });

    expect(result.text).toBe('authenticated output');
    expect(capture.configFactoryInputs[0]?.adapterProviderAuth).toEqual(adapterProviderAuth);
  });

  it('does not fall back to single-provider auth for unresolved or mismatched inference contexts', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    const adapterProviderAuth = createTestProviderAuth('provider-a');
    adapter = createTestAdapter({ inferredText: 'unbound output' }, capture, {
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
    });
    await adapter.init();

    await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer without provider resolution',
    });
    await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer with mismatched provider',
      providerContext: createResolvedProviderContext('provider-b'),
    });

    expect(capture.configFactoryInputs).toHaveLength(2);
    expect(capture.configFactoryInputs[0]?.adapterProviderAuth).toBeUndefined();
    expect(capture.configFactoryInputs[1]?.adapterProviderAuth).toBeUndefined();
  });

  it('passes the injected globalBus through infer config factory input', async () => {
    const hostBus = createBusInstance();
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = buildAdapter(TestAdapter, 'test-adapter-infer-host-bus', { inferredText: 'host-bus-ok' }, capture, {
      globalBus: hostBus,
    });
    await adapter.init();

    const result = await hostBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer this',
    });

    expect(result.text).toBe('host-bus-ok');
    expect(capture.configFactoryInputs).toHaveLength(1);
    expect(capture.configFactoryInputs[0]?.globalBus).toBe(hostBus);
  });

  it('forwards responseSchema from infer payload to connector initialize and start', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '{"answer":"schema-inferred"}' }, capture);
    await adapter.init();

    const responseSchema: ResponseSchemaDescriptor = {
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      name: 'answer_schema',
    };
    const result = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'classify this',
      responseSchema,
    });

    expect(result.text).toBe('{"answer":"schema-inferred"}');
    expect(capture.connectors[0]?.capturedInitializeResponseSchema).toEqual(responseSchema);
    expect(capture.connectors[0]?.capturedStartResponseSchema).toEqual(responseSchema);
  });

  it('validates and enforces responseSchema output before returning from infer', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    let enforcePayload: unknown;
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      enforcePayload = ctx.payload;
      ctx.setResult({ enforced: true, output: '{"answer":"fixed"}' });
    });
    adapter = createTestAdapter({ inferredText: 'not json' }, capture);
    await adapter.init();

    const responseSchema: ResponseSchemaDescriptor = {
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      name: 'answer_schema',
    };
    const result = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'classify this',
      responseSchema,
    });

    expect(result.text).toBe('{"answer":"fixed"}');
    expect(enforcePayload).toMatchObject({
      adapterId: adapter.adapterId,
      adapterHasCapability: false,
      rawOutput: 'not json',
      responseSchema,
    });
  });

  it('retries invalid responseSchema infer output before returning', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    MakaioBus.on(AgentSubjects.structuredOutput.retryPolicy, (ctx) => {
      ctx.setResult({ maxRetries: 1 });
    });
    const enforceHandler = vi.fn();
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      enforceHandler();
      ctx.setResult({ enforced: false, error: 'unexpected enforce' });
    });
    adapter = createTestAdapter({ inferredText: '{"answer":7}', retryInferredText: '{"answer":"retried"}' }, capture);
    await adapter.init();

    const responseSchema: ResponseSchemaDescriptor = {
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      name: 'answer_schema',
    };
    const result = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'classify this',
      responseSchema,
    });

    expect(result.text).toBe('{"answer":"retried"}');
    expect(capture.connectors[0]?.sendMessageCalls).toBe(1);
    expect(capture.connectors[0]?.capturedSendMessageOptions).toMatchObject({
      internalRetry: true,
      responseSchema,
      turnContext: {
        structuredOutputRetry: expect.objectContaining({ attemptNumber: 1 }),
      },
    });
    expect(enforceHandler).not.toHaveBeenCalled();
  });

  it('rejects infer when responseSchema validation cannot be enforced', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '{"answer":7}' }, capture);
    await adapter.init();

    const responseSchema: ResponseSchemaDescriptor = {
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      name: 'answer_schema',
    };

    await expect(
      MakaioBus.request(AdapterSubjects.infer, {
        adapterId: adapter.adapterId,
        prompt: 'classify this',
        responseSchema,
      }),
    ).rejects.toThrow('Structured output validation failed');
  });

  it('propagates inference errors while still closing the ephemeral connector', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter(
      {
        inferredText: '',
        throwOnStart: new Error('start failed'),
        throwOnClose: new Error('close failed'),
      },
      capture,
    );
    await adapter.init();

    const error = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer this',
      providerContext: createResolvedProviderContext('test-provider', 'test-config'),
    }).catch((cause: unknown) => cause);

    const aggregate = (error as { cause?: unknown }).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'start failed' }),
      expect.objectContaining({ message: 'close failed' }),
    ]);
    expect(capture.connectors[0]?.closeCalls).toBe(1);
  });

  it('uses unresolved providerContext when none is provided in infer payload', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: 'unresolved-ok' }, capture);
    await adapter.init();

    // Infer without providerContext remains explicitly configless. This supports
    // health checks and local adapters without authorizing ambient credentials.
    const result = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer this',
    });

    expect(result.text).toBe('unresolved-ok');
    expect(capture.configFactoryInputs).toHaveLength(1);
    expect(capture.configFactoryInputs[0]!.providerContext).toEqual({ state: 'unresolved' });
  });

  it('uses unresolved providerContext when none is provided in startAgent payload', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
    });

    // Provider-less adapters remain usable with explicitly unresolved context.
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.agentId).toBeDefined();
    }
  });

  it('keeps the live agent when optional startAgent persistence fails', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();
    const offSet = MakaioBus.on(AgentStorageSubjects.set, () => {
      throw new Error('injected persistence failure');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(result.message);
      }
      const listed = await MakaioBus.request(AdapterSubjects.listAgents, { adapterId: adapter.adapterId });
      expect(listed.agents).toHaveLength(1);
      expect(adapter.getActiveAgents()).toHaveLength(1);
      expect(capture.connectors[0]?.closeCalls).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        '[AIAdapter:test-adapter-infer] Optional agent persistence failed:',
        expect.objectContaining({ agentId: result.agentId, adapterId: adapter.adapterId, error: expect.any(Error) }),
      );
    } finally {
      errorSpy.mockRestore();
      offSet();
    }
  });

  it('create-mode startAgent confirms a caller-provided sessionId through the session service', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    const requestedSessionIds: Array<string | undefined> = [];
    const offSessionCreate = MakaioBus.on(SessionSubjects.create, (ctx) => {
      requestedSessionIds.push(ctx.payload.sessionId);
      ctx.setResult({ sessionId: ctx.payload.sessionId ?? 'created-session' });
    });

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        sessionId: 'provided-session',
        initialMessage: 'hello',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(result.message);
      }
      expect(result.sessionId).toBe('provided-session');
      expect(requestedSessionIds).toEqual(['provided-session']);
      expect(capture.agentConfigs[0]?.sessionId).toBe('provided-session');
    } finally {
      offSessionCreate();
    }
  });

  it('closes an unregistered agent when startAgent fails before registry commit', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '', throwOnStart: new Error('start failed') }, capture);
    await adapter.init();

    await expect(
      MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
      }),
    ).rejects.toThrow('start failed');

    expect(capture.connectors[0]?.closeCalls).toBe(1);
    expect(adapter.getActiveAgents()).toEqual([]);

    const listed = await MakaioBus.request(AdapterSubjects.listAgents, { adapterId: adapter.adapterId });
    expect(listed.agents).toEqual([]);
  });

  it('releases the connector auth lease when startAgent fails before registry commit', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    const release = vi.fn(async () => undefined);
    adapter = createTestAdapter({ inferredText: '', throwOnStart: new Error('start failed') }, capture, {
      prepareAuthRuntime: async (config) => {
        const { boundProviderAuth: _boundProviderAuth, ...runtimeConfig } = config;
        return {
          config: { ...runtimeConfig, contextEnv: Object.freeze({}) },
          lease: { clientId: 'claude-code', leaseId: 'lease-startup-failure', release },
        };
      },
    });
    await adapter.init();

    await expect(
      MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
      }),
    ).rejects.toThrow('start failed');

    expect(release).toHaveBeenCalledOnce();
    expect(capture.connectors[0]?.closeCalls).toBe(1);
    expect(adapter.getActiveAgents()).toEqual([]);
  });

  it('uses live platform defaults from subclass initialization for agent config and persistence', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createInitDefaultsAdapter({ inferredText: '' }, capture);
    await adapter.init();
    let persistedCwd: string | undefined;
    const offSet = MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
      persistedCwd = ctx.payload.agent.cwd;
      ctx.setResult({ success: true });
    });

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
      });

      expect(result.success).toBe(true);
      expect(capture.agentConfigs[0]?.cwd).toBe(os.tmpdir());
      expect(capture.configFactoryInputs[0]?.cwd).toBe(os.tmpdir());
      expect(persistedCwd).toBe(os.tmpdir());
    } finally {
      offSet();
    }
  });

  it('merges per-call env over platform default env for agent startup', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createInitDefaultsAdapter({ inferredText: '' }, capture);
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
      env: { EXTRA: '2' },
    });

    expect(result.success).toBe(true);
    expect(capture.agentConfigs[0]?.env).toEqual({ TEST_DEFAULT: '1', EXTRA: '2' });
    expect(capture.configFactoryInputs[0]?.env).toEqual({ TEST_DEFAULT: '1', EXTRA: '2' });
  });

  it('forwards allowedDirectories from startAgent payload into connector config input and persistence', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    const allowedDirectories = ['/workspace'];
    let persistedAllowedDirectories: string[] | undefined;
    const offSet = MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
      persistedAllowedDirectories = ctx.payload.agent.allowedDirectories;
      ctx.setResult({ success: true });
    });

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
        allowedDirectories,
      });

      expect(result.success).toBe(true);
      expect(capture.agentConfigs[0]?.allowedDirectories).toEqual(allowedDirectories);
      expect(capture.configFactoryInputs[0]?.allowedDirectories).toEqual(allowedDirectories);
      expect(persistedAllowedDirectories).toEqual(allowedDirectories);
    } finally {
      offSet();
    }
  });

  it('forwards reasoningEffort from startAgent payload into agent config', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
      reasoningEffort: 'low',
    });

    expect(result.success).toBe(true);
    expect(capture.agentConfigs[0]?.reasoningEffort).toBe('low');
  });

  it('forwards responseSchema from startAgent payload into the initial connector turn', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    const responseSchema: ResponseSchemaDescriptor = {
      schema: { type: 'object', properties: { approved: { type: 'boolean' } } },
      name: 'approved_schema',
    };
    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
      responseSchema,
    });

    expect(result.success).toBe(true);
    expect(capture.connectors[0]?.capturedStartResponseSchema).toEqual(responseSchema);
  });

  it('ephemeral agent: skips session creation, skips persistence, and is evicted after response', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    let sessionCreateCalls = 0;
    let agentStorageSetCalls = 0;
    let agentSessionClosedCalls = 0;
    let agentAddedCalls = 0;
    let preUserMessageHookCalls = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offSessionCreate = MakaioBus.on(SessionSubjects.create, () => {
      sessionCreateCalls += 1;
    });
    const offAgentStorageSet = MakaioBus.on(AgentStorageSubjects.set, () => {
      agentStorageSetCalls += 1;
    });
    const offAgentSessionClosed = MakaioBus.on(AgentSubjects.session.closed, () => {
      agentSessionClosedCalls += 1;
    });
    const offAgentAdded = MakaioBus.on(SessionSubjects.agent.added, () => {
      agentAddedCalls += 1;
    });
    const offPreUserMessageHook = registerPreUserMessageHook(
      'ephemeral-test-counter',
      () => {
        preUserMessageHookCalls += 1;
      },
      {},
    );

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        sessionId: 'ephemeral-session-id',
        initialMessage: 'hello',
        ephemeral: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(result.message);
      }
      expect(result.agentId).toBeDefined();
      expect(result.adapterId).toBe(adapter.adapterId);
      expect(result.sessionId).toBe('ephemeral-session-id');
      expect(result.adapterSessionId).toBeDefined();

      // Session service must not have been called — ephemeral mode preserves
      // caller sessionId without creating or persisting a session.
      expect(sessionCreateCalls).toBe(0);
      // Agent storage must not have been called — ephemeral agents are never persisted.
      expect(agentStorageSetCalls).toBe(0);
      // agent.session.closed must not fire — ephemeral cleanup is local only.
      expect(agentSessionClosedCalls).toBe(0);
      // session.agent.added must not fire — ephemeral agents are never persisted.
      expect(agentAddedCalls).toBe(0);
      // PreUserMessage hooks must be skipped for ephemeral agents.
      expect(preUserMessageHookCalls).toBe(0);

      // Flush the microtask queue so the void evictSilently() chain settles.
      await new Promise((resolve) => setImmediate(resolve));

      // Agent must have been evicted from the registry after the response.
      expect(adapter.getActiveAgents()).toHaveLength(0);
      expect(capture.connectors[0]?.closeCalls).toBe(1);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(`Agent ${result.agentId} not found`));
    } finally {
      warnSpy.mockRestore();
      offSessionCreate();
      offAgentStorageSet();
      offAgentSessionClosed();
      offAgentAdded();
      offPreUserMessageHook();
      resetPreUserMessageHooks();
    }
  });

  it('ephemeral agent: rejects create requests without an initial message', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    await expect(
      MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        ephemeral: true,
      }),
    ).rejects.toThrow('ephemeral startAgent requires initialMessage');
    expect(capture.connectors).toHaveLength(0);
    expect(adapter.getActiveAgents()).toHaveLength(0);
  });

  it('ephemeral agent: waits for initial turn completion before cleanup', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '', completeOnStart: false }, capture);
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
      ephemeral: true,
    });

    expect(result.success).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(capture.connectors[0]?.closeCalls).toBe(0);
    expect(adapter.getActiveAgents()).toHaveLength(1);

    const handle = capture.connectors[0]?.startedHandles[0];
    expect(handle).toBeDefined();
    handle?.markCompleted({ outcome: 'completed', result: { message: 'done' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(capture.connectors[0]?.closeCalls).toBe(1);
    expect(adapter.getActiveAgents()).toHaveLength(0);
  });

  it('ephemeral agent: evicts when the initial turn never completes', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '', completeOnStart: false }, capture);
    await adapter.init();

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
        ephemeral: true,
      });

      expect(result.success).toBe(true);
      await Promise.resolve();
      expect(adapter.getActiveAgents()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(EPHEMERAL_CLEANUP_COMPLETION_TIMEOUT_MS);

      expect(capture.connectors[0]?.closeCalls).toBe(1);
      expect(adapter.getActiveAgents()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        '[AIAdapter:test-adapter-infer] Ephemeral agent cleanup failed:',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('ephemeral agent: suppresses session-closed lifecycle events when startup fails', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '', throwOnStart: new Error('start failed') }, capture);
    await adapter.init();

    let agentSessionClosedCalls = 0;
    const offAgentSessionClosed = MakaioBus.on(AgentSubjects.session.closed, () => {
      agentSessionClosedCalls += 1;
    });

    try {
      await expect(
        MakaioBus.request(AdapterSubjects.startAgent, {
          adapterId: adapter.adapterId,
          role: 'lead',
          mode: 'create',
          initialMessage: 'hello',
          ephemeral: true,
        }),
      ).rejects.toThrow('start failed');

      expect(agentSessionClosedCalls).toBe(0);
      expect(capture.connectors[0]?.closeCalls).toBe(1);
      expect(adapter.getActiveAgents()).toHaveLength(0);
    } finally {
      offAgentSessionClosed();
    }
  });

  it('persists harnessId from startAgent onto the agent record', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    let persistedHarnessId: string | undefined;
    const offSet = MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
      persistedHarnessId = ctx.payload.agent.harnessId;
      ctx.setResult({ success: true });
    });

    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        mode: 'create',
        role: 'lead',
        initialMessage: 'review this change',
        harnessId: 'harness-reviewer',
      });

      expect(result.success).toBe(true);
      expect(persistedHarnessId).toBe('harness-reviewer');
    } finally {
      offSet();
    }
  });

  it('forwards harnessId from startAgent into the config factory input', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '' }, capture);
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      mode: 'create',
      role: 'lead',
      initialMessage: 'implement this feature',
      harnessId: 'harness-implementation',
    });

    expect(result.success).toBe(true);
    expect(capture.configFactoryInputs[0]).toMatchObject({
      agentId: expect.any(String),
      harnessId: 'harness-implementation',
    });
  });

  it('ephemeral agent: treats silent eviction close failures as best-effort cleanup', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: '', throwOnClose: new Error('close failed') }, capture);
    await adapter.init();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
        ephemeral: true,
      });

      expect(result.success).toBe(true);

      await vi.waitFor(() => {
        expect(capture.connectors[0]?.closeCalls).toBe(1);
        expect(adapter.getActiveAgents()).toHaveLength(0);
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ActiveAgentRegistry:test-adapter-infer] Agent'),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('AIAdapter model metadata resolution', () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await adapter?.closeAsync();
  });

  it('carries resolved provider metadata into agent config and initial factory input', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    const adapterProviderAuth = createTestProviderAuth('provider-a');
    const definitionProviders: AdapterProviderDefinition[] = [
      {
        definition: {
          id: 'provider-a',
          name: 'Provider A',
          availableModels: [{ name: 'model-a', contextWindowSize: 123_456, labId: 'provider-a' }],
          authMethods: [TEST_API_KEY_METHOD],
        },
        auth: adapterProviderAuth,
      },
    ];
    adapter = createTestAdapter({ inferredText: 'unused' }, capture, { definitionProviders });
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
      model: 'model-a',
      providerContext: createResolvedProviderContext('provider-a', 'test-config'),
    });

    expect(result.success).toBe(true);
    expect(capture.agentConfigs[0]?.availableModels).toEqual(definitionProviders[0]?.definition.availableModels);
    expect(capture.agentConfigs[0]?.definitionProviders).toBe(definitionProviders);
    expect(capture.configFactoryInputs[0]?.adapterProviderAuth).toEqual(adapterProviderAuth);
  });

  it('does not fall back to single-provider auth for unresolved or mismatched initial contexts', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    const adapterProviderAuth = createTestProviderAuth('provider-a');
    adapter = createTestAdapter({ inferredText: 'unused' }, capture, {
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
    });
    await adapter.init();

    const unresolvedResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello unresolved provider',
    });
    const mismatchedResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello mismatched provider',
      providerContext: createResolvedProviderContext('provider-b'),
    });

    expect(unresolvedResult.success).toBe(true);
    expect(mismatchedResult.success).toBe(true);
    expect(capture.configFactoryInputs).toHaveLength(2);
    expect(capture.configFactoryInputs[0]?.adapterProviderAuth).toBeUndefined();
    expect(capture.configFactoryInputs[1]?.adapterProviderAuth).toBeUndefined();
  });

  it('uses single-provider models when the caller omitted provider selection', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    const definitionProviders: AdapterProviderDefinition[] = [
      {
        definition: {
          id: 'provider-a',
          name: 'Provider A',
          availableModels: [{ name: 'model-a', contextWindowSize: 123_456, labId: 'provider-a' }],
          authMethods: [],
        },
      },
    ];
    adapter = createTestAdapter({ inferredText: 'unused' }, capture, { definitionProviders });
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
      model: 'model-a',
    });

    expect(result.success).toBe(true);
    expect(capture.agentConfigs[0]?.availableModels).toEqual(definitionProviders[0]?.definition.availableModels);
  });

  it('does not pass ambiguous multi-provider models into agent config', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    const definitionProviders: AdapterProviderDefinition[] = [
      {
        definition: {
          id: 'provider-a',
          name: 'Provider A',
          availableModels: [{ name: 'shared-model', contextWindowSize: 100_000, labId: 'provider-a' }],
          authMethods: [],
        },
      },
      {
        definition: {
          id: 'provider-b',
          name: 'Provider B',
          availableModels: [{ name: 'shared-model', contextWindowSize: 200_000, labId: 'provider-b' }],
          authMethods: [],
        },
      },
    ];
    adapter = createTestAdapter({ inferredText: 'unused' }, capture, { definitionProviders });
    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
      initialMessage: 'hello',
      model: 'shared-model',
    });

    expect(result.success).toBe(true);
    expect(capture.agentConfigs[0]?.availableModels).toBeUndefined();
  });
});
