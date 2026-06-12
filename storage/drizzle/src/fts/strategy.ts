/**
 * Full-text-search strategy contract.
 *
 * Full-text search is the most dialect-divergent storage surface: SQLite uses
 * an FTS5 virtual table with bm25 ranking and `snippet()` excerpts, Postgres a
 * stored generated `tsvector` column with `ts_rank` and `ts_headline`. Each
 * {@link FtsSearchStrategy} owns provisioning AND the divergent queries as
 * whole operations — callers never compose dialect-specific SQL fragments.
 *
 * Responsibility split between caller and strategy:
 * - The CALLER owns the empty-query short-circuit (no strategy call for
 *   empty/whitespace queries) and the mapping of returned rows to its
 *   response shapes.
 * - The STRATEGY owns query sanitization and trimming (FTS5 token quoting on
 *   SQLite, `websearch_to_tsquery` parsing on Postgres), match-predicate
 *   construction, ranking, and excerpt generation.
 * @packageDocumentation
 */
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { MakaioDatabase, StorageDialect } from '../types';

/**
 * Input for message-level full-text search operations.
 */
export interface FtsMessageSearchInput {
  /**
   * Raw search query as received from the caller. The strategy owns
   * sanitization/trimming; callers must short-circuit empty/whitespace
   * queries before calling the strategy.
   */
  readonly query: string;

  /** Optional session scope; omitted searches across all sessions. */
  readonly sessionId?: string | undefined;

  /** Maximum number of rows to return (callers apply their own defaults). */
  readonly limit: number;
}

/**
 * One ranked excerpt hit returned by {@link FtsSearchStrategy.searchMessageExcerpts}.
 */
export interface FtsMessageExcerptHit {
  /** Message identifier of the hit. */
  readonly messageId: string;

  /** Session the message belongs to. */
  readonly sessionId: string;

  /**
   * Positive relevance score. Magnitudes are dialect-specific (negated bm25
   * on SQLite, ts_rank on Postgres) — only relative ordering within one
   * result set is meaningful.
   */
  readonly score: number;

  /** Highlighted excerpt with `<mark>…</mark>` around matched terms. */
  readonly excerpt: string;
}

/**
 * Input for session-level full-text search.
 */
export interface FtsSessionSearchInput {
  /**
   * Normalized (trimmed) search query text matched against message content.
   * Callers trim once because the LIKE pattern is derived from the same text.
   */
  readonly query: string;

  /** Lowercased `%query%` pattern for the title LIKE match. */
  readonly likePattern: string;

  /** Maximum number of session rows to return. */
  readonly limit: number;

  /** Optional status filter; `undefined` means "any status". */
  readonly status?: string | undefined;

  /** Optional import-flag filter; `undefined` means "any". */
  readonly isImported?: boolean | undefined;
}

/**
 * Input for counting session-level matches — the search input minus the page
 * window (totals are independent of pagination).
 */
export type FtsSessionCountInput = Omit<FtsSessionSearchInput, 'limit'>;

/**
 * Dialect-owned full-text-search operations.
 *
 * The `messagesTable` parameters are typed as the canonical SQLite face; under
 * Postgres the runtime object is the congruent twin resolved per handle (the
 * same honesty model as `resolveSchema`). Strategies that build raw SQL
 * against fixed physical names accept and ignore the parameter.
 */
export interface FtsSearchStrategy {
  /** Storage dialect this strategy serves. */
  readonly dialect: StorageDialect;

  /**
   * Provision the engine's search index over the `messages` table.
   *
   * Called after central migrations on every boot; implementations must be
   * idempotent. Engines whose index ships through the regular migration chain
   * implement this as a no-op.
   * @param db - Database handle with the central schema already applied.
   */
  provisionSearchIndex(db: MakaioDatabase): Promise<void>;

  /**
   * Search full message rows ranked by relevance.
   * @param db - Database handle to query.
   * @param messagesTable - Resolved messages table of the handle's dialect.
   * @param input - Query text, optional session scope, and page limit.
   * @returns Ranked message rows plus the page-independent total match count.
   * @typeParam TRow - Row shape produced by the messages table (callers pass
   *   their select-row type; the strategy returns rows column-compatible with
   *   the messages table).
   */
  searchMessages<TRow extends Record<string, unknown>>(
    db: MakaioDatabase,
    messagesTable: SQLiteTable,
    input: FtsMessageSearchInput,
  ): Promise<{ rows: TRow[]; total: number }>;

  /**
   * Search messages and return scored `<mark>`-highlighted excerpts instead
   * of full rows.
   * @param db - Database handle to query.
   * @param messagesTable - Resolved messages table of the handle's dialect.
   * @param input - Query text, optional session scope, and page limit.
   * @returns Ranked excerpt hits plus the page-independent total match count.
   */
  searchMessageExcerpts(
    db: MakaioDatabase,
    messagesTable: SQLiteTable,
    input: FtsMessageSearchInput,
  ): Promise<{ results: FtsMessageExcerptHit[]; total: number }>;

  /**
   * Search sessions whose message content matches the query or whose title
   * matches the LIKE pattern, newest activity first.
   * @param db - Database handle to query.
   * @param input - Query text, title pattern, page limit, and optional filters.
   * @returns Matching session rows (snake_case physical column keys).
   * @typeParam TRow - Session row shape expected by the caller.
   */
  searchSessionRows<TRow extends Record<string, unknown>>(
    db: MakaioDatabase,
    input: FtsSessionSearchInput,
  ): Promise<TRow[]>;

  /**
   * Count all sessions matching the query/pattern and filters, without
   * pagination.
   * @param db - Database handle to query.
   * @param input - Query text, title pattern, and optional filters.
   * @returns Total number of unique matching sessions.
   */
  countSessionMatches(db: MakaioDatabase, input: FtsSessionCountInput): Promise<number>;

  /**
   * Resolve the first user message per session as a preview, tie-breaking
   * same-timestamp messages with the engine's deterministic ordering
   * surrogate (rowid on SQLite, message_id on Postgres).
   * @param db - Database handle to query.
   * @param sessionIds - Session IDs to resolve previews for; an empty list
   *   resolves to an empty map without touching the database.
   * @returns First user message text keyed by session ID.
   */
  fetchFirstUserMessagePreviews(db: MakaioDatabase, sessionIds: readonly string[]): Promise<Map<string, string | null>>;
}
