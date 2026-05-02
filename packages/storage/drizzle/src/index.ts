/**
 * \@makaio/storage-drizzle
 *
 * Drizzle ORM extension for storage namespaces.
 *
 * Extends StorageNamespaceExtensions via declaration merging to add
 * type-safe drizzle schema support to storage namespaces.
 * @example
 * ```typescript
 * import { createStorageNamespace } from '@makaio/storage-core';
 * import '@makaio/storage-drizzle'; // Enables drizzle extension
 * import { sessionsTable, sessionAgentsTable } from './schema';
 *
 * const SessionStorage = createStorageNamespace('session', {
 *   schemas: { ... },
 *   extensions: {
 *     drizzle: {
 *       sessions: sessionsTable,
 *       sessionAgents: sessionAgentsTable,
 *     },
 *   },
 * });
 *
 * // Type-safe access to drizzle schemas
 * const { sessions, sessionAgents } = SessionStorage.extensions.drizzle;
 * ```
 * @packageDocumentation
 */

import type { Table } from 'drizzle-orm';

/**
 * Drizzle schema record type.
 * Maps table names to Drizzle table definitions.
 */
export type DrizzleSchemaRecord = Record<string, Table>;

// Declaration merging to extend StorageNamespaceExtensions
declare module '@makaio/storage-core' {
  interface StorageNamespaceExtensions {
    /**
     * Drizzle ORM table schemas for this storage domain.
     * Contains table definitions that can be used by Drizzle-based storage services.
     */
    drizzle?: DrizzleSchemaRecord;
  }
}

// Re-export core types for convenience
export type { StorageNamespace, StorageNamespaceConfig, StorageNamespaceExtensions } from '@makaio/storage-core';
export { createStorageNamespace } from '@makaio/storage-core';

// Canonical database type alias — import MakaioDatabase from here, not from drizzle-orm/libsql
export type { MakaioDatabase } from './types.js';

export { executeTransaction, type TransactionCallback } from './transaction.js';

// FTS5 query utilities
export { sanitizeFtsQuery } from './fts.js';

// Typed registration helper — isolates the single db cast at the Drizzle boundary
export { registerDrizzleHandlers, type DrizzleHandlerRegistration } from './register-handlers.js';
