/**
 * Postgres full-text-search strategy.
 *
 * Postgres full-text search runs over the `messages.content_tsv` stored
 * generated tsvector column (english regconfig) and its GIN index — both ship
 * through the central Postgres migration chain, so provisioning here is a
 * no-op. Message search operates on the messages table object passed in by
 * the caller (the congruent twin resolved per handle); session search and the
 * preview query are raw SQL against the fixed physical names.
 * @packageDocumentation
 */
import { and, asc, count, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  buildFirstUserMessagePreviewQuery,
  getRawSqlExecutor,
  type FtsMessageExcerptHit,
  type FtsMessageSearchInput,
  type FtsSearchStrategy,
  type FtsSessionCountInput,
  type FtsSessionSearchInput,
  type MakaioDatabase,
} from '@makaio/storage-drizzle';

/**
 * Columns of the messages table the Postgres message-search queries reference
 * through the query builder.
 */
interface MessageSearchColumns {
  /** `message_id` column. */
  readonly messageId: SQLiteColumn;
  /** `session_id` column. */
  readonly sessionId: SQLiteColumn;
  /** `timestamp` column. */
  readonly timestamp: SQLiteColumn;
}

/**
 * Resolve one required column from a table's column map.
 * @param columns - Column map produced by `getTableColumns`.
 * @param name - Property name of the required column.
 * @returns The resolved column.
 * @throws Error naming the missing column.
 */
function requireColumn(columns: Record<string, SQLiteColumn>, name: string): SQLiteColumn {
  const column: SQLiteColumn | undefined = columns[name];
  if (column === undefined) {
    throw new Error(`postgresFtsSearchStrategy: the messages table passed in is missing the '${name}' column`);
  }
  return column;
}

/**
 * Resolve the columns the message-search queries need, failing loudly when
 * the passed table is not a messages table.
 * @param messagesTable - Messages table object received from the caller.
 * @returns The three columns referenced by the search queries.
 * @throws Error naming the first missing column.
 */
function requireMessageSearchColumns(messagesTable: SQLiteTable): MessageSearchColumns {
  const columns = getTableColumns(messagesTable);
  return {
    messageId: requireColumn(columns, 'messageId'),
    sessionId: requireColumn(columns, 'sessionId'),
    timestamp: requireColumn(columns, 'timestamp'),
  };
}

/**
 * Builds SQL predicates for optional session-search filters.
 *
 * Postgres uses native boolean literals for the import filter.
 * @param input - Optional status/import filters from the search input.
 * @returns SQL fragment appended to WHERE clauses.
 */
function buildSearchFilterSql(input: FtsSessionCountInput): SQL {
  const conditions: SQL[] = [];
  if (input.status !== undefined) {
    conditions.push(sql`s.status = ${input.status}`);
  }
  if (input.isImported !== undefined) {
    conditions.push(input.isImported ? sql`s.is_imported = true` : sql`COALESCE(s.is_imported, false) = false`);
  }
  if (conditions.length === 0) {
    return sql``;
  }
  return sql` AND ${sql.join(conditions, sql` AND `)}`;
}

/**
 * Builds the shared session-match `WHERE` predicate for the session-search and
 * session-count queries.
 *
 * Both queries match a session when any of its messages matches the FTS query
 * OR its title matches the LIKE pattern, narrowed by the optional status/import
 * filters. The predicate is authored once here so the two queries can never
 * drift; the leading-whitespace layout and `query` → `likePattern` → filter
 * parameter order are preserved verbatim from the inlined form, keeping the
 * emitted SQL byte-identical to the previously-pinned behavior.
 * @param input - Session-search/count input carrying the query, LIKE pattern,
 *   and optional filters.
 * @returns The `WHERE (...)` predicate fragment including the filter clause.
 */
function buildSessionMatchWhere(input: FtsSessionCountInput): SQL {
  const filterClause = buildSearchFilterSql(input);
  return sql`WHERE (
        EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.session_id = s.session_id
            AND m.content_tsv @@ websearch_to_tsquery('english', ${input.query})
        )
        OR LOWER(s.title) LIKE ${input.likePattern}
      )
      ${filterClause}`;
}

/**
 * The Postgres FTS strategy: tsvector matching via `websearch_to_tsquery`,
 * `ts_rank` ordering, and `ts_headline` excerpts.
 */
export const postgresFtsSearchStrategy: FtsSearchStrategy = {
  dialect: 'postgres',

  // The search index ships through the central Postgres migration chain
  // (0001_messages_content_tsv.sql: the stored generated `content_tsv` column
  // plus its GIN index), so boot-time provisioning is deliberately a no-op.
  async provisionSearchIndex(): Promise<void> {
    // Nothing to provision at boot.
  },

  async searchMessages<TRow extends Record<string, unknown>>(
    db: MakaioDatabase,
    messagesTable: SQLiteTable,
    input: FtsMessageSearchInput,
  ): Promise<{ rows: TRow[]; total: number }> {
    const { sessionId, limit } = input;
    const columns = requireMessageSearchColumns(messagesTable);

    // websearch_to_tsquery performs its own query parsing, so the raw query
    // text is passed through untrimmed and unsanitized.
    const tsQuery = sql`websearch_to_tsquery('english', ${input.query})`;
    const matches = sql`content_tsv @@ ${tsQuery}`;
    const where = sessionId ? and(eq(columns.sessionId, sessionId), matches) : matches;

    const rows = await db
      .select()
      .from(messagesTable)
      .where(where)
      .orderBy(sql`ts_rank(content_tsv, ${tsQuery}) DESC`, asc(columns.timestamp), asc(columns.messageId))
      .limit(limit);

    const [countRow] = await db.select({ total: count() }).from(messagesTable).where(where);

    return { rows: rows as TRow[], total: countRow?.total ?? 0 };
  },

  async searchMessageExcerpts(db, messagesTable, input) {
    const { sessionId, limit } = input;
    const columns = requireMessageSearchColumns(messagesTable);

    // websearch_to_tsquery performs its own query parsing; excerpts match on
    // the trimmed query text.
    const trimmed = input.query.trim();
    const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
    const matches = sql`content_tsv @@ ${tsQuery}`;
    const where = sessionId !== undefined ? and(eq(columns.sessionId, sessionId), matches) : matches;

    const rows = await db
      .select({
        messageId: columns.messageId,
        sessionId: columns.sessionId,
        score: sql<number>`ts_rank(content_tsv, ${tsQuery})`,
        excerpt: sql<string>`ts_headline('english', content_text, ${tsQuery}, 'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=15')`,
      })
      .from(messagesTable)
      .where(where)
      .orderBy(sql`ts_rank(content_tsv, ${tsQuery}) DESC`, asc(columns.timestamp), asc(columns.messageId))
      .limit(limit);

    const [countRow] = await db.select({ total: count() }).from(messagesTable).where(where);

    return { results: rows as FtsMessageExcerptHit[], total: countRow?.total ?? 0 };
  },

  // Casts pin node-postgres numeric fields to the JS number types the
  // canonical session row shape expects:
  // - `::double precision` on timestamp columns because node-postgres returns
  //   numeric columns as strings unless cast to a floating-point type.
  // - `::int` on boolean columns because node-postgres returns native JS
  //   booleans, but the row shape pins these fields as `number | null` (the
  //   SQLite 0/1 integer representation); the cast maps true/false to 1/0 and
  //   preserves NULL.
  // Under `SELECT DISTINCT`, Postgres requires that `ORDER BY` expressions
  // appear in the select list; `last_activity_at DESC` references the output
  // alias, which satisfies that constraint.
  async searchSessionRows<TRow extends Record<string, unknown>>(
    db: MakaioDatabase,
    input: FtsSessionSearchInput,
  ): Promise<TRow[]> {
    return getRawSqlExecutor(db).all<TRow>(sql`
      SELECT DISTINCT
        s.session_id,
        s.created_at::double precision AS created_at,
        s.last_activity_at::double precision AS last_activity_at,
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
        s.is_orchestrated::int AS is_orchestrated,
        s.is_imported::int AS is_imported,
        s.summary,
        s.summary_updated_at::double precision AS summary_updated_at,
        s.fork_transforms,
        s.target_working_directory
      FROM sessions s
      ${buildSessionMatchWhere(input)}
      ORDER BY last_activity_at DESC
      LIMIT ${input.limit}
    `);
  },

  // `COUNT(DISTINCT s.session_id)::int` so node-postgres returns a JS number
  // rather than a string (int8 columns come back as strings by default).
  async countSessionMatches(db, input) {
    const [totalRow] = await getRawSqlExecutor(db).all<{ total: number }>(sql`
      SELECT COUNT(DISTINCT s.session_id)::int as total
      FROM sessions s
      ${buildSessionMatchWhere(input)}
    `);
    return totalRow?.total ?? 0;
  },

  async fetchFirstUserMessagePreviews(db, sessionIds) {
    if (sessionIds.length === 0) {
      return new Map<string, string | null>();
    }

    // Tie-break same-timestamp messages deterministically: Postgres has no
    // rowid; message_id provides a stable lexicographic tie-break mirroring
    // the (timestamp, message_id) ordering of the message-search queries.
    const previewRows = await getRawSqlExecutor(db).all<{ sessionId: string; preview: string | null }>(
      buildFirstUserMessagePreviewQuery(sessionIds, sql`m2.message_id < m.message_id`),
    );

    const previewBySession = new Map<string, string | null>();
    for (const row of previewRows) {
      previewBySession.set(row.sessionId, row.preview);
    }
    return previewBySession;
  },
};
