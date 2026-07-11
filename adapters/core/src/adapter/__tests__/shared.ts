/**
 * Shared test helpers for AIAdapter tests.
 *
 * Provides a base MockConnector, TestAgent, TestAdapter, and factory
 * function reused across ai-adapter-*.test.ts files.
 */
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import { AIAdapter } from '../ai-adapter.js';
import { createAdapterNamespace } from '../../factory/create-adapter-namespace.js';
import { AIAgent } from '../../agent/ai-agent.js';
import { AIAgentConnector } from '../../connector/agent-connector.js';
import { MessageHandle } from '../../message-handle/index.js';
import type { AIAgentConfig, AgentStartResult, BaseAgentConnectorConfig } from '../../agent/types.js';
import type { ConfigFactoryInput } from '../ai-adapter-config.js';
import type { AIAdapterConfig } from '../types.js';
import type { NormalizedMessageInput } from '../../utils/normalizeMessageInput.js';

export type TestBus = ReturnType<typeof createMockScopedBus>['bus'];

/**
 * Minimal mock connector for adapter tests.
 *
 * Subclass or extend via constructor options for test-specific behavior
 * (e.g., tracking close calls, throwing on specific models).
 */
export class MockConnector extends AIAgentConnector {
  public closeCalled = false;

  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) {
    super(config);
  }

  public async initialize(): Promise<void> {}

  public async start(message: NormalizedMessageInput): Promise<AgentStartResult> {
    return {
      adapterSessionId: 'mock-adapter-session-id',
      agentId: this.getAgentId(),
      messageHandle: new MessageHandle('mock-message-id', message, 'enqueue'),
    };
  }

  public async sendMessage(message: NormalizedMessageInput): Promise<MessageHandle> {
    return new MessageHandle('mock-message-id', message, 'enqueue');
  }

  public abort(): void {}
  public async complete(): Promise<null> {
    return null;
  }
  public async interrupt(): Promise<void> {}
  public async close(): Promise<void> {
    this.closeCalled = true;
  }
  public async getAdapterSessionId(): Promise<string> {
    return 'mock-adapter-session-id';
  }
}

/** Test agent that does nothing in wireEvents. */
export class TestAgent extends AIAgent<TestBus, MockConnector> {
  protected async wireEvents(_connector: MockConnector): Promise<void> {}
}

/** Extension type for test adapter configuration factories. */
export type AdapterConfigExtensions = {
  agentFactory: (config: AIAgentConfig<TestBus, MockConnector>) => TestAgent;
  configFactory: (
    input: ConfigFactoryInput<TestBus>,
  ) => Promise<BaseAgentConnectorConfig<TestBus> & { adapterId: string }>;
  connectorFactory: (
    config: BaseAgentConnectorConfig<TestBus> & { adapterId: string },
  ) => MockConnector | Promise<MockConnector>;
};

/** Test adapter with typed config extensions. */
export class TestAdapter extends AIAdapter<TestBus, MockConnector, TestAgent> {
  public constructor(config: AIAdapterConfig<TestBus> & AdapterConfigExtensions) {
    super(config);
  }
}

/**
 * Create a test adapter with standard wiring.
 * @param adapterName - Adapter name for namespace/config
 * @param options - Optional overrides for connector/config factories
 * @returns Test adapter and scoped bus
 */
export function createTestAdapter(
  adapterName: string,
  options?: {
    configFactory?: AdapterConfigExtensions['configFactory'];
    connectorFactory?: AdapterConfigExtensions['connectorFactory'];
    prepareAuthRuntime?: AIAdapterConfig<TestBus>['prepareAuthRuntime'];
  },
): { adapter: TestAdapter; scopedBus: TestBus } {
  const { bus: scopedBus } = createMockScopedBus();
  const namespace = createAdapterNamespace(adapterName, {});

  const adapter = new TestAdapter({
    name: adapterName,
    capabilities: [],
    nativeTools: [],
    namespace,
    scopedBus,
    globalBus: MakaioBus,
    agentFactory: (config: AIAgentConfig<TestBus, MockConnector>) => new TestAgent(config),
    configFactory:
      options?.configFactory ??
      (async (input: ConfigFactoryInput<TestBus>) => ({
        bus: scopedBus,
        agentId: input.agentId ?? 'test-agent',
        adapterId: input.adapterId ?? 'test-adapter-id',
        adapterName,
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
        ...(input.mcpSessionContext !== undefined && { mcpSessionContext: input.mcpSessionContext }),
        ...(input.toolLedger !== undefined && { toolLedger: input.toolLedger }),
      })),
    connectorFactory:
      options?.connectorFactory ??
      (async (config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) => new MockConnector(config)),
    ...(options?.prepareAuthRuntime !== undefined && { prepareAuthRuntime: options.prepareAuthRuntime }),
  });

  return { adapter, scopedBus };
}

// Re-export commonly needed types for tests
export type { AIAgentConfig, AgentStartResult, BaseAgentConnectorConfig } from '../../agent/types.js';
export type { ConfigFactoryInput } from '../ai-adapter-config.js';
export type { AIAdapterConfig } from '../types.js';
export type { NormalizedMessageInput } from '../../utils/normalizeMessageInput.js';
export { MessageHandle } from '../../message-handle/index.js';
export { AIAgentConnector } from '../../connector/agent-connector.js';
export { AIAgent } from '../../agent/ai-agent.js';
export { createMockScopedBus } from '@makaio/test-utils';
export { createAdapterNamespace } from '../../factory/create-adapter-namespace.js';
