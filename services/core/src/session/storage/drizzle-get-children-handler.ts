import { and, eq, count, inArray } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import { SessionStorageSubjects } from './namespace.js';
import { sessionStorageSchema } from './schema.variants.js';
import { messagesSchema } from '../messages/schema.variants.js';
import type { SessionHandlerDeps } from './drizzle-handler.js';

/**
 * Register handler for storage:session.getChildren - direct children with enriched data.
 *
 * Lives in its own module — following the one-handler-per-file convention of
 * its sibling satellites — to keep drizzle-handler.ts within the max-lines
 * lint threshold.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerGetChildrenHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);
  const { messages } = resolveSchema(db, messagesSchema);

  return bus.on(SessionStorageSubjects.getChildren, async (ctx) => {
    const { sessionId } = ctx.payload;

    const childRows = await db.select().from(sessions).where(eq(sessions.parentSessionId, sessionId));
    if (childRows.length === 0) {
      ctx.setResult({ children: [] });
      return;
    }

    const childIds = childRows.map((row) => row.sessionId);

    const messageCountRows = await db
      .select({ sessionId: messages.sessionId, count: count() })
      .from(messages)
      .where(inArray(messages.sessionId, childIds))
      .groupBy(messages.sessionId);

    const messageCountBySession = new Map<string, number>();
    for (const row of messageCountRows) {
      messageCountBySession.set(row.sessionId, row.count);
    }

    const hasChildrenRows = await db
      .select({ parentSessionId: sessions.parentSessionId, count: count() })
      .from(sessions)
      .where(inArray(sessions.parentSessionId, childIds))
      .groupBy(sessions.parentSessionId);

    const hasChildrenSet = new Set<string>();
    for (const row of hasChildrenRows) {
      if (row.parentSessionId) {
        hasChildrenSet.add(row.parentSessionId);
      }
    }

    // Translate adapter fork point IDs to Makaio message IDs.
    // The sessions table stores adapter_message_id as forkPointMessageId (from imports)
    // but the UI needs the Makaio message_id to match against turn.id.
    // adapterMessageId is not unique across sessions — forked sessions carry copies of
    // ancestor messages under the same adapter ID (shared-ancestry fork detection), so
    // the lookup must be scoped to the parent session whose timeline the translated ID
    // is matched against. When the parent has no row for the ID, the adapter ID falls
    // through unchanged via the `?? adapterForkPoint` fallback below.
    const adapterForkPointIds = childRows.map((c) => c.forkPointMessageId).filter((id): id is string => id !== null);
    const forkPointMapping = new Map<string, string>();

    if (adapterForkPointIds.length > 0) {
      const forkPointRows = await db
        .select({ messageId: messages.messageId, adapterMessageId: messages.adapterMessageId })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), inArray(messages.adapterMessageId, adapterForkPointIds)));

      for (const row of forkPointRows) {
        if (row.adapterMessageId) {
          forkPointMapping.set(row.adapterMessageId, row.messageId);
        }
      }
    }

    const children = childRows.map((child) => {
      // Translate adapter forkPointMessageId to Makaio messageId
      const adapterForkPoint = child.forkPointMessageId;
      const makaioForkPoint = adapterForkPoint ? (forkPointMapping.get(adapterForkPoint) ?? adapterForkPoint) : null;

      return {
        sessionId: child.sessionId,
        title: child.title ?? null,
        forkPointMessageId: makaioForkPoint,
        branchKind: child.branchKind ?? null,
        messageCount: messageCountBySession.get(child.sessionId) ?? 0,
        hasChildren: hasChildrenSet.has(child.sessionId),
        spawningToolCallId: child.spawningToolCallId ?? undefined,
      };
    });

    ctx.setResult({ children });
  });
}
