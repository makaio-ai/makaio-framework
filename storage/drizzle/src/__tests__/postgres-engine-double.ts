/**
 * Shared structurally complete Postgres engine double for registry and
 * client-factory tests.
 *
 * Every required {@link StorageEngine} member is present, so the double is
 * compile-checked against contract growth in one place, but all
 * behavior-bearing members refuse — tests that need a live member (for
 * example a recording `createClient`) pass it as an override. This is NOT the
 * real engine: suites that exercise real Postgres behavior import
 * `@makaio/storage-pg` instead.
 */
import type { StorageEngine } from '../engine/types';

/**
 * Build a minimal but structurally complete postgres engine double claiming
 * `postgres://` / `postgresql://` URLs (mirroring the core hint table).
 * @param overrides - Members to replace on the fresh double (for example a
 *   recording `createClient`).
 * @returns A fresh engine object; every call returns a distinct reference.
 */
export function buildPostgresEngineDouble(
  overrides: Partial<Pick<StorageEngine, 'createClient' | 'matchesUrl'>> = {},
): StorageEngine {
  return {
    dialect: 'postgres',
    matchesUrl: (url) => /^postgres(ql)?:\/\//i.test(url),
    createClient: () => Promise.reject(new Error('test engine does not create clients')),
    errors: {
      isDuplicateObjectError: () => false,
      isUniqueViolationError: () => false,
    },
    capabilities: {
      binaryColumnType: 'bytea',
      maxCounterAssignmentRaces: true,
      tableExists: () => Promise.resolve(false),
    },
    migrations: {
      defaultLedgerTable: '__makaio_migrations',
      journalDialect: 'postgresql',
      chainDirName: 'drizzle-postgres',
      buildLedgerDdl: (tableName) => `CREATE TABLE IF NOT EXISTS "${tableName}" (hash text)`,
      beginTransactionStatement: 'BEGIN',
      extensionLedgerName: (sourceHash) => `__makaio_migrations_${sourceHash}`,
    },
    transactionLocks: {
      lockExpressions: () => [],
    },
    fts: {
      dialect: 'postgres',
      provisionSearchIndex: () => Promise.resolve(),
      searchMessages: () => Promise.reject(new Error('test engine does not search')),
      searchMessageExcerpts: () => Promise.reject(new Error('test engine does not search')),
      searchSessionRows: () => Promise.reject(new Error('test engine does not search')),
      countSessionMatches: () => Promise.reject(new Error('test engine does not search')),
      fetchFirstUserMessagePreviews: () => Promise.reject(new Error('test engine does not search')),
    },
    ...overrides,
  };
}
