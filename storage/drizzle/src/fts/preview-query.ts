/**
 * Shared first-user-message preview query.
 *
 * Both built-in FTS strategies resolve session previews with the same
 * NOT EXISTS anti-join over `messages`; only the same-timestamp tie-break
 * predicate diverges (rowid insertion order on SQLite, message_id
 * lexicographic order on Postgres). Keeping the query here keeps that
 * divergence down to the injected fragment.
 * @packageDocumentation
 */
import { sql, type SQL } from 'drizzle-orm';

/**
 * Build the query resolving the first user message per session.
 *
 * Selects, for every given session, the user message no other user message of
 * the same session precedes — "precedes" meaning an earlier timestamp, or an
 * equal timestamp with the engine's tie-break predicate. Callers must not
 * pass an empty `sessionIds` list (an empty `IN ()` list is invalid SQL);
 * strategies short-circuit empty inputs before building the query.
 * @param sessionIds - Session IDs to resolve previews for (deduplicated here).
 * @param tieBreaker - Predicate over aliases `m2`/`m` that is `true` when
 *   `m2` precedes `m` among same-timestamp user messages.
 * @returns Query yielding `sessionId` / `preview` rows.
 */
export function buildFirstUserMessagePreviewQuery(sessionIds: readonly string[], tieBreaker: SQL): SQL {
  const uniqueIds = [...new Set(sessionIds)];

  return sql`
    SELECT m.session_id as "sessionId", m.content_text as preview
    FROM messages m
    WHERE m.role = 'user'
      AND m.session_id IN (${sql.join(
        uniqueIds.map((sessionId) => sql`${sessionId}`),
        sql`, `,
      )})
      AND NOT EXISTS (
        SELECT 1
        FROM messages m2
        WHERE m2.session_id = m.session_id
          AND m2.role = 'user'
          AND (m2.timestamp < m.timestamp OR (m2.timestamp = m.timestamp AND ${tieBreaker}))
      )
  `;
}
