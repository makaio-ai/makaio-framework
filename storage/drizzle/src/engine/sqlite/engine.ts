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
 * Matches the `PRAGMA foreign_keys=OFF` request that generated table-rebuild
 * migrations put at the head of their statement stream.
 *
 * The pragma is inert where it sits — enforcement pragmas are no-ops inside a
 * transaction — so it is read as a declaration that the migration needs
 * enforcement suspended, and the applicator acts on it outside the
 * transaction. Matching is line-anchored because the pragma shares its
 * statement with any leading comment block, and tolerant about spacing and the
 * trailing semicolon because the exact text is generator output, not a pinned
 * contract. A line starting with `--` can never match, so a pragma mentioned
 * in a comment does not request suspension.
 */
const FOREIGN_KEYS_OFF_REQUEST = /^[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=[ \t]*OFF[ \t]*;?[ \t]*$/im;

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
    constraintSuspension: {
      isRequestedBy: (statements) => statements.some((statement) => FOREIGN_KEYS_OFF_REQUEST.test(statement)),
      suspendStatement: 'PRAGMA foreign_keys = OFF',
      restoreStatement: 'PRAGMA foreign_keys = ON',
    },
    extensionLedgerName: (sourceHash) => `__drizzle_migrations_${sourceHash}`,
  },

  transactionLocks: {
    lockExpressions: () => [],
  },

  fts: sqliteFtsSearchStrategy,
};
