import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { registerPreUserMessageHook, resetPreUserMessageHooks } from '@makaio/hooks';
import { createMockScopedBus } from '@makaio/test-utils';
import { AIAdapter } from '../ai-adapter.js';
import { EPHEMERAL_CLEANUP_COMPLETION_TIMEOUT_MS } from '../ai-adapter-start-handler.js';
import { createAdapterNamespace } from '../../factory/create-adapter-namespace.js';
import { AIAgent } from '../../agent/ai-agent.js';
import { AIAgentConnector } from '../../connector/agent-connector.js';
import { MessageHandle } from '../../message-handle/index.js';
import type { AIAgentConfig, AgentStartResult, BaseAgentConnectorConfig } from '../../agent/types.js';
import type { ConfigFactoryInput } from '../ai-adapter-config.js';
import type { AIAdapterConfig } from '../types.js';
import type { NormalizedMessageInput } from '../../utils/normalizeMessageInput.js';
import type { AdapterProviderDefinition } from '../../types/provider-definition.js';

type TestBus = ReturnType<typeof createMockScopedBus>['bus'];

interface ConnectorBehavior {
  inferredText: string;
  throwOnStart?: Error;
  throwOnClose?: Error;
  completeOnStart?: boolean;
}

class ConfigurableConnector extends AIAgentConnector {
  public closeCalls = 0;
  public initializeCalls = 0;
  private readonly behavior: ConnectorBehavior;
  public capturedStartMessage?: NormalizedMessageInput;
  public capturedStartSystemPrompt?: string;
  public capturedInitializeSystemPrompt?: string;
  public readonly startedHandles: MessageHandle[] = [];

  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }, behavior: ConnectorBehavior) {
    super(config);
    this.behavior = behavior;
  }

  public async initialize(options?: { systemPrompt?: string }): Promise<void> {
    this.initializeCalls += 1;
    this.capturedInitializeSystemPrompt = options?.systemPrompt;
  }

  public async start(message: NormalizedMessageInput, options?: { systemPrompt?: string }): Promise<AgentStartResult> {
    this.capturedStartMessage = message;
    this.capturedStartSystemPrompt = options?.systemPrompt;

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

  public async sendMessage(_message: NormalizedMessageInput): Promise<MessageHandle> {
    throw new Error('sendMessage should not be called in infer tests');
  }

  public abort(): void {}
  public async complete(): Promise<null> {
    return null;
  }
  public async interrupt(): Promise<void> {}
  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.behavior.throwOnClose) {
      throw this.behavior.throwOnClose;
    }
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
  options?: { definitionProviders?: AdapterProviderDefinition[] },
): T {
  const { bus: scopedBus } = createMockScopedBus();
  const namespace = createAdapterNamespace(name, {});

  return new Ctor({
    name,
    capabilities: [],
    nativeTools: [],
    namespace,
    scopedBus,
    globalBus: MakaioBus,
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
      const connector = new ConfigurableConnector(config, behavior);
      capture.connectors.push(connector);
      return connector;
    },
    definitionProviders: options?.definitionProviders,
  });
}

function createTestAdapter(
  behavior: ConnectorBehavior,
  capture: AdapterCapture,
  options?: { definitionProviders?: AdapterProviderDefinition[] },
): TestAdapter {
  return buildAdapter(TestAdapter, 'test-adapter-infer', behavior, capture, options);
}

function createInitDefaultsAdapter(behavior: ConnectorBehavior, capture: AdapterCapture): InitDefaultsAdapter {
  return buildAdapter(InitDefaultsAdapter, 'test-adapter-init-defaults', behavior, capture);
}

describe('AIAdapter.handleInfer', () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await adapter?.closeAsync();
  });

  it('returns inferred text and forwards model/systemPrompt/providerContext', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: 'inferred output' }, capture);
    await adapter.init();

    const providerContext = {
      providerConfigId: 'test-config',
      definitionId: 'test-provider',
      credentialRefs: {},
    };
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
    expect(capture.connectors).toHaveLength(1);
    expect(capture.connectors[0]?.initializeCalls).toBe(1);
    expect(capture.connectors[0]?.capturedInitializeSystemPrompt).toBe('classification-system-prompt');
    expect(capture.connectors[0]?.capturedStartMessage?.message).toBe('infer this');
    expect(capture.connectors[0]?.capturedStartSystemPrompt).toBe('classification-system-prompt');
    expect(capture.connectors[0]?.closeCalls).toBe(1);
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        MakaioBus.request(AdapterSubjects.infer, {
          adapterId: adapter.adapterId,
          prompt: 'infer this',
          providerContext: { providerConfigId: 'test-config', definitionId: 'test-provider', credentialRefs: {} },
        }),
      ).rejects.toThrow('start failed');
      expect(capture.connectors[0]?.closeCalls).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[handleInfer:test-adapter-infer] Connector cleanup error:',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses sentinel providerContext when none is provided in infer payload', async () => {
    const capture = {
      configFactoryInputs: [] as ConfigFactoryInput<TestBus>[],
      connectors: [] as ConfigurableConnector[],
      agentConfigs: [] as Array<AIAgentConfig<TestBus, ConfigurableConnector>>,
    };
    adapter = createTestAdapter({ inferredText: 'sentinel-ok' }, capture);
    await adapter.init();

    // Infer without providerContext — should succeed with sentinel fallback
    // (supports health checks and local adapters that bypass orchestration).
    const result = await MakaioBus.request(AdapterSubjects.infer, {
      adapterId: adapter.adapterId,
      prompt: 'infer this',
    });

    expect(result.text).toBe('sentinel-ok');
    expect(capture.configFactoryInputs).toHaveLength(1);
    expect(capture.configFactoryInputs[0]!.providerContext).toEqual({
      providerConfigId: 'sentinel',
      definitionId: 'unresolved', // UNRESOLVED_PROVIDER_DEFINITION_ID sentinel
      credentialRefs: {},
    });
  });

  it('uses sentinel providerContext when none is provided in startAgent payload', async () => {
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

    // Should succeed with sentinel providerContext for provider-less adapters.
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
      await new Promise((resolve) => setImmediate(resolve));

      expect(capture.connectors[0]?.closeCalls).toBe(1);
      expect(adapter.getActiveAgents()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AgentRegistry:test-adapter-infer] Agent'),
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

  it('passes single-provider models into agent config', async () => {
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
      providerContext: { providerConfigId: 'test-config', definitionId: 'provider-a', credentialRefs: {} },
    });

    expect(result.success).toBe(true);
    expect(capture.agentConfigs[0]?.availableModels).toEqual(definitionProviders[0]?.definition.availableModels);
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
        },
      },
      {
        definition: {
          id: 'provider-b',
          name: 'Provider B',
          availableModels: [{ name: 'shared-model', contextWindowSize: 200_000, labId: 'provider-b' }],
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
