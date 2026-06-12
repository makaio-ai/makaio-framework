/**
 * \@makaio/storage-pg
 *
 * Postgres storage engine for the Makaio framework: driver glue, error
 * classification, and migration behavior packaged behind the storage engine
 * seam of `@makaio/storage-drizzle`.
 *
 * Hosts register the engine explicitly (boot `database.engines` option or
 * `registerStorageEngine`); Node runtime hosts additionally auto-resolve this
 * package for recognized `postgres://` / `postgresql://` URLs through the
 * well-known {@link storageEngine} export.
 * @packageDocumentation
 */

export { postgresStorageEngine } from './engine.js';
export { isPostgresDuplicateObjectError, isPostgresUniqueViolationError } from './errors.js';
export { postgresFtsSearchStrategy } from './fts-strategy.js';
export { buildPostgresLedgerDdl, migrationAdvisoryLockKey, POSTGRES_MIGRATION_BEGIN } from './migrations.js';

import { postgresStorageEngine } from './engine.js';

/**
 * Well-known engine export consumed by host URL auto-resolve: runtime hosts
 * that recognize a Postgres database URL import this package and register
 * `storageEngine` with the engine registry. Same object as
 * {@link postgresStorageEngine}.
 */
export const storageEngine = postgresStorageEngine;
