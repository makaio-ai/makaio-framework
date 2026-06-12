/**
 * Parent resolver handler for out-of-order session imports.
 *
 * When a session import completes (session.import.completed), this handler
 * finds any child sessions that reference the newly imported session as their
 * external parent and updates their parentSessionId and rootSessionId.
 *
 * This resolves the case where a child session was imported before its parent.
 * It also cascades rootSessionId updates down the tree to ensure grandchildren
 * have the correct root.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { sessionStorageSchema } from '../storage/schema.variants.js';

/**
 * Register handler to resolve parent relationships when sessions are imported.
 *
 * When `session.import.completed` is emitted:
 * 1. Query sessions for children whose `parentExternalSessionId` matches
 *    the just-imported session's `adapterSessionId` and whose `parentSessionId`
 *    is still null (unresolved).
 * 2. For each unresolved child, update its `parentSessionId` and `rootSessionId`.
 * 3. Cascade `rootSessionId` down the tree to any already-resolved grandchildren.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance for direct queries
 * @returns Cleanup function to unsubscribe the handler
 * @example
 * ```typescript
 * import { registerParentResolver } from '@makaio/services-core/session';
 *
 * const cleanup = registerParentResolver(bus, db);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerParentResolver(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  /**
   * Recursively update rootSessionId for all descendants of a session.
   *
   * Walks `sessions.parentExternalSessionId` — this column is always
   * populated at import time, so the full tree is traversable regardless of
   * import order. For each descendant that already has a `parentSessionId`
   * set (i.e., is resolved), updates `rootSessionId` via the bus.
   * @param adapterSessionId - The adapter session whose children to update
   * @param source - Source tool identity for the imported lineage
   * @param rootSessionId - The root session ID to propagate down the tree
   * @param depth - Current recursion depth for cycle detection
   */
  async function cascadeRootSessionId(
    adapterSessionId: string,
    source: string,
    rootSessionId: string,
    depth = 0,
  ): Promise<void> {
    if (depth > 100) throw new Error('Cycle detected in session lineage (depth > 100)');

    // Find all sessions whose parentExternalSessionId is the given adapter session.
    // parentExternalSessionId is always set at import time, so this traversal
    // works regardless of which order sessions were imported.
    const children = await db
      .select({
        adapterSessionId: sessions.adapterSessionId,
        sessionId: sessions.sessionId,
        parentSessionId: sessions.parentSessionId,
      })
      .from(sessions)
      .where(and(eq(sessions.parentExternalSessionId, adapterSessionId), eq(sessions.source, source)));

    for (const child of children) {
      // Update rootSessionId only for children that are already parent-resolved
      if (child.parentSessionId !== null) {
        await bus.request(SessionStorageSubjects.update, {
          sessionId: child.sessionId,
          rootSessionId,
        });
      }
      // Always recurse if this child has an adapterSessionId —
      // grandchildren may be resolved even if this child is not
      if (child.adapterSessionId !== null) {
        await cascadeRootSessionId(child.adapterSessionId, source, rootSessionId, depth + 1);
      }
    }
  }

  return bus.on(SessionSubjects.import.completed, async (ctx) => {
    const { adapterSessionId, sessionId: parentMakaioSessionId, source } = ctx.payload;

    // Find all children that reference this session as parent and are unresolved
    const children = await db
      .select({
        sessionId: sessions.sessionId,
        adapterSessionId: sessions.adapterSessionId,
        branchKind: sessions.branchKind,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.parentExternalSessionId, adapterSessionId),
          eq(sessions.source, source),
          isNull(sessions.parentSessionId),
        ),
      );

    // Skip if no unresolved children to update
    if (children.length === 0) return;

    // Get parent session to determine rootSessionId
    const { session: parentSession } = await bus.request(SessionStorageSubjects.get, {
      sessionId: parentMakaioSessionId,
    });
    const rootSessionId = parentSession?.rootSessionId ?? parentMakaioSessionId;

    // Update each unresolved child's session with parent and root relationships
    for (const child of children) {
      await bus.request(SessionStorageSubjects.update, {
        sessionId: child.sessionId,
        parentSessionId: parentMakaioSessionId,
        rootSessionId,
        ...(child.branchKind !== null ? { branchKind: child.branchKind } : {}),
      });

      // Always cascade via external session space — descendants may already be
      // resolved even when this direct child was waiting on its parent.
      if (child.adapterSessionId !== null) {
        await cascadeRootSessionId(child.adapterSessionId, source, rootSessionId);
      }
    }
  });
}
