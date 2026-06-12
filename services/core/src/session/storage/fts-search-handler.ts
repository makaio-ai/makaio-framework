/**
 * Full-text search handler for sessions.
 *
 * Provides unified search across:
 * - Message content (FTS5 MATCH on SQLite; `tsvector @@` on Postgres)
 * - Session title (LIKE search on both dialects)
 *
 * The dialect-divergent queries are engine-owned (`StorageEngine.fts`); this
 * handler keeps the orchestration: query normalization, the empty-query
 * short-circuit, result hydration, and response mapping.
 */
import { resolveStorageEngine, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from './namespace.js';
import {
  fetchAgentsBySession,
  fetchPreviewBySession,
  fetchMessageCountsBySession,
  mapRowToSession,
  type SearchSessionRow,
} from './fts-search-utils.js';

/**
 * Registers FTS-backed `storage:session.search` handler.
 *
 * Works on both SQLite (FTS5 MATCH) and Postgres (`tsvector @@ websearch_to_tsquery`)
 * through the engine's FTS strategy, resolved once at registration.
 * @param bus - Bus instance used for handler registration
 * @param db - Drizzle database instance
 * @returns Cleanup function that unregisters the search handler
 */
export function registerFtsSearchHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const fts = resolveStorageEngine(db).fts;

  const unsubs: Array<() => void> = [];

  // storage:session.search — Unified search across message content and session title.
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

      const searchInput = {
        query: trimmedQuery,
        likePattern,
        // 'all' is the handler-level "no status filter" sentinel; the
        // strategy contract models that as an absent filter.
        status: status === 'all' ? undefined : status,
        isImported,
      };
      const rows = await fts.searchSessionRows<SearchSessionRow>(db, { ...searchInput, limit });

      if (rows.length === 0) {
        ctx.setResult({ sessions: [], total: 0 });
        return;
      }

      const total = await fts.countSessionMatches(db, searchInput);

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
