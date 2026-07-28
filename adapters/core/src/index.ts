// Types — AI model, adapter definitions, capabilities, messaging, MCP, conformance
export type {
  AIModel,
  AIReasoningLevel,
  ReasoningLevelMap,
  PlatformDefaults,
  AIAdapterInitOptions,
  AIAdapterDefinition,
  AdapterProviderDefinition,
  AIAdapterCapabilityRegistry,
  ValidCapability,
  GeneratedCapabilityProperties,
  AIAdapterCapabilities,
  AIAdapterCapability,
  StartAgentRequest,
  StartAgentResponse,
  SendMessageRequest,
  SendMessageResponse,
  AIAdapterPromptOptions,
  AIAdapterPromptSuccessResult,
  AIAdapterPromptFailureResult,
  AIAdapterPromptResult,
  McpToolChange,
  McpSessionResources,
  McpIntegrationStrategy,
  TestModelRef,
  CreateConformanceTestConfigOptions,
  CreateTestAgentOptions,
  ConformanceTestConfig,
} from './types/index.js';

// Factory — adapter namespace creation
/** @public */
export { createAdapterNamespace } from './factory/index.js';
export type { AdapterNamespace, ScopedBusFor, AIAdapterContext } from './factory/index.js';

// Utilities
/** @public */
export { cleanEnvForAdapter } from './utils/index.js';
/** @public */
export { normalizeEnvValue } from './utils/index.js';
/** @public */
export { resolveRequiredSessionId } from './utils/index.js';
export {
  safeJsonStringify,
  serializeTurnContext,
  formatContextBlockAsText,
  formatContextBlocksAsText,
  parseAIAdapterCapabilities,
  normalizeMessageInput,
  defineDiscriminatedHandlers,
  defineDiscriminatedHandlersSync,
  processDiscriminatedItems,
  processDiscriminatedItemsSync,
  MAKAIO_CONFORMANCE_PROVIDER_ENV,
  MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV,
  MAKAIO_CONFORMANCE_PRIMARY_MODEL_ENV,
  MAKAIO_CONFORMANCE_SECONDARY_MODEL_ENV,
  resolveTestConfig,
  createTestProviderContext,
  resolveConformanceTestPreset,
  resolveConformanceDefinitionProviders,
  resolveDisabledNativeTools,
  formatMessageHistoryAsTranscript,
  serializeBlockToText,
  ScopedToolApprovalSchema,
  createToolApprovalHandler,
  mergeScopedToolApproval,
  normalizeMimeType,
  isTextLikeMimeType,
} from './utils/index.js';

// Conformance testing
export { ConformanceConnectorRuntimeRegistry, createNoAuthTestProviderContext } from './testing/index.js';
export type {
  SerializedContextBlock,
  NormalizedMessageInput,
  TypedEmitFn,
  SyncTypedEmitFn,
  DiscriminatedHandler,
  SyncDiscriminatedHandler,
  DiscriminatedHandlersMap,
  SyncDiscriminatedHandlersMap,
  DiscriminatedHandlersConfig,
  SyncDiscriminatedHandlersConfig,
  HarnessRequester,
  ConformanceEnvReader,
  ResolveConformanceTestPresetOptions,
  ResolvedConformanceTestPreset,
  ResolveConformanceDefinitionProvidersOptions,
  MergeScopedToolApprovalOptions,
  ScopedToolApprovalRequest,
  ScopedToolApprovalResponse,
  ToolApprovalContext,
  ToGlobalToolApprovalFn,
  FromGlobalToolApprovalFn,
} from './utils/index.js';

// Session lifecycle
export {
  SessionLifecycle,
  UserMessageQueue,
  processQueueMessages,
  rejectQueuedHandles,
  SESSION_CLOSED_QUEUE_ERROR,
} from './session/index.js';
export type { QueueableTurn, MergeResult, ProcessQueueCallbacks } from './session/index.js';

// Agent — connectors, agent classes, lifecycle, tracking
/** @public */
export { AIAgentConnector } from './agent/index.js';
/** @public */
export { AIAgent } from './agent/index.js';
/** @public */
export { AgentRuntimeMutationManager } from './agent/index.js';
/** @public */
export { MessageLifecycleTracker } from './agent/index.js';
export {
  BaseConnectorSession,
  BaseConnectorTurn,
  ProceduralConnectorTurn,
  ProceduralAgentConnector,
  AgentEventBridge,
  AgentTurnExecutor,
  AgentConnectorLifecycleManager,
  AgentLifecycleEmitter,
  AgentPayloadEmitter,
  registerAgentBusHandlers,
  ToolCallTracker,
  SessionToolLedger,
  extractMcpCallTarget,
  isMcpCallTool,
} from './agent/index.js';
export type {
  ConnectorSessionConfig,
  PauseResult,
  TurnSubjects,
  ProceduralTurnState,
  ProceduralTurnConfig,
  ProceduralConnectorSession,
  WireSessionSubjects,
  WireSessionConfig,
  AgentEventBridgeConfig,
  AgentTurnExecutorConfig,
  ShouldUseNativeResumeFn,
  AgentConnectorLifecycleManagerConfig,
  AgentLifecycleEmitterConfig,
  AgentPayloadEmitterConfig,
  AgentBusHandlerRegistrarConfig,
  AgentRuntimeMutationManagerConfig,
  ResolveHints,
  ISessionToolLedger,
  ToolLedgerEntry,
  LedgerSessionContext,
  ProviderRequestCorrelation,
  AIAgentConfig,
  AgentContext,
  AgentIdentity,
  NormalizedCallUsage,
  BaseAgentConnectorConfig,
  AgentStartResult,
  StartAgentOptions,
  AgentSendMessageOptions,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
  ExecutionContext,
} from './agent/index.js';

export {
  bindProviderRequestCorrelation,
  buildFactoryUsageCorrelationHeaders,
  FactoryUsageCorrelationHeaders,
} from './agent/index.js';

// AI Adapter base class
export { AIAdapter } from './adapter/index.js';
export type {
  AIAdapterConfig,
  AIAdapterConstructorConfig,
  AgentRuntimeCreationResult,
  AgentUsageTotals,
  ConfigFactoryInput,
  IAdapterConfigFactory,
} from './adapter/index.js';

// Log importer infrastructure
export {
  toImportSegment,
  BaseLogImporter,
  ImportCursorStorageNamespace,
  ImportCursorStorageSubjects,
  ImportCursorPositionSchema,
  registerMemoryImportCursorStorage,
  TurnTracker,
  TurnTrackerSerializedStateSchema,
} from './log-importer/index.js';
export type {
  LogImporter,
  LogImportSessionContext,
  NormalizedEvent,
  ImportMetadata,
  ImportCursorPosition,
  ExternalToolIdentifier,
  ExternalToolIdentifiers,
  ExternalToolMeta,
  LogImporterConfig,
  StorageMessagePayload,
  LogImportTestConfig,
  DiscoveryMetadata,
  ProcessLogFileResult,
  ImportSegment,
  ImportSegmentLineage,
  ImportSegmentTurn,
  CompactionMetadata,
  LogImportConfig,
  LogImportOrchestrator,
  LogImportRegistration,
  LogOrchestratorConstructor,
  LogImporterConstructor,
  LogOrchestratorConfig,
  ParseFileResult,
  TurnState,
  TurnEvent,
  TurnTrackerOptions,
  TurnTrackerSerializedState,
} from './log-importer/index.js';

// Message handle
export { markCompletedWithFinalResult, MessageHandle } from './message-handle/index.js';
export type {
  MessageDeliveryMode,
  MessageResult,
  MessageState,
  SendMessageOptions,
  ProcessingState,
} from './message-handle/index.js';

// Namespace schemas (agent/tool lifecycle events)
export {
  AgentStartedEventSchema,
  AgentCompleteEventSchema,
  ErrorEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
} from './namespaces/index.js';
export type {
  AgentStartedEvent,
  AgentCompleteEvent,
  ErrorEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
} from './namespaces/index.js';
