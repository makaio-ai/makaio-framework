import { and, eq } from 'drizzle-orm';
import { SessionStorageSubjects } from './namespace.js';
import { agents, sessions } from './schema.js';
import { mapToSession } from './drizzle-utils.js';
import type { SessionHandlerDeps } from './drizzle-handler.js';

/**
 * Register handler for storage:session.getByAdapterSessionId.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerGetByAdapterSessionIdHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(SessionStorageSubjects.getByAdapterSessionId, async (ctx) => {
    const { adapterSessionId, source } = ctx.payload;

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(
        source === undefined
          ? eq(sessions.adapterSessionId, adapterSessionId)
          : and(eq(sessions.adapterSessionId, adapterSessionId), eq(sessions.source, source)),
      )
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
