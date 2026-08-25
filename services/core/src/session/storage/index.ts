/**
 * Session storage - bus-based persistence layer.
 *
 * Provides namespace, schemas, and handlers for session CRUD operations.
 */

export { SessionStorageNamespace, SessionStorageSubjects } from './namespace.js';
export { AgentStorageNamespace, AgentStorageSubjects } from './agent-namespace.js';
export {
  sessions,
  sessionsDual,
  agents,
  agentsDual,
  adapterSessionClaims,
  adapterSessionClaimsDual,
} from './schema.js';
export { registerMemorySessionStorage } from './memory-handler.js';
export { registerDrizzleSessionStorage } from './drizzle-handler.js';
export { registerMemoryAgentStorage } from './agent-memory-handler.js';
export { registerDrizzleAgentStorage } from './agent-drizzle-handler.js';
export { registerMemorySessionOwnershipStorage } from './ownership-memory-handler.js';
// The shared in-memory backing store: a host wiring the three memory session
// handlers must hand them one state instance, or they see disconnected rows.
// `deleteClaimsWhere` stays internal — it is the handlers' cascade, not an API.
export { createSessionStorageMemoryState, type SessionStorageMemoryState } from './memory-store.js';
export { registerDrizzleSessionOwnershipStorage } from './ownership-drizzle-handler.js';
// Stable claim-key identities are public so storage conformance can verify the
// engine lock protocol without coupling to mutable claim-row implementation.
export {
  ownershipClaimTransactionLock,
  SESSION_OWNERSHIP_CLAIM_LOCK_NAMESPACE,
  type OwnershipClaimKey,
} from './ownership-drizzle-claim-keys.js';
export { registerFtsSearchHandler } from './fts-search-handler.js';
export {
  fetchAgentsBySession,
  fetchPreviewBySession,
  fetchMessageCountsBySession,
  mapRowToSession,
  parseForkTransforms,
  type SearchSessionRow,
  type SearchFilters,
} from './fts-search-utils.js';
export { mapToSession, mapAgentsBySession, fetchSessionPreviewMaps, type SessionPreviewMaps } from './drizzle-utils.js';
export { getSessionAncestorChain } from './ancestor-query.js';
