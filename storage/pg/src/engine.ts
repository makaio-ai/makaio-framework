/**
 * The Postgres storage engine definition.
 *
 * The `'postgres'` literals in this module denote the engine's own identity —
 * they are declarations, not branches over dialects.
 * @packageDocumentation
 */
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { StorageEngine } from '@makaio/storage-drizzle';
import { createNodePgClient } from './client.js';
import { isPostgresDuplicateObjectError, isPostgresUniqueViolationError } from './errors.js';
import { postgresFtsSearchStrategy } from './fts-strategy.js';
import { acquirePostgresMigrationLock, buildPostgresLedgerDdl, POSTGRES_MIGRATION_BEGIN } from './migrations.js';
import { postgresTransactionLocks } from './transaction-locks.js';

/**
 * The Postgres storage engine.
 *
 * Claims `postgres://` and `postgresql://` URLs (case-insensitively,
 * mirroring the engine hint table in `@makaio/storage-drizzle`) and creates
 * clients over the node-postgres driver glue owned by this package (`pg` is
 * a regular dependency, loaded lazily when a client is created). Register it
 * explicitly via `registerStorageEngine` or host boot options; Node runtime hosts
 * additionally auto-register it for recognized database URLs through this
 * package's well-known `storageEngine` export.
 *
 * Migration behavior preserves the cross-version Postgres contracts
 * byte-for-byte (`__makaio_migrations` ledger name and DDL,
 * `BEGIN ISOLATION LEVEL READ COMMITTED`, the advisory-lock key derivation,
 * `__makaio_migrations_<hash>` extension ledgers). The chain directory name
 * `drizzle-postgres` is deliberately distinct from the default `drizzle`
 * directory so embedded-host chain discovery never picks up the Postgres
 * chain.
 */
export const postgresStorageEngine: StorageEngine = {
  dialect: 'postgres',

  matchesUrl: (url) => /^postgres(ql)?:\/\//i.test(url),

  async createClient(config) {
    if (config.url === undefined) {
      throw new Error(
        'postgresStorageEngine: a Postgres connection URL is required to create a client. ' +
          'Pass a postgres:// or postgresql:// URL in config.url — the engine never applies a default URL.',
      );
    }
    return createNodePgClient(config.url, config.postgres);
  },

  errors: {
    isDuplicateObjectError: isPostgresDuplicateObjectError,
    isUniqueViolationError: isPostgresUniqueViolationError,
  },

  capabilities: {
    binaryColumnType: 'bytea',
    maxCounterAssignmentRaces: true,
    async tableExists(executor, tableName) {
      const rows = await executor.all<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${tableName}`,
      );
      return rows.length > 0;
    },
  },

  migrations: {
    defaultLedgerTable: '__makaio_migrations',
    journalDialect: 'postgresql',
    chainDirName: 'drizzle-postgres',
    // The committed chain ships inside this package at <package root>/drizzle-postgres.
    // This resolution holds from src/ (workspace checkout) and from dist/
    // (published flat bundle) alike, because both directories sit one level
    // below the package root.
    resolveSourceChainDir: () => path.resolve(import.meta.dirname, '..', 'drizzle-postgres'),
    buildLedgerDdl: buildPostgresLedgerDdl,
    beginTransactionStatement: POSTGRES_MIGRATION_BEGIN,
    acquireTransactionLock: acquirePostgresMigrationLock,
    extensionLedgerName: (sourceHash) => `__makaio_migrations_${sourceHash}`,
  },

  transactionLocks: postgresTransactionLocks,

  fts: postgresFtsSearchStrategy,
};
