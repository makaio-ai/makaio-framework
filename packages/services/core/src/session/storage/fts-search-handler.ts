/**
 * FTS5 full-text search handler for sessions.
 *
 * Provides unified search across:
 * - Message content (FTS5 full-text search)
 * - Session title (LIKE search)
 *
 * Uses raw SQL for FTS5 MATCH syntax (not supported by Drizzle ORM).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
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
 * @param filters - Search filters from request payload
 * @returns SQL fragment appended to WHERE clauses
 */
function buildSearchFilterSql(filters: SearchFilters) {
  const conditions: SQL[] = [];
  if (filters.status !== 'all') {
    conditions.push(sql`s.status = ${filters.status}`);
  }
  if (filters.isImported !== undefined) {
    conditions.push(filters.isImported ? sql`s.is_imported = 1` : sql`COALESCE(s.is_imported, 0) = 0`);
  }
  if (conditions.length === 0) {
    return sql``;
  }
  return sql` AND ${sql.join(conditions, sql` AND `)}`;
}

/**
 * Fetches matching session rows for search results.
 * @param db - Drizzle database instance
 * @param trimmedQuery - Normalized FTS query text
 * @param likePattern - Lowercased `%query%` pattern for title matching
 * @param limit - Maximum number of rows to return
 * @param filters - Optional status/import filters
 * @returns Matching session rows sorted by last activity descending
 */
async function fetchSearchRows(
  db: MakaioDatabase,
  trimmedQuery: string,
  likePattern: string,
  limit: number,
  filters: SearchFilters,
): Promise<SearchSessionRow[]> {
  const filterClause = buildSearchFilterSql(filters);
  return db.all<SearchSessionRow>(sql`
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
 * @param db - Drizzle database instance
 * @param trimmedQuery - Normalized FTS query text
 * @param likePattern - Lowercased `%query%` pattern for title matching
 * @param filters - Optional status/import filters
 * @returns Total number of unique matching sessions
 */
async function fetchSearchTotal(
  db: MakaioDatabase,
  trimmedQuery: string,
  likePattern: string,
  filters: SearchFilters,
): Promise<number> {
  const filterClause = buildSearchFilterSql(filters);
  const [totalRow] = await db.all<{ total: number }>(sql`
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
 * @param bus - Bus instance used for handler registration
 * @param db - Drizzle database instance
 * @returns Cleanup function that unregisters the search handler
 */
export function registerFtsSearchHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubs: Array<() => void> = [];

  // storage:session.search - Unified search across message content and session title
  // NOTE: Raw SQL required for FTS5 MATCH syntax (not supported by Drizzle)
  // Always includes preview data since search is content-focused
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
      const rows = await fetchSearchRows(db, trimmedQuery, likePattern, limit, filters);

      if (rows.length === 0) {
        ctx.setResult({ sessions: [], total: 0 });
        return;
      }

      const total = await fetchSearchTotal(db, trimmedQuery, likePattern, filters);

      // Fetch agents for matched sessions
      const sessionIds = rows.map((r) => r.session_id);
      const agentsBySession = await fetchAgentsBySession(db, sessionIds);
      const previewBySession = await fetchPreviewBySession(db, sessionIds);
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
