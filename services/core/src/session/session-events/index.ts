/**
 * Session event storage - bus-based persistence layer for session events.
 *
 * Provides namespace, schemas, and handlers for event append/query operations.
 */

export { SessionEventStorageNamespace, SessionEventStorageSubjects } from './namespace.js';
export { sessionEvents, sessionEventsDual, type InsertSessionEvent, type SelectSessionEvent } from './schema.js';
export { registerMemorySessionEventStorage } from './memory-handler.js';
export { registerDrizzleSessionEventStorage } from './drizzle-handler.js';
