import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';

/**
 * Get the ancestor chain for a session (self, parent, grandparent, ..., root).
 * Uses recursive CTE for arbitrary depth.
 * @param db - The Drizzle database instance
 * @param sessionId - The session ID to get ancestors for
 * @returns Array of session IDs from the given session to root
 * @example
 * ```typescript
 * // For a chain: root -> fork1 -> fork2
 * const chain = await getSessionAncestorChain(db, 'fork2');
 * // Returns: ['fork2', 'fork1', 'root']
 * ```
 */
export async function getSessionAncestorChain(db: MakaioDatabase, sessionId: string): Promise<string[]> {
  const result = await db.run(sql`
    WITH RECURSIVE ancestors AS (
      SELECT session_id, parent_session_id
      FROM sessions
      WHERE session_id = ${sessionId}

      UNION ALL

      SELECT s.session_id, s.parent_session_id
      FROM sessions s
      JOIN ancestors a ON s.session_id = a.parent_session_id
    )
    SELECT session_id FROM ancestors
  `);

  return result.rows.map((row) => row.session_id as string);
}
