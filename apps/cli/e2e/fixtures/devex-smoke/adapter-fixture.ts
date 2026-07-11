import os from 'node:os';
import { MakaioBus, type ScopedBus } from '@makaio/bus-core';
import {
  AIAdapter,
  AIAgent,
  AIAgentConnector,
  createAdapterNamespace,
  type AIAgentConfig,
  type AgentStartResult,
  type BaseAgentConnectorConfig,
  type ConfigFactoryInput,
  type ConnectorSendMessageOptions,
  type ConnectorStartOptions,
  type MessageHandle,
  type NormalizedMessageInput,
  type AIAdapterDefinition,
  type AIAdapterInitOptions,
  type AIAdapterConfig,
  type AdapterProviderDefinition,
} from '@makaio/ai-adapters-core';
import type { AdapterProviderRef } from '@makaio/contracts';
import { DEFAULT_TIMEOUTS } from '@makaio/utils';
import { providerDefinition } from './provider-fixture.js';
import { DEVEX_SMOKE_ADAPTER_NAME } from './shared.js';

const DevexSmokeNamespace = createAdapterNamespace(`adapter:${DEVEX_SMOKE_ADAPTER_NAME}`, {});
/** Resolved provider definitions forwarded to adapter init options at runtime. */
const PROVIDER_DEFINITIONS: AdapterProviderDefinition[] = [{ definition: providerDefinition }];
/** Provider refs declared in the adapter definition for boot-time resolution. */
const PROVIDER_REFS: AdapterProviderRef[] = [{ definitionId: providerDefinition.id }];

type DevexSmokeBus = ScopedBus<string>;

/**
 * Extract a stable human-readable text payload from a normalized user message.
 * @param message - Normalized user message sent through the connector.
 * @returns Best-effort text for the synthetic adapter reply.
 */
function toReplyText(message: NormalizedMessageInput): string {
  return message.message ?? 'Hello from the devex smoke fixture';
}

/**
 * Minimal connector used by the CLI SDK smoke adapter.
 *
 * It never performs network I/O; instead it acknowledges and completes each
 * message immediately with a deterministic echo result.
 */
class DevexSmokeConnector extends AIAgentConnector<DevexSmokeBus> {
  public constructor(config: BaseAgentConnectorConfig<DevexSmokeBus> & { adapterId: string }) {
    super(config);
  }

  public async initialize(): Promise<void> {
    this.adapterSessionId ??= `${DEVEX_SMOKE_ADAPTER_NAME}-session`;
  }

  public async start(
    message: NormalizedMessageInput,
    options?: ConnectorStartOptions,
  ): Promise<AgentStartResult> {
    await this.initialize();
    const messageHandle = this.createCompletedHandle(message, options);
    return {
      adapterSessionId: await this.getAdapterSessionId(),
      agentId: this.getAgentId(),
      messageHandle,
    };
  }

  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    await this.initialize();
    return this.createCompletedHandle(message, options);
  }

  public abort(): void {}

  public async interrupt(): Promise<void> {}

  public async close(): Promise<void> {}

  public async getAdapterSessionId(): Promise<string> {
    await this.initialize();
    return this.adapterSessionId!;
  }

  public async complete() {
    return this.lastResult;
  }

  /**
   * Build a message handle that completes in the next microtask.
   * @param message - Normalized message to acknowledge and complete.
   * @param options - Caller-assigned message identity and turn context.
   * @returns Pre-wired message handle.
   */
  private createCompletedHandle(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): MessageHandle {
    const handle = this.createMessageHandle(message, options);

    queueMicrotask(() => {
      handle.markAcknowledged();
      handle.markCompleted({
        outcome: 'completed',
        result: {
          message: `Echo: ${toReplyText(message)}`,
        },
      });
    });

    return handle;
  }
}

/**
 * Minimal agent shell for the smoke connector.
 */
class DevexSmokeAgent extends AIAgent<DevexSmokeBus, DevexSmokeConnector> {
  protected async wireEvents(_connector: DevexSmokeConnector): Promise<void> {}
}

/**
 * Thin adapter wrapper around the echo connector.
 */
class DevexSmokeAdapter extends AIAdapter<DevexSmokeBus, DevexSmokeConnector, DevexSmokeAgent> {
  public constructor(
    config: AIAdapterConfig<DevexSmokeBus> & {
      agentFactory: (config: AIAgentConfig<DevexSmokeBus, DevexSmokeConnector>) => DevexSmokeAgent;
      configFactory: (
        input: ConfigFactoryInput<DevexSmokeBus>,
      ) => Promise<BaseAgentConnectorConfig<DevexSmokeBus> & { adapterId: string }>;
      connectorFactory: (
        config: BaseAgentConnectorConfig<DevexSmokeBus> & { adapterId: string },
      ) => DevexSmokeConnector | Promise<DevexSmokeConnector>;
    },
  ) {
    super(config);
  }
}

/**
 * Create and initialize the smoke-test adapter instance.
 * @param options - Runtime adapter init options.
 * @returns Initialized local-only adapter instance.
 */
export async function createDevexSmokeAdapter(options?: AIAdapterInitOptions): Promise<DevexSmokeAdapter> {
  const scopedBus = (await DevexSmokeNamespace.scopedBus()) as DevexSmokeBus;
  const adapter = new DevexSmokeAdapter({
    adapterId: options?.adapterId,
    name: DEVEX_SMOKE_ADAPTER_NAME,
    capabilities: [],
    nativeTools: [],
    namespace: DevexSmokeNamespace,
    scopedBus,
    globalBus: MakaioBus,
    definitionProviders: PROVIDER_DEFINITIONS,
    agentFactory: (config) => new DevexSmokeAgent(config),
    configFactory: async (input) => ({
      bus: scopedBus,
      agentId: input.agentId ?? 'devex-smoke-agent',
      adapterId: input.adapterId ?? 'devex-smoke-adapter-id',
      adapterName: DEVEX_SMOKE_ADAPTER_NAME,
      model: input.model ?? providerDefinition.defaultModel ?? providerDefinition.availableModels[0]!.name,
      cwd: input.cwd ?? os.tmpdir(),
      providerContext: input.providerContext,
      sessionId: input.sessionId,
      timeouts: {
        values: DEFAULT_TIMEOUTS,
        sources: {
          initialization: { layer: 'adapter', source: DEVEX_SMOKE_ADAPTER_NAME },
          acknowledgement: { layer: 'adapter', source: DEVEX_SMOKE_ADAPTER_NAME },
          completion: { layer: 'adapter', source: DEVEX_SMOKE_ADAPTER_NAME },
          toolApproval: { layer: 'adapter', source: DEVEX_SMOKE_ADAPTER_NAME },
          eventWait: { layer: 'adapter', source: DEVEX_SMOKE_ADAPTER_NAME },
        },
      },
      ...(input.allowedDirectories !== undefined ? { allowedDirectories: input.allowedDirectories } : {}),
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      ...(input.disallowedTools !== undefined ? { disallowedTools: input.disallowedTools } : {}),
      ...(input.mcpSessionContext !== undefined ? { mcpSessionContext: input.mcpSessionContext } : {}),
      ...(input.toolLedger !== undefined ? { toolLedger: input.toolLedger } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.resumeAdapterSessionId !== undefined ? { resumeAdapterSessionId: input.resumeAdapterSessionId } : {}),
    }),
    connectorFactory: async (config) => new DevexSmokeConnector(config),
  });

  await adapter.init();
  return adapter;
}

/**
 * Adapter definition discovered through the boot override seam.
 */
export const adapterDefinition: AIAdapterDefinition<DevexSmokeBus, DevexSmokeConnector, DevexSmokeAgent> = {
  name: DEVEX_SMOKE_ADAPTER_NAME,
  displayName: 'DevEx Smoke Adapter',
  description: 'Local-only adapter used by the CLI SDK smoke test',
  providers: PROVIDER_REFS,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  defaultPresetId: providerDefinition.id,
  createAdapter: async (options) => createDevexSmokeAdapter(options),
};
