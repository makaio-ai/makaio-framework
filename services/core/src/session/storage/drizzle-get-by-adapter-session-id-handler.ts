import { and, eq, type SQL } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import { SessionStorageSubjects } from './namespace.js';
import { sessionStorageSchema } from './schema.variants.js';
import { mapToSession } from './drizzle-utils.js';
import type { SessionHandlerDeps } from './drizzle-handler.js';

/**
 * Register handler for storage:session.getByAdapterSessionId.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerGetByAdapterSessionIdHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions, agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.getByAdapterSessionId, async (ctx) => {
    const { adapterSessionId, source, adapterName } = ctx.payload;
    const conditions: SQL[] = [eq(sessions.adapterSessionId, adapterSessionId)];
    if (source !== undefined) {
      conditions.push(eq(sessions.source, source));
    }
    if (adapterName !== undefined) {
      conditions.push(eq(sessions.adapterName, adapterName));
    }

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .limit(2);

    const sessionRow = sessionRows[0];
    if (sessionRows.length !== 1 || sessionRow === undefined) {
      ctx.setResult({ session: null });
      return;
    }

    const agentRows = await db.select().from(agents).where(eq(agents.sessionId, sessionRow.sessionId));

    ctx.setResult({ session: mapToSession(sessionRow, agentRows) });
  });
}
