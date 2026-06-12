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
export type { MakaioDatabase } from './types';

// Storage dialect brand — attached by the client factory, read via getDatabaseDialect
export { DATABASE_DIALECT, getDatabaseDialect, type StorageDialect } from './types';

// Dialect-portable raw SQL executor — the only sanctioned path for raw statements —
// and the brand/executor attachment used by client factories and test harnesses
export { brandDatabase, getRawSqlExecutor, type RawSqlExecutor, type RawSqlSession } from './raw-sql';

// Bundler-opaque dynamic import — lets runtime hosts load optional engine packages
export { importRuntimeModule } from './import-runtime-module';

// Storage engine seam — contract, global registry, URL hints, and the built-in default engine
export {
  quoteSqlIdentifier,
  type StorageEngine,
  type StorageEngineCapabilities,
  type StorageEngineErrorClassifiers,
  type StorageEngineMigrationBehavior,
} from './engine/types';
export {
  findStorageEngine,
  getStorageEngine,
  registerStorageEngine,
  resolveStorageEngine,
  resolveStorageEngineForUrl,
  type StorageEngineUrlResolution,
} from './engine/registry';
export { describeMissingStorageEngine, STORAGE_ENGINE_URL_HINTS, type StorageEngineUrlHint } from './engine/hints';
export {
  findGenerationLegForDialect,
  NON_BASELINE_GENERATION_LEGS,
  type StorageEngineGenerationLeg,
} from './engine/generation';
export { sqliteStorageEngine } from './engine/sqlite/engine';

// Engine-owned error classification: the SQLite classifiers backing the
// built-in engine, plus the cause-chain inspection helpers engine packages
// build their own classifiers from. Consumers go through StorageEngine.errors.
export { isSqliteDuplicateObjectError, isSqliteUniqueViolationError, readErrorCode, someInCauseChain } from './errors';

export { executeTransaction, type TransactionCallback } from './transaction';

// FTS5 query utilities
export { sanitizeFtsQuery } from './fts/sanitize';

// Engine-owned full-text search: the strategy contract, the shared preview
// query both built-in strategies build on, and the SQLite default strategy
// backing the built-in engine. Consumers go through StorageEngine.fts.
export type {
  FtsMessageExcerptHit,
  FtsMessageSearchInput,
  FtsSearchStrategy,
  FtsSessionCountInput,
  FtsSessionSearchInput,
} from './fts/strategy';
export { buildFirstUserMessagePreviewQuery } from './fts/preview-query';
export { sqliteFtsSearchStrategy } from './engine/sqlite/fts-strategy';

// Cross-driver write-result normalisation
export { didAffectRows, affectedRowCount, type DrizzleWriteResult } from './result';

// Typed registration helper — isolates the single db cast at the Drizzle boundary
export { registerDrizzleHandlers, type DrizzleHandlerRegistration } from './register-handlers';

// Dialect schema variants — twins resolved per handle at registration time
export { defineDialectSchema, resolveSchema, type DialectSchema, type PostgresTwinSchema, type Equal } from './dialect';

// Dual-table factory — one column definition builds both dialect table objects,
// replacing hand-written twin schema files
export {
  defineDualTable,
  type DualColumnBundle,
  type DualColumnBuilderBase,
  type DualBuilder,
  type DualTable,
  type DualTableExtras,
  type DualColumnRef,
  type DualReferenceActions,
} from './dual-table';
