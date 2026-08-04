/**
 * Drizzle handler for `storage:session.rebindObserved`.
 *
 * Kept out of the import handlers because a rebind is deliberately not an
 * import: it refreshes runtime/locality columns of a session that already
 * exists and touches nothing the import upsert's conflict merge owns.
 * @packageDocumentation
 */
import { and, eq } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import { SessionSubjects, type SessionStorageRebindObservedRequest } from '@makaio/contracts';
import { SessionStorageSubjects } from './namespace.js';
import { sessionStorageSchema } from './schema.variants.js';
import type { SessionHandlerDeps } from './drizzle-handler.js';

/**
 * Locality columns an observed rebind may refresh.
 *
 * Keys are session property names so they double as the `changedProperties`
 * payload of the emitted `session.updated` event. That payload lists what the
 * continuation *reported*, not what differed from the stored row: comparing
 * would require a read-modify-write, and re-reporting an unchanged directory is
 * cheaper for consumers than a stale one is dangerous.
 */
type RebindObservedLocality = Pick<
  typeof sessionStorageSchema.sqlite.sessions.$inferInsert,
  'targetWorkingDirectory' | 'logFilePath' | 'machineId'
>;

/**
 * Collect the locality columns an observed rebind request actually supplies.
 *
 * Absent fields are omitted rather than written as NULL: the observing runtime
 * reports what it knows, and missing evidence must not erase a stored value.
 * @param payload - Rebind request payload
 * @returns Drizzle `set` object holding only the supplied locality columns
 */
function buildRebindObservedSet(payload: SessionStorageRebindObservedRequest): RebindObservedLocality {
  return {
    ...(payload.cwd !== undefined ? { targetWorkingDirectory: payload.cwd } : {}),
    ...(payload.logFilePath !== undefined ? { logFilePath: payload.logFilePath } : {}),
    ...(payload.machineId !== undefined ? { machineId: payload.machineId } : {}),
  };
}

/**
 * Register handler for storage:session.rebindObserved.
 *
 * Single-statement UPDATE keyed on the `(source, adapterSessionId)` import
 * identity — the same key the import upsert conflicts on, so a rebind can
 * never fork the identity it is meant to reuse. No row matched means the
 * modeled `'not-found'` outcome: storage does not invent a session for a
 * continuation whose origin it never saw.
 *
 * A request that carries no locality evidence degrades to an existence probe
 * so the outcome stays honest without issuing an empty UPDATE.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerRebindObservedHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.rebindObserved, async (ctx) => {
    const payload = ctx.payload;
    const identity = and(eq(sessions.source, payload.source), eq(sessions.adapterSessionId, payload.externalSessionId));
    const locality = buildRebindObservedSet(payload);
    const changedProperties = Object.keys(locality);

    const [row] =
      changedProperties.length === 0
        ? await db.select({ sessionId: sessions.sessionId }).from(sessions).where(identity).limit(1)
        : await db.update(sessions).set(locality).where(identity).returning({ sessionId: sessions.sessionId });

    if (!row) {
      ctx.setResult({ outcome: 'not-found' });
      return;
    }

    ctx.setResult({ outcome: 'rebound', sessionId: row.sessionId });
    if (changedProperties.length > 0) {
      // Fire-and-forget: entity cache reactivity is best-effort.
      void bus
        .emit(SessionSubjects.updated, { sessionId: row.sessionId, changedProperties })
        .catch((err) => console.error('[SessionStorage] Failed to emit session.updated:', err));
    }
  });
}
