import {
  AIAdapter,
  AIAgent,
  AIAgentConnector,
  MessageHandle,
  createAdapterNamespace,
  type AIAdapterConfig,
  type AIAgentConfig,
  type AgentStartResult,
  type AIAdapterDefinition,
  type AIAdapterInitOptions,
  type BaseAgentConnectorConfig,
  type ConfigFactoryInput,
  type ConnectorSendMessageOptions,
  type NormalizedMessageInput,
} from '@makaio/ai-adapters-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ConnectorTeardownResult } from '@makaio/contracts';
import {
  AgentSubjects,
  ToolSubjects,
  defineAdapterProviderAuth,
  type AdapterContribution,
  type ProviderContext,
} from '@makaio/contracts';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { createMockScopedBus } from '@makaio/test-utils';

type FixtureBus = ReturnType<typeof createMockScopedBus>['bus'];

export interface DeterministicAdapterCapture {
  readonly starts: Array<{
    cwd: string;
    allowedTools?: readonly string[];
    allowedDirectories?: readonly string[];
  }>;
  readResult?: unknown;
  initialized?: boolean;
  adapterId?: string;
  adapterInitCount?: number;
  extensionDestroyed?: boolean;
  connectorClosed?: boolean;
  providerContext?: ProviderContext;
  readonly completionTasks: Promise<void>[];
}

class DeterministicConnector extends AIAgentConnector<FixtureBus> {
  public onUsage?: (usage: {
    granularity: 'provider-call';
    provider: string;
    inputTokens: number;
    inputCachedTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    costUnits: number;
    costUnitType: 'tokens';
  }) => Promise<void>;
  public constructor(
    config: BaseAgentConnectorConfig<FixtureBus> & { adapterId: string },
    private readonly runtimeBus: IMakaioBus,
    private readonly capture: DeterministicAdapterCapture,
  ) {
    super(config);
  }

  public async initialize(): Promise<void> {}

  public async start(message: NormalizedMessageInput): Promise<AgentStartResult> {
    this.capture.starts.push({
      cwd: this.config.cwd,
      allowedTools: this.config.allowedTools,
      allowedDirectories: this.config.allowedDirectories,
    });
    this.capture.readResult = await this.runtimeBus.request(ToolSubjects.execute, {
      toolName: 'read_file',
      input: { path: 'input.txt' },
      adapterId: this.config.adapterId,
      adapterName: this.config.adapterName,
      contextOverrides: {
        cwd: this.config.cwd,
        constraints: { allowedDirectories: this.config.allowedDirectories ?? [] },
      },
    });
    await this.onUsage?.({
      granularity: 'provider-call',
      provider: 'deterministic',
      inputTokens: 1,
      inputCachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
      costUnits: 2,
      costUnitType: 'tokens',
    });
    const handle = new MessageHandle('deterministic-message', message, 'enqueue');
    handle.markCompleted({ outcome: 'completed', result: { message: 'authority governed read' } });
    this.capture.completionTasks.push(
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          void this.runtimeBus
            .emit(AgentSubjects.complete, {
              agentId: this.getAgentId(),
              adapterId: this.config.adapterId,
              adapterName: this.config.adapterName,
              adapterSessionId: 'deterministic-session',
              messageId: 'deterministic-message',
              message: 'authority governed read',
            })
            .then(resolve, reject);
        }, 0);
      }),
    );
    return { adapterSessionId: 'deterministic-session', agentId: this.getAgentId(), messageHandle: handle };
  }

  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    const handle = new MessageHandle(options?.messageId ?? 'deterministic-followup', message, 'enqueue');
    handle.markCompleted({ outcome: 'completed', result: { message: 'authority governed read' } });
    return handle;
  }

  public abort(): void {}
  public async complete(): Promise<null> {
    return null;
  }
  public async interrupt(): Promise<void> {}
  /**
   * Report a teardown of nothing.
   *
   * This double holds no process, connection or subscription, so `released` is
   * literally true of it: every handle is dropped and no callback can arrive.
   * @returns The `released` class.
   */
  public async close(): Promise<ConnectorTeardownResult> {
    this.capture.connectorClosed = true;
    return { evidence: 'released' };
  }
  public async getAdapterSessionId(): Promise<string> {
    return 'deterministic-session';
  }
}

class DeterministicAgent extends AIAgent<FixtureBus, DeterministicConnector> {
  protected async wireEvents(connector: DeterministicConnector): Promise<void> {
    connector.onUsage = (usage) => this.trackUsage(usage);
  }
}

class DeterministicAdapter extends AIAdapter<FixtureBus, DeterministicConnector, DeterministicAgent> {
  public constructor(
    config: AIAdapterConfig<FixtureBus> & {
      agentFactory: (config: AIAgentConfig<FixtureBus, DeterministicConnector>) => DeterministicAgent;
      configFactory: (
        input: ConfigFactoryInput<FixtureBus>,
      ) => Promise<BaseAgentConnectorConfig<FixtureBus> & { adapterId: string }>;
      connectorFactory: (
        config: BaseAgentConnectorConfig<FixtureBus> & { adapterId: string },
      ) => DeterministicConnector;
    },
  ) {
    super(config);
  }
}

export function createDeterministicAdapterContribution(capture: DeterministicAdapterCapture): KernelMakaioExtension {
  let runtimeBus: IMakaioBus | undefined;
  const providerAuth = defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId: 'deterministic-provider', methodId: 'none' },
        deliveries: [{ kind: 'none' }],
      },
    ],
    scrubEnvVars: [],
  });
  const definition: AIAdapterDefinition<FixtureBus, DeterministicConnector, DeterministicAgent> = {
    name: 'workflow-test-adapter',
    providers: [{ definitionId: 'deterministic-provider', auth: providerAuth }],
    defaultTimeouts: {
      initialization: 1_000,
      acknowledgement: 1_000,
      completion: 1_000,
      toolApproval: 1_000,
      eventWait: 1_000,
    },
    createAdapter: async (options?: AIAdapterInitOptions) => {
      if (runtimeBus === undefined) throw new Error('Deterministic adapter extension has not received its runtime bus');
      const initializedRuntimeBus = runtimeBus;
      capture.adapterInitCount = (capture.adapterInitCount ?? 0) + 1;
      const { bus: scopedBus } = createMockScopedBus();
      const adapter = new DeterministicAdapter({
        name: 'workflow-test-adapter',
        capabilities: ['tools'],
        nativeTools: [],
        adapterId: options?.adapterId,
        clientId: options?.clientId,
        namespace: createAdapterNamespace('workflow-test-adapter', {}),
        scopedBus,
        globalBus: runtimeBus,
        agentFactory: (config) => new DeterministicAgent(config),
        configFactory: async (input) => {
          if (input.cwd === undefined) throw new Error('Deterministic adapter requires a working directory');
          capture.providerContext = input.providerContext;
          return {
            bus: scopedBus,
            agentId: input.agentId ?? 'deterministic-agent',
            adapterId: input.adapterId ?? 'deterministic-adapter',
            adapterName: 'workflow-test-adapter',
            model: input.model ?? 'deterministic-model',
            cwd: input.cwd,
            providerContext: input.providerContext,
            allowedTools: input.allowedTools,
            allowedDirectories: input.allowedDirectories,
          };
        },
        connectorFactory: (config) => new DeterministicConnector(config, initializedRuntimeBus, capture),
      });
      await adapter.init();
      capture.adapterId = adapter.adapterId;
      return adapter;
    },
  } satisfies AdapterContribution['definition'];
  return {
    name: 'deterministic-workflow-adapter',
    displayName: 'Deterministic Workflow Adapter',
    version: '1.0.0',
    providers: [
      {
        id: 'deterministic-provider',
        name: 'Deterministic Provider',
        authMethods: [{ id: 'none', mode: 'none', label: 'No authentication' }],
      },
    ],
    adapters: [
      {
        manifest: {
          name: 'workflow-test-adapter',
          protocols: ['openai'],
          clients: [{ id: 'deterministic-client', version: '*' }],
        },
        definition,
      },
    ],
    create: async (context) => {
      runtimeBus = context.bus;
      capture.initialized = true;
      return {
        destroy: () => {
          capture.extensionDestroyed = true;
        },
      };
    },
  };
}
