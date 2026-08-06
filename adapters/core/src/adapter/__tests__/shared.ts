/**
 * Shared test helpers for AIAdapter tests.
 *
 * Provides a base MockConnector, TestAgent, TestAdapter, and factory
 * function reused across ai-adapter-*.test.ts files.
 */
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type ConnectorTeardownResult } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
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
import {
  runConfiguredClose,
  runConfiguredInitialize,
  type ConfiguredClose,
  type ConfiguredInitialize,
} from '../../agent/__tests__/helpers/configured-close.js';

export type TestBus = ReturnType<typeof createMockScopedBus>['bus'];

/**
 * Minimal mock connector for adapter tests.
 *
 * Subclass or extend via constructor options for test-specific behavior
 * (e.g., tracking close calls, throwing on specific models).
 */
export class MockConnector extends AIAgentConnector implements ConfiguredClose, ConfiguredInitialize {
  /** How many times this generation's close ran; see {@link ConfiguredClose}. */
  public closeCount = 0;
  /** Class this close reports, or the failure it raises; see {@link ConfiguredClose}. */
  public closeOutcome: ConnectorTeardownResult | Error = { evidence: 'released' };
  /** Held until the test releases it; see {@link ConfiguredClose}. */
  public closeGate: Promise<void> | undefined;
  /** Held until the test releases it; see {@link ConfiguredInitialize}. */
  public initializeGate: Promise<void> | undefined;
  /** Raised by `initialize()`; see {@link ConfiguredInitialize}. */
  public initializeFailure: Error | undefined;

  /**
   * Whether this generation's close ran at all.
   *
   * Derived from the count rather than tracked beside it, so the two can never
   * disagree about whether a close happened.
   * @returns Whether close ran at least once.
   */
  public get closeCalled(): boolean {
    return this.closeCount > 0;
  }

  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) {
    super(config);
  }

  public async initialize(): Promise<void> {
    return runConfiguredInitialize(this);
  }

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
  public async close(): Promise<ConnectorTeardownResult> {
    return runConfiguredClose(this);
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
 * @param options - Optional overrides for the agent/connector/config factories
 * @returns Test adapter and scoped bus
 */
export function createTestAdapter(
  adapterName: string,
  options?: {
    agentFactory?: AdapterConfigExtensions['agentFactory'];
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
    agentFactory: options?.agentFactory ?? ((config: AIAgentConfig<TestBus, MockConnector>) => new TestAgent(config)),
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

/**
 * Answer every start reservation with a committed one.
 *
 * A resume start the adapter owns the agent row for reserves its provider
 * session before it dispatches, as a **hard** request: an adapter that can start
 * and cannot reserve is a broken composition, so the call does not degrade when
 * the subject is unhandled.
 *
 * What this registers is a stand-in for the *authority*, never for the seam
 * under test. It belongs in suites whose subject is the connector lifecycle —
 * rehydration, inference, session-close eviction — which need a started agent
 * and say nothing about ownership. The suite that asserts the reservation itself
 * composes the real memory backends and the real authority, because a stub there
 * would assert nothing.
 * @returns Cleanup for the registered handler.
 */
export function registerStartReservationAuthority(): () => void {
  return MakaioBus.on(SessionSubjects.ownership.reserveStart, (ctx) => {
    const now = Date.now();
    ctx.setResult({
      outcome: 'reserved',
      reservation: {
        agentId: ctx.payload.agentId,
        sessionId: ctx.payload.sessionId,
        machineId: 'test-machine',
        adapterId: ctx.payload.adapterId,
        claim:
          ctx.payload.resumeProviderSessionId === null
            ? null
            : {
                claimId: `claim-${ctx.payload.agentId}`,
                machineId: 'test-machine',
                adapterId: ctx.payload.adapterId,
                adapterName: ctx.payload.adapterName,
                providerSessionId: ctx.payload.resumeProviderSessionId,
                sessionId: ctx.payload.sessionId,
                agentId: ctx.payload.agentId,
                claimToken: `token-${ctx.payload.agentId}`,
                fence: 1,
                status: 'held',
                claimedAt: now,
                updatedAt: now,
              },
        leadDesignated: false,
        previousLeadAgentId: null,
      },
    });
  });
}

/**
 * Accept the agent-row writes a reserved start makes.
 *
 * A reserved start writes its `starting` row before it may reserve and its whole
 * record after it lands, both through `storage:agent.set` — and the first is a
 * hard request, because the reservation is taken against that row.
 *
 * Only for suites that do not inspect the row themselves: request handlers form
 * one chain and the first registered answers, so a suite with its own recorder
 * must register that instead of this.
 * @returns Cleanup for the registered handler.
 */
export function registerAgentRowStorage(): () => void {
  return MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
    ctx.setResult({ success: true });
  });
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
