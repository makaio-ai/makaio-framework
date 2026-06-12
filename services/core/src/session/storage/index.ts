/**
 * Session storage - bus-based persistence layer.
 *
 * Provides namespace, schemas, and handlers for session CRUD operations.
 */

export { SessionStorageNamespace, SessionStorageSubjects } from './namespace.js';
export { AgentStorageNamespace, AgentStorageSubjects } from './agent-namespace.js';
export { sessions, agents } from './schema.js';
export { registerMemorySessionStorage } from './memory-handler.js';
export { registerDrizzleSessionStorage } from './drizzle-handler.js';
export { registerMemoryAgentStorage } from './agent-memory-handler.js';
export { registerDrizzleAgentStorage } from './agent-drizzle-handler.js';
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
