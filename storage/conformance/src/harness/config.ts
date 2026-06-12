/**
 * Conformance harness database context types.
 *
 * Defines the contracts for provisioning per-suite isolated databases and
 * creating additional independent clients over the same isolation unit.
 * @packageDocumentation
 */
import type { MakaioDatabase, RawSqlExecutor, StorageDialect } from '@makaio/storage-drizzle';

/**
 * Capability flags of a dialect config.
 *
 * Used to gate capability-dependent test cases without hard-coding dialect names
 * inside suite bodies.
 */
export interface StorageConformanceCapabilities {
  /**
   * True when the three full-text-search subjects are served for real on this dialect.
   * Both built-in configs declare `true`: SQLite via the FTS5 virtual table,
   * Postgres via the `messages.content_tsv` stored generated tsvector column.
   */
  readonly fts: boolean;
}

/**
 * Options for additional clients over the same isolated database/schema.
 */
export interface SiblingClientOptions {
  /**
   * Postgres only: pool size for the sibling client. Default 4. Ignored on sqlite.
   */
  readonly poolMax?: number;
  /**
   * Postgres only: extra `-c name=value` startup settings applied to every pooled
   * connection of the sibling. `search_path` is reserved — the harness always pins
   * it to the context's isolation schema. Ignored on sqlite.
   */
  readonly postgresSettings?: Readonly<Record<string, string>>;
}

/**
 * Independent client over the context's isolated database/schema (simulates a second process).
 */
export interface SiblingClient {
  /** Branded database handle. */
  readonly db: MakaioDatabase;
  /** Raw SQL executor attached to {@link SiblingClient.db}. */
  readonly executor: RawSqlExecutor;
  /** Close this sibling's own connection/pool. Idempotent. */
  close(): Promise<void>;
}

/**
 * Per-suite isolated database with lifecycle. Create in beforeAll, cleanup in afterAll.
 */
export interface StorageDatabaseContext {
  /** Branded handle over the isolated database (sqlite temp file / pg schema with search_path pinned). */
  readonly db: MakaioDatabase;
  /** Dialect of the handle; matches the active config. */
  readonly dialect: StorageDialect;
  /** Capability flags of the active config. */
  readonly capabilities: StorageConformanceCapabilities;
  /** Raw SQL executor attached to {@link StorageDatabaseContext.db} (getRawSqlExecutor(db)). */
  readonly executor: RawSqlExecutor;
  /**
   * Create an additional independent client over the SAME isolated database/schema.
   * sqlite: second client on the same temp file URL. postgres: second pool on the same
   * URL including the schema's search_path options plus the sibling's extra settings.
   * Tracked by the context; cleanup() closes any not yet closed.
   * @param options - Pool size / startup settings for the sibling.
   */
  createSiblingClient(options?: SiblingClientOptions): Promise<SiblingClient>;
  /**
   * Close all clients, then destroy the isolation unit (unlink temp db files /
   * DROP SCHEMA ... CASCADE via a short-lived admin client). Per-resource close
   * failures are collected instead of aborting teardown, so the isolation-unit
   * destruction always gets its attempt; collected failures are rethrown after
   * cleanup completes (a single failure as-is, several as an AggregateError).
   * Missing-file unlink errors are swallowed.
   */
  cleanup(): Promise<void>;
}

/**
 * Options for provisioning a context.
 */
export interface CreateDatabaseContextOptions {
  /**
   * Apply the dialect's central migration chain before returning. Default true.
   * Migration-runner suites pass false and drive applyMigrations themselves.
   */
  readonly applyCentralChain?: boolean;
  /**
   * Postgres only: pool size of the primary client. Default 4.
   */
  readonly poolMax?: number;
  /**
   * Postgres only: extra `-c name=value` startup settings for every pooled connection
   * (e.g. `{ default_transaction_isolation: 'repeatable read' }`, `{ statement_timeout: '500' }`).
   * `search_path` is reserved — the harness always pins it to the context's isolation
   * schema. Spaces in values are backslash-escaped by the harness.
   */
  readonly postgresSettings?: Readonly<Record<string, string>>;
}

/**
 * One dialect implementation of the conformance contract.
 */
export interface StorageConformanceConfig {
  /** Config name used in describe titles: 'sqlite' | 'postgres'. */
  readonly name: string;
  /** Dialect this config provisions. */
  readonly dialect: StorageDialect;
  /** Capability flags used to gate capability-dependent cases. */
  readonly capabilities: StorageConformanceCapabilities;
  /**
   * Provision a FRESH isolated database for one suite.
   * sqlite: new temp-file db via createDatabaseClient(`file:...`).
   * postgres: CREATE SCHEMA `conformance_` plus 12 lowercase hex chars from
   * randomUUID on MAKAIO_STORAGE_TEST_URL via a short-lived admin client, then
   * a client whose connection string carries `options=-c search_path=...` so
   * every pooled connection lands in the schema. Central chain applied unless
   * opted out.
   * @param options - Provisioning options.
   */
  createDatabaseContext(options?: CreateDatabaseContextOptions): Promise<StorageDatabaseContext>;
}
