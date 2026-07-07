import { vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import { AIAgent } from '../../ai-agent.js';
import type {
  AgentStartResult,
  AIAgentConfig,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
} from '../../types.js';
import type { AIAgentConnector } from '../../../connector/agent-connector.js';
import { MessageHandle } from '../../../message-handle/index.js';
import type { ProcessingState } from '../../../message-handle/types.js';
import type { AIModel, AIReasoningLevel, ReasoningLevelMap } from '../../../types/ai-model.js';
import type { NormalizedMessageInput } from '../../../utils/index.js';
import type { McpSessionContext, ProviderContext } from '@makaio/contracts';
import type { LedgerSessionContext } from '../../session-tool-ledger.js';

/**
 * Mock connector that satisfies the AIAgentConnector interface for testing.
 * Tracks model, cwd, processing state, and close calls.
 */
export class MockConnector implements Partial<AIAgentConnector> {
  public model: string;
  public cwd: string;
  public currentReasoningEffort?: AIReasoningLevel;
  public supportedReasoningLevels?: ReasoningLevelMap;
  public mcpSessionContext?: McpSessionContext | LedgerSessionContext;
  public startedMessages: NormalizedMessageInput[] = [];
  public sentMessages: NormalizedMessageInput[] = [];
  public startedHandles: MessageHandle[] = [];
  public sentHandles: MessageHandle[] = [];
  private processingState: ProcessingState = 'idle';
  public closeCalled = false;
  public interruptCalled = false;
  private processingStateListeners: Array<(state: ProcessingState) => void> = [];

  /** Whether changeModelInPlace returns true (native path) or false (swap path) */
  public changeModelInPlaceResult = false;
  /** Whether changeCwdInPlace returns true (native path) or false (swap path) */
  public changeCwdInPlaceResult = false;
  /** Whether changeReasoningInPlace returns true (native path) or false (swap path) */
  public changeReasoningInPlaceResult = true;

  /**
   * Create a new mock connector.
   * @param model - The model identifier
   * @param cwd - The working directory
   * @param reasoningEffort - Optional reasoning effort carried on the connector
   * @param supportedReasoningLevels - Reasoning levels supported by the active model
   * @param mcpSessionContext - Optional MCP session context carried into the connector config
   */
  public constructor(
    model: string,
    cwd: string,
    reasoningEffort?: AIReasoningLevel,
    supportedReasoningLevels?: ReasoningLevelMap,
    mcpSessionContext?: McpSessionContext | LedgerSessionContext,
  ) {
    this.model = model;
    this.cwd = cwd;
    this.currentReasoningEffort = reasoningEffort;
    this.supportedReasoningLevels = supportedReasoningLevels;
    this.mcpSessionContext = mcpSessionContext;
  }

  /**
   * Get the current processing state.
   * @returns The processing state
   */
  public getProcessingState(): ProcessingState {
    return this.processingState;
  }

  /**
   * Set the processing state and notify listeners.
   * @param state - The new processing state
   */
  public setProcessingState(state: ProcessingState): void {
    this.processingState = state;
    // Notify all listeners
    for (const listener of this.processingStateListeners) {
      listener(state);
    }
  }

  /**
   * Subscribe to processing state changes.
   * @param handler - Called with the new state on each change
   * @returns Unsubscribe function
   */
  public onProcessingStateChanged(handler: (state: ProcessingState) => void): () => void {
    this.processingStateListeners.push(handler);
    return () => {
      const index = this.processingStateListeners.indexOf(handler);
      if (index > -1) {
        this.processingStateListeners.splice(index, 1);
      }
    };
  }

  /**
   * Close the connector (tracks call).
   */
  public async close(): Promise<void> {
    this.closeCalled = true;
  }

  /**
   * Interrupt the mock connector.
   */
  public async interrupt(): Promise<void> {
    this.interruptCalled = true;
  }

  /**
   * Mock implementation of in-place model change.
   * @param _newModel - The model to switch to (unused in mock)
   * @returns The configured result (default: false → swap required)
   */
  public async changeModelInPlace(_newModel: string): Promise<boolean> {
    return this.changeModelInPlaceResult;
  }

  /**
   * Mock implementation of in-place cwd change.
   * @param _newCwd - The cwd to switch to (unused in mock)
   * @returns The configured result (default: false → swap required)
   */
  public async changeCwdInPlace(_newCwd: string): Promise<boolean> {
    return this.changeCwdInPlaceResult;
  }

  /**
   * Mock implementation of in-place reasoning change.
   * @param _newLevel - The reasoning level to switch to (unused in mock)
   * @returns The configured result (default: true → in-place change succeeds)
   */
  public async changeReasoningInPlace(_newLevel: AIReasoningLevel): Promise<boolean> {
    return this.changeReasoningInPlaceResult;
  }

  /**
   * Get the adapter session ID.
   * @returns The session ID
   */
  public async getAdapterSessionId(): Promise<string> {
    return 'test-session-id';
  }

  /**
   * Initialize the connector (no-op for mock).
   * Required by AIAgentConnector contract.
   */
  public async initialize(): Promise<void> {
    // No-op: real connectors set adapterSessionId here
  }

  /**
   * Return mock confirmed session ID.
   * @returns Always returns 'test-session-id' for mocks.
   */
  public getConfirmedAdapterSessionId(): string | undefined {
    return 'test-session-id';
  }

  /**
   * Start a mock session and return an acknowledged message handle.
   * @param message - Normalized user message
   * @param options - Optional connector start options
   * @returns Mock start result
   */
  public async start(message: NormalizedMessageInput, options?: ConnectorStartOptions): Promise<AgentStartResult> {
    this.startedMessages.push(message);
    const messageHandle = this.createMessageHandle(message, options);
    this.startedHandles.push(messageHandle);
    return {
      adapterSessionId: 'test-session-id',
      agentId: 'test-agent',
      messageHandle,
    };
  }

  /**
   * Send a mock follow-up message and return an acknowledged handle.
   * @param message - Normalized user message
   * @param options - Optional connector send options
   * @returns Mock message handle
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    this.sentMessages.push(message);
    const messageHandle = this.createMessageHandle(message, options);
    this.sentHandles.push(messageHandle);
    return messageHandle;
  }

  /**
   * Create a mock message handle with adapter session and acknowledgement set.
   * @param message - Normalized user message
   * @param options - Optional connector send options
   * @returns Prepared message handle
   */
  private createMessageHandle(message: NormalizedMessageInput, options?: ConnectorSendMessageOptions): MessageHandle {
    const handle = new MessageHandle(
      options?.messageId ?? 'mock-message-id',
      message,
      options?.deliveryMode ?? 'enqueue',
      options?.messageHistory,
      options?.turnContext,
      options?.responseSchema,
      options?.internalRetry ?? false,
    );
    handle.adapterSessionId = 'test-session-id';
    handle.markAcknowledged(true);
    return handle;
  }
}

/**
 * Narrow a MockConnector-backed partial to the runtime connector contract used by tests.
 *
 * The agent tests exercise only the subset implemented by MockConnector, so this helper
 * keeps that intentional cast in one place instead of repeating noisy double-casts.
 * @param connector - Connector-like test double backed by MockConnector behavior
 * @returns Connector typed as the runtime contract expected by factory hooks
 */
export function asAgentConnector(connector: Partial<AIAgentConnector>): AIAgentConnector {
  return connector as AIAgentConnector;
}

/**
 * Concrete test agent with minimal implementation.
 * Exposes currentConnector for test assertions.
 */
export class TestableAgent extends AIAgent {
  public currentConnector!: MockConnector;
  private mockConnectorFactory: (config: {
    model: string;
    cwd: string;
    reasoningEffort?: AIReasoningLevel;
    supportedReasoningLevels?: ReasoningLevelMap;
    mcpSessionContext?: McpSessionContext | LedgerSessionContext;
  }) => MockConnector;

  /**
   * Create a testable agent.
   * @param config - Agent configuration
   * @param mockConnectorFactory - Factory for creating mock connectors
   */
  public constructor(
    config: AIAgentConfig,
    mockConnectorFactory: (config: {
      model: string;
      cwd: string;
      reasoningEffort?: AIReasoningLevel;
      supportedReasoningLevels?: ReasoningLevelMap;
      mcpSessionContext?: McpSessionContext | LedgerSessionContext;
    }) => MockConnector,
  ) {
    super(config);
    this.mockConnectorFactory = mockConnectorFactory;
  }

  /**
   * Required abstract implementation - assigns currentConnector for test access.
   * @param connector - The connector to wire events for
   */
  protected async wireEvents(connector: AIAgentConnector): Promise<void> {
    // @ts-expect-error -- the factory always produces MockConnector instances; narrowing is safe here
    this.currentConnector = connector;
  }
}

/**
 * Options for creating a testable agent.
 */
export interface CreateTestableAgentOptions {
  /** Agent identifier */
  agentId: string;
  /** Factory function for creating mock connectors */
  mockConnectorFactory: (config: {
    model: string;
    cwd: string;
    reasoningEffort?: AIReasoningLevel;
    supportedReasoningLevels?: ReasoningLevelMap;
    mcpSessionContext?: McpSessionContext | LedgerSessionContext;
  }) => MockConnector;
  /** Initial model (optional, defaults to 'test-model') */
  initialModel?: string;
  /** Initial working directory (optional, defaults to '/test/cwd') */
  initialCwd?: string;
  /** Optional Makaio session ID associated with the agent */
  sessionId?: string;
  /** Available models exposed by the adapter for capability resolution. */
  availableModels?: AIModel[];
  /** Initial reasoning effort */
  initialReasoningEffort?: AIReasoningLevel;
  /** Initial provider context persisted on the agent config. */
  providerContext?: ProviderContext;
  /** Initial MCP session context persisted on the agent config. */
  mcpSessionContext?: McpSessionContext | LedgerSessionContext;
}

/**
 * Create a TestableAgent instance with factory support.
 * @param options - Configuration options
 * @returns A configured TestableAgent
 */
export function createTestableAgent(options: CreateTestableAgentOptions): TestableAgent {
  const {
    agentId,
    mockConnectorFactory,
    initialModel = 'test-model',
    initialCwd = '/test/cwd',
    sessionId,
    availableModels,
    initialReasoningEffort,
    providerContext,
    mcpSessionContext,
  } = options;
  const { bus: mockBus } = createMockScopedBus();
  const resolveSupportedReasoningLevels = (model: string): ReasoningLevelMap | undefined =>
    availableModels?.find((entry) => entry.name === model)?.supportedReasoningLevels;

  const config: AIAgentConfig = {
    agentId,
    adapterId: 'test-adapter',
    adapterName: 'test',
    capabilities: [],
    nativeTools: [],
    sessionId,
    adapterBus: mockBus,
    globalBus: MakaioBus,
    model: initialModel,
    cwd: initialCwd,
    reasoningEffort: initialReasoningEffort,
    availableModels,
    providerContext,
    mcpSessionContext,
    configFactory: async (input) => ({
      bus: mockBus,
      agentId,
      adapterId: 'test-adapter',
      adapterName: 'test',
      model: input.model ?? initialModel,
      cwd: input.cwd ?? initialCwd,
      reasoningEffort: input.reasoningEffort ?? initialReasoningEffort,
      supportedReasoningLevels: resolveSupportedReasoningLevels(input.model ?? initialModel),
      mcpSessionContext: input.mcpSessionContext,
    }),
    connectorFactory: async (factoryConfig) => {
      // MockConnector satisfies the runtime contract for all exercised methods
      return asAgentConnector(
        mockConnectorFactory({
          model: factoryConfig.model,
          cwd: factoryConfig.cwd,
          reasoningEffort: factoryConfig.reasoningEffort,
          supportedReasoningLevels: factoryConfig.supportedReasoningLevels,
          mcpSessionContext: factoryConfig.mcpSessionContext,
        }),
      );
    },
  };

  return new TestableAgent(config, mockConnectorFactory);
}

/**
 * Shared test lifecycle context for agent tests.
 *
 * Encapsulates the repeated pattern of tracking created connectors,
 * cleanup functions, and agent lifecycle across model-change, cwd-change,
 * and idle-event tests.
 */
export interface AgentTestLifecycle {
  /** All connectors created by the tracking factory */
  createdConnectors: MockConnector[];
  /** Cleanup functions to run in afterEach */
  cleanupFns: Array<() => void>;
  /** The agent under test (set after createAgent) */
  agent: TestableAgent | undefined;
  /** A vi.fn()-wrapped factory that tracks created connectors */
  mockFactory: ReturnType<
    typeof vi.fn<
      (config: {
        model: string;
        cwd: string;
        reasoningEffort?: AIReasoningLevel;
        supportedReasoningLevels?: ReasoningLevelMap;
        mcpSessionContext?: McpSessionContext | LedgerSessionContext;
      }) => MockConnector
    >
  >;
  /** Reset tracking state (call in beforeEach) */
  reset: () => void;
  /** Tear down agent and run cleanup functions (call in afterEach) */
  teardown: () => Promise<void>;
}

/**
 * Create a shared test lifecycle context for agent tests.
 *
 * Eliminates the duplicated beforeEach/afterEach/mockFactory pattern
 * found across model-change, cwd-change, and idle-event tests.
 * @returns Shared lifecycle context
 */
export function createAgentTestLifecycle(): AgentTestLifecycle {
  const ctx: AgentTestLifecycle = {
    createdConnectors: [],
    cleanupFns: [],
    agent: undefined,
    mockFactory: vi.fn((config) => {
      const connector = new MockConnector(
        config.model,
        config.cwd,
        config.reasoningEffort,
        config.supportedReasoningLevels,
        config.mcpSessionContext,
      );
      ctx.createdConnectors.push(connector);
      return connector;
    }),
    reset() {
      ctx.createdConnectors = [];
    },
    teardown: async () => {
      for (const cleanup of ctx.cleanupFns) {
        cleanup();
      }
      ctx.cleanupFns = [];
      await ctx.agent?.close();
    },
  };
  return ctx;
}
