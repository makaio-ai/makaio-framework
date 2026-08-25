/**
 * Storage engine contract.
 *
 * A {@link StorageEngine} packages everything dialect-specific behind one
 * seam: client creation, error classification, runtime capabilities, and
 * migration behavior. The built-in SQLite engine ships with this package and
 * is the default engine; additional engines (such as `@makaio/storage-pg`)
 * are installed as separate packages and registered through the engine
 * registry before database initialization.
 * @packageDocumentation
 */
import type { DatabaseClient, DatabaseClientConfig } from '../client';
import type { FtsSearchStrategy } from '../fts/strategy';
import type { RawSqlExecutor, RawSqlSession } from '../raw-sql';
import type { StorageDialect } from '../types';
import type { SQL } from 'drizzle-orm';

/** Stable identity for a transaction-scoped cross-process lock. */
export interface TransactionLock {
  /** Versioned domain that owns the identity format. */
  readonly namespace: string;
  /** Domain-owned stable identity within the lock namespace. */
  readonly identity: string;
}

/** Engine-specific expressions that acquire transaction-scoped stable keys. */
export interface StorageEngineTransactionLocks {
  /**
   * Build transaction-lock expressions for the supplied stable keys.
   *
   * The generic Drizzle seam executes every returned expression sequentially.
   * Engines that serialize these operations without a cross-process primitive
   * return an empty list.
   * @param locks - Stable keys the caller needs for this transaction.
   * @returns Expressions whose evaluation acquires the requested locks.
   */
  lockExpressions(locks: readonly TransactionLock[]): readonly SQL[];
}

/**
 * Dialect-specific classification of database errors.
 *
 * Raw DDL flows (migration adoption, idempotent CREATE) and bounded-retry
 * write paths need to recognize driver failures portably. Each engine owns
 * the knowledge of how its drivers report these conditions.
 */
export interface StorageEngineErrorClassifiers {
  /**
   * Returns `true` when the error (or any link in its cause chain) reports
   * that a schema object (table, index, trigger, …) already exists.
   *
   * Used by the migration applicator to decide whether a failed first CREATE
   * can be adopted into the ledger.
   * @param error - Error thrown by a DDL statement.
   * @returns Whether the failure is a duplicate-schema-object conflict.
   */
  isDuplicateObjectError(error: unknown): boolean;

  /**
   * Returns `true` when the error (or any link in its cause chain) reports a
   * unique-constraint violation.
   *
   * Used by write paths that resolve write-write races through a bounded
   * retry (for example MAX-based counter assignment). The optional
   * `constraint` scope lets callers react to one specific index without
   * swallowing unrelated violations; engines whose drivers do not report
   * constraint names ignore the scope.
   * @param error - Error thrown by a DML statement.
   * @param constraint - Optional constraint/index name to scope the match.
   * @returns Whether the failure is a unique-constraint violation.
   */
  isUniqueViolationError(error: unknown, constraint?: string): boolean;
}

/**
 * Runtime capabilities a consumer can query instead of branching on the
 * dialect identifier.
 */
export interface StorageEngineCapabilities {
  /**
   * SQL column type used for binary payloads in hand-written DDL
   * (for example `'BLOB'` on SQLite, `'bytea'` on Postgres).
   */
  readonly binaryColumnType: string;

  /**
   * Whether concurrent MAX-based counter assignment can race under this
   * engine's default isolation level and therefore needs a bounded
   * unique-violation retry. `false` for engines whose writes serialize at the
   * connection level.
   */
  readonly maxCounterAssignmentRaces: boolean;

  /**
   * Probe the engine's catalog for a table's existence.
   * @param executor - Raw SQL executor of the target database handle.
   * @param tableName - Unqualified table name to probe.
   * @returns `true` when the table exists.
   */
  tableExists(executor: RawSqlExecutor, tableName: string): Promise<boolean>;
}

/**
 * Engine-owned protocol for suspending referential-integrity enforcement
 * around a migration.
 *
 * The statements are executed outside the migration transaction, because an
 * engine that needs this protocol at all is one whose enforcement switch is
 * connection-scoped and inert inside a transaction.
 */
export interface StorageEngineConstraintSuspension {
  /**
   * Returns `true` when a migration's statement stream asks for enforcement to
   * be suspended, so migrations that do not need it keep running with
   * enforcement active.
   * @param statements - The migration's statements, in execution order.
   * @returns Whether the migration requests constraint suspension.
   */
  isRequestedBy(statements: readonly string[]): boolean;

  /** Statement that disables enforcement, run before the transaction opens. */
  readonly suspendStatement: string;

  /** Statement that re-enables enforcement, run after the transaction closes. */
  readonly restoreStatement: string;
}

/**
 * Migration behavior owned by an engine: ledger naming and DDL, journal
 * dialect, chain directory layout, and transaction semantics.
 *
 * The statement texts and naming schemes exposed here are cross-version
 * contracts — runners built from different framework versions must agree on
 * them, otherwise concurrent runs stop serializing against each other or stop
 * recognizing each other's ledgers.
 */
export interface StorageEngineMigrationBehavior {
  /** Default migration ledger table name for this engine. */
  readonly defaultLedgerTable: string;

  /**
   * `dialect` value expected in a migration chain's `_journal.json` for this
   * engine (drizzle-kit vocabulary, e.g. `'sqlite'` or `'postgresql'`).
   */
  readonly journalDialect: string;

  /**
   * Name of the directory holding this engine's bundled migration chain
   * inside a package's distribution artifacts.
   */
  readonly chainDirName: string;

  /**
   * Resolve the absolute source directory of this engine's migration chain.
   *
   * Optional extension point for engines whose chain ships outside the
   * default location implied by {@link chainDirName}; engines that omit it
   * use the caller's default chain discovery.
   * @returns Absolute path to the chain directory.
   */
  resolveSourceChainDir?(): string;

  /**
   * Build the idempotent `CREATE TABLE IF NOT EXISTS` DDL for the migration
   * ledger table. The exact statement text is a cross-version contract pinned
   * by tests.
   * @param tableName - Ledger table name (engine default or caller-provided).
   * @returns Complete DDL statement text.
   */
  buildLedgerDdl(tableName: string): string;

  /**
   * `BEGIN` statement that opens a migration transaction, including any
   * isolation-level pinning the engine's ledger recheck protocol requires.
   */
  readonly beginTransactionStatement: string;

  /**
   * Protocol for migrations that must run without referential-integrity
   * enforcement.
   *
   * Optional: engines whose DDL can restructure a referenced parent table
   * in place omit it. SQLite declares it because its only way to add or drop
   * a table constraint is the documented table rebuild
   * (`CREATE __new_x` → copy → `DROP x` → `RENAME`), and dropping a referenced
   * parent while enforcement is active fires the cascade delete actions
   * declared by its children. Generated rebuild migrations therefore carry a
   * `PRAGMA foreign_keys=OFF` request in their own statement stream, which
   * SQLite silently ignores there because the applicator has already opened a
   * transaction — enforcement pragmas are no-ops inside one. The applicator
   * honors the request by bracketing the whole migration, transaction
   * included, with {@link StorageEngineConstraintSuspension.suspendStatement}
   * and {@link StorageEngineConstraintSuspension.restoreStatement}.
   */
  readonly constraintSuspension?: StorageEngineConstraintSuspension;

  /**
   * Acquire the engine's cross-process migration lock inside an open
   * transaction.
   *
   * Optional: engines whose writes already serialize at the connection level
   * omit it. Presence of this member is the single seam the applicator
   * derives all cross-process locking behavior from (locked ledger snapshot
   * plus in-lock recheck) — there is no separate flag that could disagree.
   * @param session - Pinned raw SQL session with the transaction open.
   * @param ledgerTableName - Ledger table name the lock key is derived from.
   * @returns Resolves once the lock is held for the transaction's lifetime.
   */
  acquireTransactionLock?(session: RawSqlSession, ledgerTableName: string): Promise<void>;

  /**
   * Derive the per-extension migration ledger table name from an extension
   * source hash. The naming scheme is a cross-version contract: ledgers
   * written by one framework version must be found by the next.
   * @param sourceHash - Stable hash identifying the extension's migration source.
   * @returns Ledger table name for that extension.
   */
  extensionLedgerName(sourceHash: string): string;
}

/**
 * Everything dialect-specific about a storage backend, packaged behind one
 * contract.
 *
 * Engines are registered with the engine registry (explicitly via
 * `registerStorageEngine` or through host boot options); the built-in SQLite
 * engine is pre-registered and serves as the default engine for every URL no
 * registered engine claims.
 */
export interface StorageEngine {
  /** Storage dialect this engine serves. */
  readonly dialect: StorageDialect;

  /**
   * Returns `true` when a database URL selects this engine.
   *
   * Optional: the default engine (SQLite) omits it and serves every URL no
   * registered engine claims.
   * @param url - Database URL to test.
   * @returns Whether the URL selects this engine.
   */
  matchesUrl?(url: string): boolean;

  /**
   * Create a database client for this engine.
   * @param config - Database configuration options.
   * @returns Database client with drizzle ORM instance and close method.
   */
  createClient(config: DatabaseClientConfig): Promise<DatabaseClient>;

  /** Dialect-specific error classification. */
  readonly errors: StorageEngineErrorClassifiers;

  /** Runtime capabilities consumers query instead of branching on dialect. */
  readonly capabilities: StorageEngineCapabilities;

  /** Migration ledger, journal, and transaction behavior. */
  readonly migrations: StorageEngineMigrationBehavior;

  /** Transaction-scoped stable-key locking behavior. */
  readonly transactionLocks: StorageEngineTransactionLocks;

  /**
   * Full-text-search provisioning and query operations.
   *
   * Required: every built-in engine implements full-text search for real.
   * Future engines without a search backend ship a refusing strategy rather
   * than omitting the member, so the seam stays uniform for consumers.
   */
  readonly fts: FtsSearchStrategy;
}

/**
 * Quote a SQL identifier (table, column, or index name) for safe inlining
 * into hand-written statement text.
 *
 * Uses double-quote delimiters with embedded double quotes doubled — the
 * standard SQL identifier escaping shared by SQLite and Postgres.
 * @param name - Raw identifier to quote.
 * @returns The quoted identifier, safe to interpolate into SQL text.
 */
export function quoteSqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
