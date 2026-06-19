export { SessionSubjects, SessionNamespace } from './namespace.js';
export {
  SessionSchemas,
  MakaioSessionSchema,
  SessionRecordMetadataSchema,
  MakaioSessionEventSchema,
  MakaioSessionAgentSchema,
  SessionPreviewDataSchema,
  SessionWithPreviewSchema,
  SESSION_EVENT_TYPES,
  SessionEventTypeSchema,
  SessionSnapshotSchema,
  SnapshotExportOptionsSchema,
  SNAPSHOT_VERSION,
  validateSnapshot,
  safeValidateSnapshot,
} from './schemas.js';
export { AgentRoleSchema, type AgentRole } from './schemas.js';
export { AgentStatusSchema, type AgentStatus } from './schemas.js';
export { BranchKindSchema, type BranchKind } from './schemas.js';
export type {
  SessionSnapshot,
  SnapshotExportOptions,
  SnapshotPreviewData,
  SnapshotImportConflictErrorData,
  SessionRecordMetadata,
} from './schemas.js';
export type {
  IMakaioSession,
  MakaioSessionAgent,
  MakaioSessionEvent,
  KnownSessionEvent,
  SessionEventType,
  SessionEventPayload,
  SessionEventTypeMap,
  SessionPreviewData,
  SessionWithPreview,
} from './types.js';
export { isKnownSessionEvent } from './types.js';
export type {
  ForkOptions,
  ContextWindowState,
  SessionExtensionContext,
  SessionExtensionContextFactory,
} from './schemas/extension-context.js';
export { CACHE_STRATEGIES, SessionContextSchema } from './session-context.js';
export type { CacheStrategy, SessionContext } from './session-context.js';
export {
  UI_WARNINGS_CATEGORY,
  CONNECTOR_SWAP_WARNING_SUPPRESSED_KEY,
  INTERACTIVE_DIALOG_TIMEOUT_MS,
  CONNECTOR_SWAP_WARNING_OPTION_IDS,
} from './connector-swap-warning.js';
export type { ConnectorSwapWarningOptionId } from './connector-swap-warning.js';
export {
  CONNECTOR_SWAP_CANCELLED_CODE,
  ConnectorSwapCancelledError,
  isConnectorSwapCancelledError,
} from './connector-swap-cancelled-error.js';

// Fork Child Info (for enriched getChildren response)
export { ForkChildInfoSchema, type ForkChildInfo } from './schemas/fork-child-info.js';

// Resolve agent config RPC
export {
  ResolveAgentConfigSchema,
  type ResolveAgentConfigRequest,
  type ResolveAgentConfigResponse,
} from './schemas/resolve-agent-config.js';

// Resolve system prompt RPC
export {
  ResolveSystemPromptSchema,
  type ResolveSystemPromptRequest,
  type ResolveSystemPromptResponse,
} from './schemas/resolve-system-prompt.js';

// Segment Policy (for segment-based context curation in fork modal)
export { SegmentPolicySchema, type SegmentPolicy } from './schemas/lifecycle-events.js';

// Fork Transforms (for fork edit mode)
export { ForkTransformsSchema, type ForkTransforms } from './schemas/lifecycle-events.js';

// Session Created event (lifecycle)
export { SessionCreatedEventSchema, type SessionCreated } from './schemas/lifecycle-events.js';
// Session Updated event (lifecycle)
export { SessionUpdatedEventSchema, type SessionUpdatedEvent } from './schemas/lifecycle-events.js';

// Session client-account changed event
export { SessionClientAccountChangedSchema, type SessionClientAccountChanged } from './schemas/events.js';

// Import status changed event
export { SessionImportStatusChangedSchema, type SessionImportStatusChanged } from './schemas/events.js';

// Normalized Message Model (stored session messages)
export {
  SessionMessageOriginSchema,
  SessionMessageBlockSchema,
  SessionMessageSchema,
  SessionMessageRoleSchema,
  TurnInitiatorSchema,
  TurnSchema,
  TurnStatusSchema,
  TurnUsageSchema,
  UsageMetricsSchema,
  MessageRoutingSchema,
  MessageRoutingStatusSchema,
} from './schemas/message.js';
export type {
  SessionMessageOrigin,
  SessionMessageBlock,
  SessionMessage,
  SessionMessageRole,
  Turn,
  TurnInitiator,
  TurnStatus,
  TurnUsage,
  UsageMetrics,
  MessageRouting,
  MessageRoutingStatus,
} from './schemas/message.js';

// Branch kind utilities
export { isInViewBranch, isNavigatingBranch, isMergeable, getBranchBehavior } from './utils/index.js';
export type { BranchBehavior } from './utils/index.js';

// Orchestrator types (session-level, distinct from agent-level)
export type {
  SendMessageRequest as SessionSendMessageRequest,
  SendMessageResponse as SessionSendMessageResponse,
} from './schemas/orchestrator.js';

// Compression mode (framework-owned, used by session/agent and agent-resolution schemas)
export { CompressionModeSchema, type CompressionMode } from './schemas/compression.js';

// Session enrichment RPC schemas
export { SessionEnrichmentSchemas } from './schemas/enrichment.js';

// Note: Turn, SessionBridge, SessionLogger, SessionOrchestrator live in @makaio/services-core/session

// Storage bus subjects — for service-to-storage communication via the bus.
// Handlers are registered by @makaio/services-core/session; these subjects allow
// consumers (e.g. search service) to communicate without a direct dependency.
export {
  MessageStorageNamespace,
  MessageStorageSubjects,
  MessagePageCursorSchema,
} from './message-storage-namespace.js';
export type { MessagePageCursor } from './message-storage-namespace.js';
export {
  compareMessageCursorAsc,
  compareMessageCursorDesc,
  messageCursorKey,
  messageToCursor,
} from './message-cursor.js';

export { SessionEventStorageNamespace, SessionEventStorageSubjects } from './session-event-storage-namespace.js';

export {
  SessionStorageNamespace,
  SessionStorageSetRequestSchema,
  SessionStorageSetSessionSchema,
  SessionStorageSubjects,
  SessionStorageUpdateSchema,
  type ImportUpsertRequest,
  ImportStatusSchema,
  type ImportStatus,
} from './session-storage-namespace.js';

// Register-external RPC (adapter identity at session level, external-session path only)
export {
  SessionCreateBaseSchema,
  type SessionCreateBase,
} from './schemas/crud.js';
