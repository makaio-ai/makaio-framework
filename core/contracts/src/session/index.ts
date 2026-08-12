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
export { AdapterSessionCurrencyStateSchema, type AdapterSessionCurrencyState } from './schemas.js';
export { AgentRoleSchema, type AgentRole } from './schemas.js';
export { AgentStatusSchema, type AgentStatus } from './schemas.js';
// Session-ownership authority — the service surface of the ownership aggregate.
export {
  OwnershipTopologySchema,
  normalizeSessionOwnershipReserveStartServiceRequest,
  SessionOwnershipContinuationServiceRequestSchema,
  SessionOwnershipContinuationServiceResponseSchema,
  SessionOwnershipPrincipalSchema,
  SessionOwnershipReclaimReasonSchema,
  SessionOwnershipReconciledClaimSchema,
  SessionOwnershipReconcileServiceResponseSchema,
  SessionOwnershipReleaseServiceRequestSchema,
  SessionOwnershipReservationSchema,
  SessionOwnershipReserveStartServiceRequestSchema,
  SessionOwnershipReserveStartServiceResponseSchema,
  SessionOwnershipServiceMovementSchema,
  SessionOwnershipSettleMovementServiceRequestSchema,
  SessionOwnershipSettleMovementServiceResponseSchema,
} from './schemas.js';
export type {
  OwnershipTopology,
  SessionOwnershipContinuationServiceRequest,
  SessionOwnershipContinuationServiceResult,
  SessionOwnershipPrincipal,
  SessionOwnershipReclaimReason,
  SessionOwnershipReconciledClaim,
  SessionOwnershipReconcileServiceResult,
  SessionOwnershipReleaseServiceRequest,
  SessionOwnershipReservation,
  SessionOwnershipReserveStartServiceRequest,
  SessionOwnershipReserveStartServiceResult,
  SessionOwnershipServiceMovement,
  SessionOwnershipSettleMovementServiceRequest,
  SessionOwnershipSettleMovementServiceResult,
} from './schemas.js';
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
export { RequestCorrelationContextSchema } from './request-correlation.js';
export type { RequestCorrelationContext } from './request-correlation.js';
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
  AgentAttachResolvedRequest,
  SendMessageRequest as SessionSendMessageRequest,
  SendMessageResponse as SessionSendMessageResponse,
  TurnCompleted,
  TurnStarted,
} from './schemas/orchestrator.js';

// Ingestion marker for session.turn.* emissions (live vs backfill)
export { TurnIngestionMarkerSchema, type TurnIngestionMarker } from './schemas/orchestrator.js';

// Compression mode (framework-owned, used by session/agent and agent-resolution schemas)
export { CompressionModeSchema, type CompressionMode } from './schemas/compression.js';

// Session enrichment RPC schemas
export { SessionEnrichmentSchemas } from './schemas/enrichment.js';

// Note: Turn, SessionBridge, SessionOrchestrator live in @makaio/services-core/session

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
  ImportUpsertRequestSchema,
  type ImportUpsertRequest,
  SessionStorageRebindObservedRequestSchema,
  type SessionStorageRebindObservedRequest,
  SessionStorageRebindObservedResponseSchema,
  type SessionStorageRebindObservedResult,
  ImportStatusSchema,
  type ImportStatus,
} from './session-storage-namespace.js';

// Session ownership storage — claims, fencing and currency settlement
export {
  AdapterSessionClaimDispositionSchema,
  AdapterSessionClaimKeySchema,
  AdapterSessionClaimRecordSchema,
  AdapterSessionClaimStatusSchema,
  AgentSessionOwnershipRecordSchema,
  OwnershipOwnerInstanceSchema,
  RuntimeInstanceRecordSchema,
  RuntimeBindingSchema,
  SessionOwnershipClaimRequestSchema,
  normalizeSessionOwnershipClaimRequest,
  SessionOwnershipClaimResponseSchema,
  SessionOwnershipRecoveryGuardSchema,
  SessionOwnershipRecoveryOwnerGenerationSchema,
  SessionOwnershipRecoveryPreimageSchema,
  SessionOwnershipRecoveryReservationSchema,
  SessionOwnershipRecoveryTerminalActionSchema,
  SessionOwnershipFinalizeRecoveryRequestSchema,
  SessionOwnershipFinalizeRecoveryResponseSchema,
  OwnershipMovementSchema,
  SessionOwnershipListClaimsRequestSchema,
  SessionOwnershipReleaseAgentClaimsRequestSchema,
  SessionOwnershipReleaseAgentClaimsResponseSchema,
  SessionOwnershipReleaseRequestSchema,
  SessionOwnershipReleaseResponseSchema,
  SessionOwnershipSettleCurrencyRequestSchema,
  SessionOwnershipSettleCurrencyResponseSchema,
  SessionOwnershipSettleMovementRequestSchema,
  SessionOwnershipSettleMovementResponseSchema,
  SessionOwnershipStorageNamespace,
  SessionOwnershipStorageSubjects,
} from './session-ownership-storage-namespace.js';
export {
  getLeadDesignationMutationViolation,
  isInactiveSafeLeadDesignationMutation,
  isPureLeadRelinquishment,
  isPureLeadRestoration,
  validateLeadDesignationMutation,
  type SessionOwnershipDesignationMutationCandidate,
  type SessionOwnershipLeadDesignationMutation,
} from './session-ownership-designation-mutation.js';
export type {
  AdapterSessionClaimDisposition,
  AdapterSessionClaimKey,
  AdapterSessionClaimRecord,
  AdapterSessionClaimStatus,
  AgentSessionOwnershipRecord,
  OwnershipOwnerInstance,
  RuntimeInstanceRecord,
  RuntimeBinding,
  OwnershipMovement,
  SessionOwnershipClaimRequest,
  SessionOwnershipClaimResult,
  SessionOwnershipRecoveryGuard,
  SessionOwnershipRecoveryOwnerGeneration,
  SessionOwnershipRecoveryPreimage,
  SessionOwnershipRecoveryReservation,
  SessionOwnershipRecoveryTerminalAction,
  SessionOwnershipFinalizeRecoveryRequest,
  SessionOwnershipFinalizeRecoveryResult,
  SessionOwnershipListClaimsRequest,
  SessionOwnershipReleaseAgentClaimsRequest,
  SessionOwnershipReleaseAgentClaimsResult,
  SessionOwnershipReleaseRequest,
  SessionOwnershipReleaseResult,
  SessionOwnershipSettleCurrencyRequest,
  SessionOwnershipSettleCurrencyResult,
  SessionOwnershipSettleMovementRequest,
  SessionOwnershipSettleMovementResult,
} from './session-ownership-storage-namespace.js';

// Shared adapter-session currency trias (session row and agent row)
export {
  AdapterSessionCurrencySnapshotSchema,
  AdapterSessionCurrencyTargetSchema,
  resolveResumableAdapterSessionId,
} from './schemas/adapter-session-currency.js';
export type {
  AdapterSessionCurrencySnapshot,
  AdapterSessionCurrencyTarget,
} from './schemas/adapter-session-currency.js';

// Shared caller-facing shape of session-creation subjects (`session.create` and friends)
export { SessionCreateBaseSchema, type SessionCreateBase } from './schemas/crud.js';

// Native session locality contracts
export {
  NativeForkDirectiveSchema,
  NativeLocalityReasonSchema,
  NativeLocalityVerdictSchema,
  type NativeForkDirective,
  type NativeLocalityReason,
  type NativeLocalityVerdict,
} from './native-locality.js';

// Extraction-exclusion metadata contract
export {
  EXTRACTION_EXCLUSION_KEY,
  buildExtractionExclusionMetadata,
  isExtractionExcluded,
  type ExtractionExclusionKey,
  type ExtractionExclusionMetadata,
} from './extraction-exclusion.js';
