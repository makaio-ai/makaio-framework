import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  AdapterSubjects,
  type AIReasoningLevel,
  type McpRuntimeSessionContext,
  type McpSessionContext,
  type ReasoningLevelMap,
  type ProviderContext,
  type StartMode,
  type SystemPrompt,
} from '@makaio/contracts';
import type { LedgerSessionContext } from './session-tool-ledger.js';
import type { ConfigFactoryInput } from '../adapter/index.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { BaseAgentConnectorConfig, StartAgentOptions } from './types.js';
import { AgentEventBridge } from './agent-event-bridge.js';
import { AgentPayloadEmitter, type AgentPayloadEmitterConfig } from './agent-payload-emitter.js';
import { AgentTurnExecutor } from './agent-turn-executor.js';
import { AgentRuntimeMutationManager } from './agent-runtime-mutation-manager.js';
import { AgentConnectorLifecycleManager } from './agent-connector-lifecycle-manager.js';
import type { MessageLifecycleTracker } from './message-lifecycle-tracker.js';
import type { ToolCallTracker } from './tool-call-tracker.js';

/**
 * Input bundle for {@link createAgentPayloadEmitter}.
 * Derives from {@link AgentPayloadEmitterConfig} but replaces the two callback
 * fields with a {@link MessageLifecycleTracker} — the factory derives
 * `getCurrentMessageId` and `getCurrentTurnId` from it.
 */
export type CreatePayloadEmitterInput = Omit<AgentPayloadEmitterConfig, 'getCurrentMessageId' | 'getCurrentTurnId'> & {
  lifecycleTracker: MessageLifecycleTracker;
};

/**
 * Create payload emitter for an agent instance.
 * @param config - Payload emitter dependency bundle
 * @returns Configured payload emitter
 */
export function createAgentPayloadEmitter(config: CreatePayloadEmitterInput): AgentPayloadEmitter {
  return new AgentPayloadEmitter({
    globalBus: config.globalBus,
    getAgentContextBase: config.getAgentContextBase,
    getCurrentMessageId: () => config.lifecycleTracker.getCurrentMessageId(),
    getCurrentTurnId: () => config.lifecycleTracker.getCurrentTurnId(),
    getConnectorAdapterSessionId: config.getConnectorAdapterSessionId,
    getLastKnownAdapterSessionId: config.getLastKnownAdapterSessionId,
    setLastKnownAdapterSessionId: config.setLastKnownAdapterSessionId,
    getEventMetadataDefaults: config.getEventMetadataDefaults,
  });
}

/**
 * Create event bridge with subject-specific emitters.
 * @param config - Event bridge dependency bundle
 * @returns Configured event bridge
 */
export function createAgentEventBridge(config: {
  emitGlobal: AgentPayloadEmitter['emitGlobal'];
  toolCallTracker: ToolCallTracker;
  getBlockIndex: () => number;
  incrementBlockIndex: () => void;
  getUsageModel: () => string | undefined;
}): AgentEventBridge {
  return new AgentEventBridge({
    emitUsage: async (payload) => {
      await config.emitGlobal(AgentSubjects.usage, payload);
    },
    emitContextWindowUpdated: async (payload) => {
      await config.emitGlobal(AgentSubjects.contextWindow.updated, payload);
    },
    emitToolUse: async (payload) => {
      await config.emitGlobal(AgentSubjects.tool.use, payload);
    },
    emitToolOutput: async (payload) => {
      await config.emitGlobal(AgentSubjects.tool.output, payload);
    },
    emitAdapterLog: async (payload) => {
      await config.emitGlobal(AdapterSubjects.log, payload, { includeEventMetadata: false });
    },
    emitStepStarted: async (payload) => {
      await config.emitGlobal(AgentSubjects.step.started, payload);
    },
    emitStepFinished: async (payload) => {
      await config.emitGlobal(AgentSubjects.step.finished, payload);
    },
    toolCallTracker: config.toolCallTracker,
    getBlockIndex: config.getBlockIndex,
    incrementBlockIndex: config.incrementBlockIndex,
    getUsageModel: config.getUsageModel,
  });
}

/**
 * Create shared turn executor.
 * @param config - Turn execution dependency bundle
 * @returns Configured turn executor
 */
export function createAgentTurnExecutor(config: {
  agentId: string;
  adapterId: string;
  sessionId?: string;
  /** Capability tags reported by the adapter (e.g. `'structuredOutput'`). */
  adapterCapabilities?: string[];
  globalBus: IMakaioBus;
  getConnector: () => AIAgentConnector;
  shouldUseNativeResume: (sessionContext?: StartAgentOptions['sessionContext']) => boolean;
  /**
   * Whether the agent config carries a concrete resume target.
   * @see AgentTurnExecutorConfig.hasResumeTarget
   */
  hasResumeTarget: () => boolean;
  /** Set the start mode on the owning agent before connector dispatch. */
  setPendingStartMode: (mode: StartMode) => void;
  onMessageHandle: (messageHandle: MessageHandle, turnId: string | undefined) => Promise<void>;
  onBeforeDispatch?: () => void | Promise<void>;
  ephemeral?: boolean;
}): AgentTurnExecutor {
  return new AgentTurnExecutor(config);
}

/**
 * Create runtime mutation manager.
 * @param config - Runtime mutation dependency bundle
 * @returns Configured runtime mutation manager
 */
export function createAgentRuntimeMutationManager(config: {
  agentId: string;
  sessionId?: string;
  globalBus: IMakaioBus;
  getConnector: () => AIAgentConnector;
  swapConnector: (
    configOverrides?: Partial<{
      cwd: string;
      model: string;
      providerContext: ProviderContext;
      mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
    }>,
  ) => Promise<void>;
  emitGlobal: AgentPayloadEmitter['emitGlobal'];
  getProviderContext: () => ProviderContext | undefined;
  setProviderContext: (providerContext: ProviderContext) => void;
  setReasoningEffort: (reasoningEffort: AIReasoningLevel | undefined) => void;
  setMcpSessionContext: (
    mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext | undefined,
  ) => void;
  resolveSupportedReasoningLevels: (model: string) => ReasoningLevelMap | undefined;
}): AgentRuntimeMutationManager {
  return new AgentRuntimeMutationManager({
    agentId: config.agentId,
    sessionId: config.sessionId,
    globalBus: config.globalBus,
    getConnector: config.getConnector,
    swapConnector: config.swapConnector,
    emitCwdChanged: async (payload) => {
      await config.emitGlobal(AgentSubjects.cwd.changed, payload);
    },
    emitModelChanged: async (payload) => {
      await config.emitGlobal(AgentSubjects.model.changed, payload);
    },
    getProviderContext: config.getProviderContext,
    setProviderContext: config.setProviderContext,
    setReasoningEffort: config.setReasoningEffort,
    setMcpSessionContext: config.setMcpSessionContext,
    resolveSupportedReasoningLevels: config.resolveSupportedReasoningLevels,
  });
}

/**
 * Create connector lifecycle manager.
 * @param config - Connector lifecycle dependency bundle
 * @returns Configured connector lifecycle manager
 */
export function createAgentConnectorLifecycleManager<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
>(config: {
  agentId: string;
  buildConfigInput: (
    overrides?: Partial<{
      cwd: string;
      model: string;
      providerContext: ProviderContext;
      adapterSessionId: string;
      resumeAdapterSessionId: string;
      mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
    }>,
  ) => ConfigFactoryInput<TBus>;
  configFactory: (input: ConfigFactoryInput<TBus>) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => Promise<TConnector> | TConnector;
  createOnMessageSent: () => (handle: MessageHandle) => void;
  wireEvents: (connector: TConnector) => void | Promise<void>;
  emitGlobal: AgentPayloadEmitter['emitGlobal'];
  getConnector: () => TConnector;
  setConnector: (connector: TConnector) => void;
  getRuntimeSystemPrompt: () => SystemPrompt | undefined;
  setLastKnownAdapterSessionId: (adapterSessionId: string | undefined) => void;
}): AgentConnectorLifecycleManager<TBus, TConnector> {
  return new AgentConnectorLifecycleManager<TBus, TConnector>({
    agentId: config.agentId,
    buildConfigInput: config.buildConfigInput,
    configFactory: config.configFactory,
    connectorFactory: config.connectorFactory,
    createOnMessageSent: config.createOnMessageSent,
    wireEvents: config.wireEvents,
    emitIdle: async () => {
      await config.emitGlobal(AgentSubjects.idle, {});
    },
    getConnector: config.getConnector,
    setConnector: config.setConnector,
    getRuntimeSystemPrompt: config.getRuntimeSystemPrompt,
    setLastKnownAdapterSessionId: config.setLastKnownAdapterSessionId,
  });
}
