/**
 * Full-text search handler for sessions.
 *
 * Provides unified search across:
 * - Message content (FTS5 MATCH on SQLite; `tsvector @@` on Postgres)
 * - Session title (LIKE search on both dialects)
 *
 * Raw SQL is required because FTS5 MATCH (SQLite) and `tsvector @@ websearch_to_tsquery`
 * (Postgres) predicates are not expressible in the portable Drizzle query builder.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  getDatabaseDialect,
  getRawSqlExecutor,
  type MakaioDatabase,
  type StorageDialect,
} from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from './namespace.js';
import {
  fetchAgentsBySession,
  fetchPreviewBySession,
  fetchMessageCountsBySession,
  mapRowToSession,
  type SearchFilters,
  type SearchSessionRow,
} from './fts-search-utils.js';

/**
 * Builds SQL predicates for optional search filters.
 *
 * Boolean literals differ by dialect: SQLite stores booleans as integers (0/1),
 * while Postgres uses native boolean literals (true/false).
 * @param filters - Search filters from request payload
 * @param dialect - Active storage dialect, controls boolean literal style
 * @returns SQL fragment appended to WHERE clauses
 */
function buildSearchFilterSql(filters: SearchFilters, dialect: StorageDialect) {
  const conditions: SQL[] = [];
  if (filters.status !== 'all') {
    conditions.push(sql`s.status = ${filters.status}`);
  }
  if (filters.isImported !== undefined) {
    if (dialect === 'postgres') {
      conditions.push(filters.isImported ? sql`s.is_imported = true` : sql`COALESCE(s.is_imported, false) = false`);
    } else {
      conditions.push(filters.isImported ? sql`s.is_imported = 1` : sql`COALESCE(s.is_imported, 0) = 0`);
    }
  }
  if (conditions.length === 0) {
    return sql``;
  }
  return sql` AND ${sql.join(conditions, sql` AND `)}`;
}

/**
 * Fetches matching session rows for search results.
 *
 * On Postgres, casts are applied to pin `SearchSessionRow`'s number-typed fields:
 * - `::double precision` on timestamp columns because node-postgres returns numeric
 *   columns as strings unless cast to a floating-point type.
 * - `::int` on boolean columns because node-postgres returns native JS booleans,
 *   but `SearchSessionRow` pins these fields as `number | null` (the SQLite 0/1
 *   integer representation); the cast maps true/false to 1/0 and preserves NULL.
 *
 * Under `SELECT DISTINCT`, Postgres requires that `ORDER BY` expressions appear
 * in the select list; `last_activity_at DESC` references the output alias, which
 * satisfies that constraint on both dialects.
 * @param db - Drizzle database instance
 * @param trimmedQuery - Normalized search query text
 * @param likePattern - Lowercased `%query%` pattern for title matching
 * @param limit - Maximum number of rows to return
 * @param filters - Optional status/import filters
 * @param dialect - Active storage dialect, controls match predicate and casts
 * @returns Matching session rows sorted by last activity descending
 */
async function fetchSearchRows(
  db: MakaioDatabase,
  trimmedQuery: string,
  likePattern: string,
  limit: number,
  filters: SearchFilters,
  dialect: StorageDialect,
): Promise<SearchSessionRow[]> {
  const filterClause = buildSearchFilterSql(filters, dialect);

  if (dialect === 'postgres') {
    // Postgres: use EXISTS over messages m with tsvector @@ websearch_to_tsquery.
    // Casts pin node-postgres numeric fields to the JS number types SearchSessionRow expects.
    // ORDER BY references the output alias (required under SELECT DISTINCT on Postgres).
    return getRawSqlExecutor(db).all<SearchSessionRow>(sql`
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
      WHERE (
        EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.session_id = s.session_id
            AND m.content_tsv @@ websearch_to_tsquery('english', ${trimmedQuery})
        )
        OR LOWER(s.title) LIKE ${likePattern}
      )
      ${filterClause}
      ORDER BY last_activity_at DESC
      LIMIT ${limit}
    `);
  }

  return getRawSqlExecutor(db).all<SearchSessionRow>(sql`
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
        WHERE messages_fts MATCH ${trimmedQuery}
      )
      OR LOWER(s.title) LIKE ${likePattern}
    )
    ${filterClause}
    ORDER BY s.last_activity_at DESC
    LIMIT ${limit}
  `);
}

/**
 * Counts the full number of matching sessions without pagination.
 *
 * Postgres uses `COUNT(DISTINCT s.session_id)::int` so node-postgres returns
 * a JS number rather than a string (int8 columns come back as strings by default).
 * @param db - Drizzle database instance
 * @param trimmedQuery - Normalized search query text
 * @param likePattern - Lowercased `%query%` pattern for title matching
 * @param filters - Optional status/import filters
 * @param dialect - Active storage dialect, controls match predicate and casts
 * @returns Total number of unique matching sessions
 */
async function fetchSearchTotal(
  db: MakaioDatabase,
  trimmedQuery: string,
  likePattern: string,
  filters: SearchFilters,
  dialect: StorageDialect,
): Promise<number> {
  const filterClause = buildSearchFilterSql(filters, dialect);

  if (dialect === 'postgres') {
    const [totalRow] = await getRawSqlExecutor(db).all<{ total: number }>(sql`
      SELECT COUNT(DISTINCT s.session_id)::int as total
      FROM sessions s
      WHERE (
        EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.session_id = s.session_id
            AND m.content_tsv @@ websearch_to_tsquery('english', ${trimmedQuery})
        )
        OR LOWER(s.title) LIKE ${likePattern}
      )
      ${filterClause}
    `);
    return totalRow?.total ?? 0;
  }

  const [totalRow] = await getRawSqlExecutor(db).all<{ total: number }>(sql`
    SELECT COUNT(DISTINCT s.session_id) as total
    FROM sessions s
    WHERE (
      s.session_id IN (
        SELECT session_id FROM messages_fts
        WHERE messages_fts MATCH ${trimmedQuery}
      )
      OR LOWER(s.title) LIKE ${likePattern}
    )
    ${filterClause}
  `);
  return totalRow?.total ?? 0;
}

/**
 * Registers FTS-backed `storage:session.search` handler.
 *
 * Works on both SQLite (FTS5 MATCH) and Postgres (`tsvector @@ websearch_to_tsquery`).
 * The dialect is detected once and threaded into the query helpers.
 * @param bus - Bus instance used for handler registration
 * @param db - Drizzle database instance
 * @returns Cleanup function that unregisters the search handler
 */
export function registerFtsSearchHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const dialect = getDatabaseDialect(db);

  const unsubs: Array<() => void> = [];

  // storage:session.search — Unified search across message content and session title.
  // Raw SQL required for FTS5 MATCH (SQLite) and tsvector @@ (Postgres) predicates.
  // Always includes preview data since search is content-focused.
  unsubs.push(
    bus.on(SessionStorageSubjects.search, async (ctx) => {
      const { query, limit = 20, status = 'all', isImported } = ctx.payload;

      // Return empty for empty or whitespace-only queries
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        ctx.setResult({ sessions: [], total: 0 });
        return;
      }

      // Prepare LIKE pattern for title search (case-insensitive via LOWER)
      const likePattern = `%${trimmedQuery.toLowerCase()}%`;

      const filters: SearchFilters = { status, isImported };
      const rows = await fetchSearchRows(db, trimmedQuery, likePattern, limit, filters, dialect);

      if (rows.length === 0) {
        ctx.setResult({ sessions: [], total: 0 });
        return;
      }

      const total = await fetchSearchTotal(db, trimmedQuery, likePattern, filters, dialect);

      // Fetch agents for matched sessions
      const sessionIds = rows.map((r) => r.session_id);
      const agentsBySession = await fetchAgentsBySession(db, sessionIds);
      const previewBySession = await fetchPreviewBySession(db, sessionIds, dialect);
      const countBySession = await fetchMessageCountsBySession(db, sessionIds);

      // Map to response format with full MakaioSession + preview
      const sessionResults = rows.map((row) =>
        mapRowToSession(row, agentsBySession.get(row.session_id) ?? [], previewBySession, countBySession),
      );

      ctx.setResult({ sessions: sessionResults, total });
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}
