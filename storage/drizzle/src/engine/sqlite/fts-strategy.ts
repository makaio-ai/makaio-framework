/**
 * Built-in SQLite full-text-search strategy.
 *
 * SQLite full-text search runs over an FTS5 virtual table (`messages_fts`)
 * kept in sync with `messages` by triggers; Drizzle cannot declare virtual
 * tables, so this strategy provisions them at boot. All queries are raw SQL
 * against the fixed physical names — the `messagesTable` parameters of the
 * strategy contract are accepted and unused because every query joins
 * `messages_fts` to `messages` by rowid rather than going through the table
 * object.
 * @packageDocumentation
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { buildFirstUserMessagePreviewQuery } from '../../fts/preview-query';
import { sanitizeFtsQuery } from '../../fts/sanitize';
import type {
  FtsMessageExcerptHit,
  FtsMessageSearchInput,
  FtsSearchStrategy,
  FtsSessionCountInput,
  FtsSessionSearchInput,
} from '../../fts/strategy';
import { getRawSqlExecutor } from '../../raw-sql';
import type { MakaioDatabase } from '../../types';

/**
 * Row shape returned by the FTS5 excerpt queries (physical column names).
 */
type MessageFtsRow = {
  message_id: string;
  session_id: string;
  score: number;
  excerpt: string;
};

/**
 * Builds SQL predicates for optional session-search filters.
 *
 * SQLite stores booleans as integers, so the import filter compares 0/1
 * literals.
 * @param input - Optional status/import filters from the search input.
 * @returns SQL fragment appended to WHERE clauses.
 */
function buildSearchFilterSql(input: FtsSessionCountInput): SQL {
  const conditions: SQL[] = [];
  if (input.status !== undefined) {
    conditions.push(sql`s.status = ${input.status}`);
  }
  if (input.isImported !== undefined) {
    conditions.push(input.isImported ? sql`s.is_imported = 1` : sql`COALESCE(s.is_imported, 0) = 0`);
  }
  if (conditions.length === 0) {
    return sql``;
  }
  return sql` AND ${sql.join(conditions, sql` AND `)}`;
}

/**
 * Executes a BM25-ranked FTS5 search over messages.
 *
 * Supports optional scoping by `sessionId` (direct FTS column).
 * @param db - Drizzle database instance
 * @param sanitized - Already-sanitized FTS5 query string
 * @param limit - Maximum number of rows to return
 * @param sessionId - Optional session scope filter
 * @returns Ranked message FTS rows
 */
async function fetchFtsRows(
  db: MakaioDatabase,
  sanitized: string,
  limit: number,
  sessionId: string | undefined,
): Promise<MessageFtsRow[]> {
  const SELECT_COLS = sql`
    m.message_id AS message_id,
    fts.session_id AS session_id,
    -bm25(messages_fts) AS score,
    snippet(messages_fts, 1, '<mark>', '</mark>', '...', 40) AS excerpt
  FROM messages_fts fts
  JOIN messages m ON m.rowid = fts.rowid`;

  const rawSql = getRawSqlExecutor(db);
  if (sessionId !== undefined) {
    return rawSql.all<MessageFtsRow>(sql`
      SELECT ${SELECT_COLS}
      WHERE messages_fts MATCH ${sanitized}
        AND fts.session_id = ${sessionId}
      ORDER BY score DESC
      LIMIT ${limit}
    `);
  }
  return rawSql.all<MessageFtsRow>(sql`
    SELECT ${SELECT_COLS}
    WHERE messages_fts MATCH ${sanitized}
    ORDER BY score DESC
    LIMIT ${limit}
  `);
}

/**
 * Counts total FTS5 matches for a query, with optional scoping.
 * @param db - Drizzle database instance
 * @param sanitized - Already-sanitized FTS5 query string
 * @param sessionId - Optional session scope filter
 * @returns Total number of matching rows
 */
async function fetchFtsTotal(db: MakaioDatabase, sanitized: string, sessionId: string | undefined): Promise<number> {
  const rawSql = getRawSqlExecutor(db);
  const countRow = await (sessionId !== undefined
    ? rawSql.all<{ total: number }>(sql`
        SELECT COUNT(*) AS total
        FROM messages_fts
        WHERE messages_fts MATCH ${sanitized}
          AND session_id = ${sessionId}
      `)
    : rawSql.all<{ total: number }>(sql`
        SELECT COUNT(*) AS total
        FROM messages_fts
        WHERE messages_fts MATCH ${sanitized}
      `));
  return countRow[0]?.total ?? 0;
}

/**
 * The built-in SQLite FTS strategy: FTS5 provisioning, bm25-ranked message
 * search, `snippet()` excerpts, and session search over `messages_fts`.
 */
export const sqliteFtsSearchStrategy: FtsSearchStrategy = {
  dialect: 'sqlite',

  async provisionSearchIndex(db) {
    const rawSql = getRawSqlExecutor(db);

    // Content-backed FTS5 table — SQLite validates the backing table at CREATE time.
    await rawSql.run(sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id,
        content_text,
        content='messages',
        content_rowid='rowid',
        tokenize='porter unicode61'
      )
    `);

    // Triggers for FTS5 sync with messages table
    await rawSql.run(sql`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, session_id, content_text)
        VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
      END
    `);

    await rawSql.run(sql`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
        VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
      END
    `);

    await rawSql.run(sql`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
        VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
        INSERT INTO messages_fts(rowid, session_id, content_text)
        VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
      END
    `);

    // Unconditional by design: rebuilding repairs drift from older boots that
    // ran before the sync triggers existed. A count-based skip would preserve a
    // stale or corrupted FTS index.
    await rawSql.run(sql`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
  },

  async searchMessages<TRow extends Record<string, unknown>>(
    db: MakaioDatabase,
    _messagesTable: SQLiteTable,
    input: FtsMessageSearchInput,
  ): Promise<{ rows: TRow[]; total: number }> {
    const { sessionId, limit } = input;
    const sanitized = sanitizeFtsQuery(input.query);

    // Use FTS5 content-backed table (joins via rowid, order by bm25 relevance).
    // Columns are aliased to camelCase to match the canonical select-row shape.
    const SELECT_ALIASED = sql`
      m.message_id       AS messageId,
      m.turn_id          AS turnId,
      m.session_id       AS sessionId,
      m.role             AS role,
      m.content_text     AS contentText,
      m.blocks           AS blocks,
      m.agent_id         AS agentId,
      m.adapter_session_id AS adapterSessionId,
      m.adapter_message_id AS adapterMessageId,
      m.timestamp        AS timestamp,
      m.edit_of          AS editOf,
      m.origin           AS origin
    `;

    const ftsQuery = sessionId
      ? sql`
          SELECT ${SELECT_ALIASED}
          FROM messages m
          JOIN messages_fts fts ON m.rowid = fts.rowid
          WHERE messages_fts MATCH ${sanitized}
          AND fts.session_id = ${sessionId}
          ORDER BY bm25(messages_fts)
          LIMIT ${limit}
        `
      : sql`
          SELECT ${SELECT_ALIASED}
          FROM messages m
          JOIN messages_fts fts ON m.rowid = fts.rowid
          WHERE messages_fts MATCH ${sanitized}
          ORDER BY bm25(messages_fts)
          LIMIT ${limit}
        `;

    const rawSql = getRawSqlExecutor(db);
    const rows = await rawSql.all<TRow>(ftsQuery);

    // Get total count
    const countQuery = sessionId
      ? sql`
          SELECT COUNT(*) as count FROM messages_fts
          WHERE messages_fts MATCH ${sanitized}
          AND session_id = ${sessionId}
        `
      : sql`
          SELECT COUNT(*) as count FROM messages_fts
          WHERE messages_fts MATCH ${sanitized}
        `;

    const [countRow] = await rawSql.all<{ count: number }>(countQuery);

    return { rows, total: countRow?.count ?? 0 };
  },

  async searchMessageExcerpts(db, _messagesTable, input) {
    const sanitized = sanitizeFtsQuery(input.query);
    const [rows, total] = await Promise.all([
      fetchFtsRows(db, sanitized, input.limit, input.sessionId),
      fetchFtsTotal(db, sanitized, input.sessionId),
    ]);

    const results: FtsMessageExcerptHit[] = rows.map((row) => ({
      messageId: row.message_id,
      sessionId: row.session_id,
      score: row.score,
      excerpt: row.excerpt,
    }));
    return { results, total };
  },

  async searchSessionRows<TRow extends Record<string, unknown>>(
    db: MakaioDatabase,
    input: FtsSessionSearchInput,
  ): Promise<TRow[]> {
    const filterClause = buildSearchFilterSql(input);

    return getRawSqlExecutor(db).all<TRow>(sql`
      SELECT DISTINCT
        s.session_id,
        s.created_at,
        s.last_activity_at,
        s.status,
        s.title,
        s.lead_agent_id,
        s.parent_session_id,
        s.root_session_id,
        s.fork_point_message_id,
        s.branch_kind,
        s.adapter_name,
        s.adapter_session_id,
        s.adapter_id,
        s.is_orchestrated,
        s.is_imported,
        s.summary,
        s.summary_updated_at,
        s.fork_transforms,
        s.target_working_directory
      FROM sessions s
      WHERE (
        s.session_id IN (
          SELECT session_id FROM messages_fts
          WHERE messages_fts MATCH ${input.query}
        )
        OR LOWER(s.title) LIKE ${input.likePattern}
      )
      ${filterClause}
      ORDER BY s.last_activity_at DESC
      LIMIT ${input.limit}
    `);
  },

  async countSessionMatches(db, input) {
    const filterClause = buildSearchFilterSql(input);

    const [totalRow] = await getRawSqlExecutor(db).all<{ total: number }>(sql`
      SELECT COUNT(DISTINCT s.session_id) as total
      FROM sessions s
      WHERE (
        s.session_id IN (
          SELECT session_id FROM messages_fts
          WHERE messages_fts MATCH ${input.query}
        )
        OR LOWER(s.title) LIKE ${input.likePattern}
      )
      ${filterClause}
    `);
    return totalRow?.total ?? 0;
  },

  async fetchFirstUserMessagePreviews(db, sessionIds) {
    if (sessionIds.length === 0) {
      return new Map<string, string | null>();
    }

    // Tie-break same-timestamp messages deterministically: rowid is a physical
    // insertion-order surrogate available on every SQLite table.
    const previewRows = await getRawSqlExecutor(db).all<{ sessionId: string; preview: string | null }>(
      buildFirstUserMessagePreviewQuery(sessionIds, sql`m2.rowid < m.rowid`),
    );

    const previewBySession = new Map<string, string | null>();
    for (const row of previewRows) {
      previewBySession.set(row.sessionId, row.preview);
    }
    return previewBySession;
  },
};
