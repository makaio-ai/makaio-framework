/**
 * Drizzle handler for `storage:session.rebindObserved`.
 *
 * Kept out of the import handlers because a rebind is deliberately not an
 * import: it refreshes runtime/locality columns of a session that already
 * exists and touches nothing the import upsert's conflict merge owns.
 * @packageDocumentation
 */
import { and, eq, sql } from 'drizzle-orm';
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
 * Whether this continuation advances the row's compaction ordinal.
 *
 * Only `'compact'` does: it is the provider telling us the context was reset.
 * A `'resume'` continues the same context, and an absent start mode carries no
 * claim either way — neither may advance a counter consumers read as
 * "compactions so far".
 * @param payload - Rebind request payload
 * @returns True when the row's `generation` must be incremented
 */
function advancesGeneration(payload: SessionStorageRebindObservedRequest): boolean {
  return payload.startMode === 'compact';
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
 * so the outcome stays honest without issuing an empty UPDATE — unless it
 * reports `startMode: 'compact'`, which is evidence of its own and advances the
 * row's `generation` ordinal.
 *
 * That advance is **at-least-once**: nothing upstream deduplicates hook
 * deliveries, so a redelivered compaction signal increments twice. Accepted
 * deliberately — `generation` is an ordinal, not a tally. Its contract is that
 * it changes on compaction and never repeats or regresses, which is what
 * consumers detecting "a new generation began" rely on; a skipped number costs
 * them nothing, whereas a *missed* increment would silently merge two
 * generations. Guarding would need a dedupe key the hook payload does not carry.
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

    // The compaction ordinal rides along in the same UPDATE as the locality
    // refresh. Incrementing in SQL rather than read-modify-write keeps
    // concurrent continuations from reading the same value and writing it twice.
    const generationAdvance = advancesGeneration(payload);
    if (generationAdvance) {
      changedProperties.push('generation');
    }
    const updates = generationAdvance ? { ...locality, generation: sql`${sessions.generation} + 1` } : { ...locality };

    const [row] =
      changedProperties.length === 0
        ? await db.select({ sessionId: sessions.sessionId }).from(sessions).where(identity).limit(1)
        : await db.update(sessions).set(updates).where(identity).returning({ sessionId: sessions.sessionId });

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
