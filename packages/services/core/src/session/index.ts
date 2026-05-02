/**
 * `@makaio/services-core/session`
 *
 * Session management and event persistence layer for Makaio.
 * Consolidates session lifecycle, storage, and event logging.
 */

// Session service
export { MakaioSessionService } from './session-service.js';

// Framework-core session handlers (slim set; host handlers registered separately)
export { registerCoreSessionServiceHandlers } from './session-service-handlers-core.js';

// Session orchestrator (turn lifecycle, message routing)
export { SessionOrchestrator } from './session-orchestrator.js';
export { AdapterRegistry } from './adapter-registry.js';
export { SessionTurnManager, type TurnCompletionResult, type TurnCompleteCallback } from './session-turn-manager.js';
export { TurnContextEnricher } from './turn-context-enricher.js';
// Fallback coordination is host-owned and plugs in through orchestration seams.
// Framework-internal turn helper used by SessionTurnManager and framework-layer orchestrators
export { findTurnByAgent } from './utils/index.js';

// Host/orchestrator helper exports used by higher-level composition roots.
export {
  buildTurnInitiator,
  extractTextContent,
  normalizeToBlocks,
  getOrCreateSession,
  resolveTargetAgents,
  resolveAdapterId,
  ensureAgentCwd,
  ensureAgentModel,
  resolveModelCapabilities,
  verifyAndRecoverAgents,
  buildRecoveryContext,
  buildRecoveryContextWithPipeline,
  recoverAgent,
  resolveExecutionTarget,
  buildProviderContext,
  type RecoveryConfig,
} from './session-orchestrator-helpers.js';

// Optional session handlers used by hosts that opt into richer session operations.
export {
  routeToAgents,
  routeToAgentsCore,
  registerAbandonHandler,
  registerAttachHandler,
  registerCompressHandler,
  registerForkHandler,
  registerMergeHandler,
} from './handlers/index.js';

// Optional lifecycle helpers for host composition.
export {
  registerGetStatusCountsHandler,
  registerResumeHandler,
  registerArchiveHandler,
  registerPurgeHandler,
} from './handlers/lifecycle-handlers.js';
export {
  registerListActionsHandler,
  actionRegistry,
  registerBuiltInActions,
  resetBuiltInActionsRegistration,
} from './session-editor/index.js';
// Workstream/project link resolution is host-owned.
export { normalizeSelectionString, resolveAdapterNameById } from './selection-utils.js';
export { CONNECTOR_SWAP_DEFAULT_PIPELINE } from './constants.js';
// Connector swap warning policy is host-owned.
export { pickFallbackRuntimeOptions, type FallbackRuntimeOptions } from './fallback-runtime-options.js';
export { assembleForkContext } from './context/assemble-fork-context.js';
export {
  createAttachmentArtifacts,
  type AttachmentArtifactInput,
  type AttachmentArtifactMetadata,
  type StoreArtifactFn,
  type StoreArtifactResult,
} from './attachment-artifacts.js';

export type { ISessionOrchestrator } from './session-orchestrator.js';

// Session bridge (agent message persistence)
export { SessionBridge } from './session-bridge.js';
// Extension context (runtime integration point for extensions)
export { SessionExtensionContextImpl, createSessionExtensionContext } from './extension-context.js';

// Session storage (CRUD)
export {
  agents,
  AgentStorageNamespace,
  AgentStorageSubjects,
  fetchAgentsBySession,
  fetchMessageCountsBySession,
  fetchPreviewBySession,
  fetchSessionPreviewMaps,
  mapAgentsBySession,
  mapRowToSession,
  mapToSession,
  parseForkTransforms,
  registerDrizzleAgentStorage,
  registerDrizzleSessionStorage,
  registerFtsSearchHandler,
  registerMemoryAgentStorage,
  registerMemorySessionStorage,
  sessions,
  SessionStorageNamespace,
  SessionStorageSubjects,
} from './storage/index.js';
export type { SearchFilters, SearchSessionRow, SessionPreviewMaps } from './storage/index.js';

// Session event storage (event log)
export {
  registerDrizzleSessionEventStorage,
  registerMemorySessionEventStorage,
  sessionEvents,
  SessionEventStorageNamespace,
  SessionEventStorageSubjects,
} from './session-events/index.js';
export type { InsertSessionEvent, SelectSessionEvent } from './session-events/index.js';

// Loggers
export { SessionLogger, type EventTransform, type SessionLoggerOptions } from './session-logger.js';

// Import cursor storage handlers (for log import)
export { registerDrizzleImportCursorStorage } from './import-cursors/index.js';
export { importCursors } from './import-cursors/schema.js';

// Deliberately no re-export of platform-only session import/snapshot wiring.
// Those handlers moved to dedicated platform packages so this core barrel stays
// runtime-agnostic; callers should import from `@makaio/services/session-import`
// or `@makaio/services/session-snapshot` instead of `services-core/session`.

// Search (FTS5) - schema documented in ./search/schema.ts, no runtime exports
// FTS is handled via raw SQL in handlers

// Embeddings module exists but table excluded from schema (not wired up)

// Normalized message model (Phase 1)
export {
  registerDrizzleTurnStorage,
  registerMemoryTurnStorage,
  turns,
  TurnStorageNamespace,
  TurnStorageSubjects,
} from './turns/index.js';
export type { InsertTurn, SelectTurn } from './turns/index.js';
export {
  messages,
  MessageStorageNamespace,
  MessageStorageSubjects,
  registerDrizzleMessageStorage,
  registerMemoryMessageStorage,
} from './messages/index.js';
export type { InsertMessage, SelectMessage } from './messages/index.js';
export {
  messageRouting,
  MessageRoutingNamespace,
  MessageRoutingSubjects,
  registerDrizzleMessageRoutingStorage,
} from './message-routing/index.js';
export type { InsertMessageRouting, SelectMessageRouting } from './message-routing/index.js';

// Domain entities
export { MakaioSession, Turn } from './entities/index.js';
export type {
  MakaioSessionConfig,
  StartTurnOptions,
  TurnConfig,
  TurnContext,
  TurnResult,
  TurnStateChange,
} from './entities/index.js';

// Adapter session storage (for log import tracking)
export {
  adapterSessions,
  type InsertAdapterSession,
  type SelectAdapterSession,
  AdapterSessionStorageNamespace,
  AdapterSessionStorageSubjects,
  type AdapterSessionRecord,
  type AdapterSessionStatus,
  registerDrizzleAdapterSessionStorage,
  registerSessionDiscoveredHandler,
  registerCreateAndLinkHandler,
  createAndLinkImportedSession,
  type CreateAndLinkParams,
  type CreateAndLinkResult,
  registerParentResolver,
  registerCompressLineageResolver,
  registerSpawningToolCallResolver,
  kindToBranchKind,
} from './adapter-sessions/index.js';

// Context assembly (projection-based conversation reconstruction)
export { buildSessionContext, getFullConversation } from './context/index.js';
export type { BuildContextOptions, ContextAssemblyResult } from './context/index.js';

// Context window tracking (per-session aggregation)
export { ContextWindowTracker } from './context-window/index.js';
export type {
  AgentContextState,
  ContextWindowTrackerConfig,
  SessionContextWindowState,
} from './context-window/index.js';
