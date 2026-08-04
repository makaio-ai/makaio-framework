import type { SchemaRecord } from '@makaio/core';
import { LifecycleSchemas } from './schemas/lifecycle-events.js';
import { OrchestratorSchemas } from './schemas/orchestrator.js';
import { CrudSchemas } from './schemas/crud.js';
import { EventSchemas } from './schemas/events.js';
import { SnapshotSchemas } from './schemas/snapshot.js';
import { ResolveAgentConfigSchema } from './schemas/resolve-agent-config.js';
import { ResolveSystemPromptSchema } from './schemas/resolve-system-prompt.js';
import { SessionEnrichmentSchemas } from './schemas/enrichment.js';

export type { RestartAgentsRequest, RestartAgentsResponse, RestartAgentsResult } from './schemas/crud.js';

// Entity schemas
export { AgentStatusSchema, MakaioSessionAgentSchema } from './schemas/agent.js';
export type { AgentStatus, MakaioSessionAgent } from './schemas/agent.js';
export {
  MakaioSessionSchema,
  SessionRecordMetadataSchema,
  SessionPreviewDataSchema,
  SessionWithPreviewSchema,
} from './schemas/session.js';
export type {
  MakaioSession,
  SessionPreviewData,
  SessionRecordMetadata,
  SessionWithPreview,
} from './schemas/session.js';

// Snapshot schemas and helpers
export {
  safeValidateSnapshot,
  SessionSnapshotSchema,
  SNAPSHOT_VERSION,
  SnapshotExportOptionsSchema,
  SnapshotSchemas,
  validateSnapshot,
} from './schemas/snapshot.js';
export type {
  SessionSnapshot,
  SnapshotExportOptions,
  SnapshotImportConflictErrorData,
  SnapshotPreviewData,
} from './schemas/snapshot.js';

// Persisted session event envelope schemas live in event.ts. EventSchemas from
// events.ts is the bus-subject schema map and intentionally remains separate.
export {
  MakaioSessionEventSchema,
  SESSION_EVENT_TYPES,
  SessionEventEnvelopeSchema,
  SessionEventTypeSchema,
  withSessionId,
} from './schemas/event.js';
export type { SessionEventPayload, SessionEventType, SessionEventTypeMap } from './schemas/event.js';
export { ForkChildInfoSchema } from './schemas/fork-child-info.js';
export type { ForkChildInfo } from './schemas/fork-child-info.js';
export {
  AbandonedEventSchema,
  AbandonRequestSchema,
  AbandonResponseSchema,
  BranchCreatedEventSchema,
  BranchMergedEventSchema,
  ChildCompletedEventSchema,
  CompressionRequestedEventSchema,
  CompressRequestSchema,
  CompressResponseSchema,
  ForkedEventSchema,
  ForkingEventSchema,
  ForkTransformsSchema,
  GetChildrenRequestSchema,
  GetChildrenResponseSchema,
  LifecycleSchemas,
  MergedEventSchema,
  MergeRequestSchema,
  MergeResponseSchema,
  MergingEventSchema,
  SegmentPolicySchema,
  SessionCreatedEventSchema,
  SessionUpdatedEventSchema,
  SquashEventSchema,
} from './schemas/lifecycle-events.js';
export type {
  AbandonedEvent,
  AbandonRequest,
  AbandonResponse,
  BranchCreatedEvent,
  BranchMergedEvent,
  ChildCompletedEvent,
  CompressionRequestedEvent,
  CompressRequest,
  CompressResponse,
  ForkedEvent,
  ForkingEvent,
  ForkTransforms,
  GetChildrenRequest,
  GetChildrenResponse,
  MergedEvent,
  MergeRequest,
  MergeResponse,
  MergingEvent,
  SegmentPolicy,
  SessionCreated,
  SessionUpdatedEvent,
  SquashEvent,
} from './schemas/lifecycle-events.js';
export {
  MessageRoutingSchema,
  MessageRoutingStatusSchema,
  SessionMessageBlockSchema,
  SessionMessageOriginSchema,
  SessionMessageRoleSchema,
  SessionMessageSchema,
  TurnInitiatorSchema,
  TurnSchema,
  TurnStatusSchema,
  TurnUsageSchema,
  UsageMetricsSchema,
} from './schemas/message.js';
export type {
  MessageRouting,
  MessageRoutingStatus,
  SessionMessage,
  SessionMessageBlock,
  SessionMessageOrigin,
  SessionMessageRole,
  Turn,
  TurnInitiator,
  TurnStatus,
  TurnUsage,
  UsageMetrics,
} from './schemas/message.js';
export { OrchestratorSchemas, TurnIngestionMarkerSchema } from './schemas/orchestrator.js';
export type {
  AgentAttachRequest,
  AgentAttachResolvedRequest,
  AgentAttachResolvedResponse,
  AgentAttachResponse,
  SendMessageRequest,
  SendMessageResponse,
  SessionForkRequest,
  SessionForkResponse,
  TurnAwaitRequest,
  TurnAwaitResponse,
  TurnCompleted,
  TurnIngestionMarker,
  TurnStarted,
  UserMessageAcknowledged,
  UserMessageCompleted,
  UserMessageSent,
} from './schemas/orchestrator.js';
export { AdapterSessionCurrencyStateSchema, AgentRoleSchema, BranchKindSchema } from './schemas/primitives.js';
export type { AdapterSessionCurrencyState, AgentRole, BranchKind } from './schemas/primitives.js';

/**
 * Session domain schemas.
 *
 * Subjects for session lifecycle management via bus communication.
 * Each key becomes a subject identifier as: `session.{key}`
 * @example
 * ```typescript
 * // Create a new session
 * const { sessionId } = await bus.request(SessionSubjects.create, {});
 *
 * // List active sessions
 * const { sessions } = await bus.request(SessionSubjects.list, { status: 'active' });
 *
 * // Get session details
 * const session = await bus.request(SessionSubjects.get, { sessionId });
 *
 * // Close a session
 * await bus.request(SessionSubjects.close, { sessionId });
 * ```
 */
export const SessionSchemas = {
  ...CrudSchemas,
  ...EventSchemas,
  ...SnapshotSchemas,
  ...LifecycleSchemas,
  ...OrchestratorSchemas,
  ...ResolveAgentConfigSchema,
  ...ResolveSystemPromptSchema,
  ...SessionEnrichmentSchemas,
} satisfies SchemaRecord;
