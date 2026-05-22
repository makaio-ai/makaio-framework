/**
 * Parent resolver handler for out-of-order session imports.
 *
 * When a parent session is linked to a Makaio session (adapter.session.linked),
 * this handler finds any child sessions that reference it and updates their
 * Makaio session's parentSessionId and rootSessionId.
 *
 * This resolves the case where a child session was imported before its parent.
 * It also cascades rootSessionId updates down the tree to ensure grandchildren
 * have the correct root.
 */

import { eq } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterSessionStorageNamespace } from './namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { kindToBranchKind } from './lineage-utils.js';

/**
 * Register handler to resolve parent relationships when sessions are linked.
 *
 * When `adapter.session.linked` is emitted:
 * 1. Query adapter_sessions for children referencing this adapterSessionId as parent
 * 2. For each child with a linked sessionId, update the child's Makaio session parentSessionId
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
  const { adapterSessions } = AdapterSessionStorageNamespace.extensions.drizzle!;

  /**
   * Recursively update rootSessionId for all descendants of an adapter session.
   *
   * Walks `adapter_sessions.parent_adapter_session_id` — this column is always
   * populated at upsert time, so the full tree is traversable regardless of
   * import order. For each descendant that is already linked to a Makaio session,
   * updates `rootSessionId` via the bus.
   * @param adapterSessionId - The adapter session whose children to update
   * @param rootSessionId - The root session ID to propagate down the tree
   * @param depth - Current recursion depth for cycle detection
   */
  async function cascadeRootSessionId(adapterSessionId: string, rootSessionId: string, depth = 0): Promise<void> {
    if (depth > 100) throw new Error('Cycle detected in session lineage (depth > 100)');

    // Find all adapter sessions whose parent is the given adapter session.
    // parent_adapter_session_id is always set at upsert time, so this traversal
    // works regardless of which order sessions were linked to Makaio.
    const children = await db
      .select({
        adapterSessionId: adapterSessions.adapterSessionId,
        sessionId: adapterSessions.sessionId,
      })
      .from(adapterSessions)
      .where(eq(adapterSessions.parentAdapterSessionId, adapterSessionId));

    for (const child of children) {
      // Update rootSessionId only for children already linked to a Makaio session
      if (child.sessionId) {
        await bus.request(SessionStorageSubjects.update, {
          sessionId: child.sessionId,
          rootSessionId,
        });
      }
      // Always recurse — grandchildren may be linked even if this child is not
      await cascadeRootSessionId(child.adapterSessionId, rootSessionId, depth + 1);
    }
  }

  return bus.on(AdapterSubjects.session.linked, async (ctx) => {
    const { adapterSessionId, sessionId: parentMakaioSessionId } = ctx.payload;

    // Find all children that reference this adapter session as parent
    const children = await db
      .select({
        adapterSessionId: adapterSessions.adapterSessionId,
        sessionId: adapterSessions.sessionId,
        kind: adapterSessions.kind,
      })
      .from(adapterSessions)
      .where(eq(adapterSessions.parentAdapterSessionId, adapterSessionId));

    // Skip if no children to update
    if (children.length === 0) return;

    // Get parent session to determine rootSessionId
    const { session: parentSession } = await bus.request(SessionStorageSubjects.get, {
      sessionId: parentMakaioSessionId,
    });
    const rootSessionId = parentSession?.rootSessionId ?? parentMakaioSessionId;

    // Update each child's Makaio session with parent and root relationships
    for (const child of children) {
      const branchKind = kindToBranchKind(child.kind);
      if (child.sessionId) {
        await bus.request(SessionStorageSubjects.update, {
          sessionId: child.sessionId,
          parentSessionId: parentMakaioSessionId,
          rootSessionId,
          ...(branchKind !== undefined ? { branchKind } : {}),
        });
      }

      // Always cascade via adapter space — descendants may already be linked even
      // when this direct child is still waiting on its own Makaio session link.
      await cascadeRootSessionId(child.adapterSessionId, rootSessionId);
    }
  });
}
