import { and, eq } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from './namespace.js';
import { sessionStorageSchema } from './schema.variants.js';
import type { SessionHandlerDeps } from './drizzle-handler.js';
import { buildInitialImportValues, emitImportUpsertLifecycleEvent } from './drizzle-import-registration-utils.js';

/**
 * Classify a row's stored ownership without exposing its principal identity.
 * @param ownerPrincipalId - Stored owner principal, if one claimed the row.
 * @param requestedOwnerPrincipalId - Principal making the request.
 * @returns Requester's relationship to the row.
 */
function classifyOwner(
  ownerPrincipalId: string | null,
  requestedOwnerPrincipalId: string,
): 'owned' | 'unowned' | 'foreign' {
  if (ownerPrincipalId === null) {
    return 'unowned';
  }
  return ownerPrincipalId === requestedOwnerPrincipalId ? 'owned' : 'foreign';
}

/**
 * Register ownership-aware import storage handlers.
 * @param bus - Bus instance for handler registration.
 * @param deps - Shared handler dependencies.
 * @returns Cleanup functions for the registered handlers.
 */
export function registerDrizzleOwnedImportHandlers(bus: IMakaioBus, deps: SessionHandlerDeps): Array<() => void> {
  const { db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  return [
    bus.on(SessionStorageSubjects.registerOwnedImport, async (ctx) => {
      const { ownerPrincipalId, import: payload } = ctx.payload;
      const sessionId = crypto.randomUUID();
      const initial = buildInitialImportValues(payload, sessionId, ownerPrincipalId);

      const [created] = await db
        .insert(sessions)
        .values(initial.values)
        .onConflictDoNothing({ target: [sessions.source, sessions.adapterSessionId] })
        .returning({ sessionId: sessions.sessionId });

      if (created) {
        // Only the insert winner resolves initial parent lineage; its fresh ID is
        // published after that resolution, while conflicts take the read-only path below.
        await emitImportUpsertLifecycleEvent(
          bus,
          db,
          {
            sessionId: created.sessionId,
            discoveredAt: initial.values.discoveredAt,
            parentExternalSessionId: initial.values.parentExternalSessionId,
            parentSessionId: null,
          },
          true,
          initial.branchKind,
          initial.createdAt,
          payload.source,
        );
        ctx.setResult({ outcome: 'created', sessionId: created.sessionId });
        return;
      }

      const [existing] = await db
        .select({ sessionId: sessions.sessionId, ownerPrincipalId: sessions.ownerPrincipalId })
        .from(sessions)
        .where(and(eq(sessions.source, payload.source), eq(sessions.adapterSessionId, payload.externalSessionId)))
        .limit(1);

      if (!existing) {
        ctx.setResult({ outcome: 'missing' });
        return;
      }

      const outcome = classifyOwner(existing.ownerPrincipalId, ownerPrincipalId);
      ctx.setResult(outcome === 'owned' ? { outcome, sessionId: existing.sessionId } : { outcome });
    }),
    bus.on(SessionStorageSubjects.verifyOwner, async (ctx) => {
      const [existing] = await db
        .select({ ownerPrincipalId: sessions.ownerPrincipalId })
        .from(sessions)
        .where(eq(sessions.sessionId, ctx.payload.sessionId))
        .limit(1);

      ctx.setResult(
        existing
          ? { outcome: classifyOwner(existing.ownerPrincipalId, ctx.payload.ownerPrincipalId) }
          : { outcome: 'missing' },
      );
    }),
  ];
}
