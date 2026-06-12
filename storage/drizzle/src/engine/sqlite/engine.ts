/**
 * Built-in SQLite storage engine.
 *
 * The `'sqlite'` literals in this module denote the engine's own identity —
 * they are declarations, not branches over dialects.
 * @packageDocumentation
 */
import { sql } from 'drizzle-orm';
import { isSqliteDuplicateObjectError, isSqliteUniqueViolationError } from '../../errors';
import { quoteSqlIdentifier, type StorageEngine } from '../types';
import { createSqliteClient } from './client';
import { sqliteFtsSearchStrategy } from './fts-strategy';

/**
 * The built-in SQLite engine.
 *
 * This is the default engine: it deliberately omits {@link StorageEngine.matchesUrl}
 * and serves every database URL no registered engine claims (local `file:`
 * and `:memory:` databases as well as remote libSQL/Turso connections).
 *
 * Migration behavior keeps Drizzle's historical SQLite contracts byte-for-byte
 * (`__drizzle_migrations` ledger name and DDL shape, bare `BEGIN`,
 * `__drizzle_migrations_<hash>` extension ledgers) so existing ledgers keep
 * matching across framework versions. No `acquireTransactionLock`: SQLite
 * writes serialize at the connection level, so the migration applicator needs
 * no cross-process lock protocol here.
 */
export const sqliteStorageEngine: StorageEngine = {
  dialect: 'sqlite',

  createClient: createSqliteClient,

  errors: {
    isDuplicateObjectError: isSqliteDuplicateObjectError,
    // SQLite errors carry the violated column list, not constraint names —
    // the optional scope only narrows matches on engines that report names.
    isUniqueViolationError: (error, _constraint) => isSqliteUniqueViolationError(error),
  },

  capabilities: {
    binaryColumnType: 'BLOB',
    maxCounterAssignmentRaces: false,
    async tableExists(executor, tableName) {
      const rows = await executor.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${tableName}`,
      );
      return rows.length > 0;
    },
  },

  migrations: {
    defaultLedgerTable: '__drizzle_migrations',
    journalDialect: 'sqlite',
    chainDirName: 'drizzle',
    buildLedgerDdl(tableName) {
      return `CREATE TABLE IF NOT EXISTS ${quoteSqlIdentifier(tableName)} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at numeric
    )`;
    },
    beginTransactionStatement: 'BEGIN',
    extensionLedgerName: (sourceHash) => `__drizzle_migrations_${sourceHash}`,
  },

  fts: sqliteFtsSearchStrategy,
};
