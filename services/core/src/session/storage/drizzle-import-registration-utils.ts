import { and, eq } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type BranchKind, type IMakaioSession, type ImportUpsertRequest } from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { kindToBranchKind } from '../import/lineage-utils.js';
import { createMonotonicClock } from './monotonic-clock.js';
import { resolveImportCreateStatus } from './import-lifecycle.js';

const nextDiscoveredAt = createMonotonicClock();

type ClientIdentityObservation = IMakaioSession['lastClientIdentityObservation'];

/**
 * Serialize a client identity observation for persistence.
 * @param observation - Latest observed client identity payload, if any.
 * @returns JSON string for storage, or null when no observation is present.
 */
function serializeClientIdentityObservation(observation: ClientIdentityObservation | undefined): string | null {
  return observation ? JSON.stringify(observation) : null;
}

/**
 * Build the complete initial row for an imported session.
 *
 * Both ordinary import enrichment and principal-owned registration must create
 * the same initial session shape. The registration path adds ownership only on
 * this insert; it never uses this shape for an existing identity.
 * @param payload - Import identity and initial metadata.
 * @param sessionId - Fresh Makaio session identifier for this insert attempt.
 * @param ownerPrincipalId - Principal to persist only when this insert wins.
 * @returns Initial database values and lifecycle facts used after a successful insert.
 */
export function buildInitialImportValues(
  payload: ImportUpsertRequest,
  sessionId: string,
  ownerPrincipalId: string | null = null,
) {
  const discoveredAt = nextDiscoveredAt();
  const createdAt = payload.startedAt ?? discoveredAt;
  const branchKind = kindToBranchKind(payload.kind) ?? null;

  return {
    values: {
      sessionId,
      status: resolveImportCreateStatus(payload),
      isImported: true,
      importStatus: payload.importStatus ?? 'discovered',
      adapterName: payload.source,
      adapterSessionId: payload.externalSessionId,
      source: payload.source ?? null,
      clientId: payload.clientId ?? null,
      adapterId: payload.adapterId ?? null,
      targetWorkingDirectory: payload.cwd ?? null,
      logFilePath: payload.logFilePath ?? null,
      forkPointMessageId: payload.forkPointMessageId ?? null,
      branchKind,
      parentExternalSessionId: payload.parentAdapterSessionId ?? null,
      discoveredAt,
      title: payload.title ?? null,
      metadata: payload.metadata ?? null,
      lastClientIdentityObservation: serializeClientIdentityObservation(payload.lastClientIdentityObservation),
      isSidechain: payload.isSidechain ?? null,
      machineId: payload.machineId ?? null,
      ownerPrincipalId,
      createdAt,
      lastActivityAt: createdAt,
    },
    branchKind,
    createdAt,
  };
}

/**
 * Emit the appropriate lifecycle event after an import registration operation.
 * @param bus - Bus for event emission.
 * @param db - Database for parent resolution.
 * @param row - The registered row's key fields.
 * @param created - Whether the row was newly created.
 * @param branchKind - Branch kind for the created event.
 * @param createdAt - Timestamp for the created event.
 * @param source - Source tool identity for resolving imported parent links.
 */
export async function emitImportUpsertLifecycleEvent(
  bus: IMakaioBus,
  db: MakaioDatabase,
  row: {
    sessionId: string;
    discoveredAt: number | null;
    parentExternalSessionId: string | null;
    parentSessionId: string | null;
  },
  created: boolean,
  branchKind: BranchKind | null,
  createdAt: number,
  source: string | undefined,
): Promise<void> {
  if (created) {
    const resolvedParentSessionId = await resolveParentSession(db, row.sessionId, row.parentExternalSessionId, source);
    void bus
      .emit(SessionSubjects.created, {
        sessionId: row.sessionId,
        parentSessionId: resolvedParentSessionId,
        branchKind,
        createdAt,
      })
      .catch((err) => console.error('[SessionStorage] Failed to emit session.created:', err));
    return;
  }

  if (row.parentExternalSessionId !== null && row.parentSessionId === null) {
    await resolveParentSession(db, row.sessionId, row.parentExternalSessionId, source);
  }

  void bus
    .emit(SessionSubjects.updated, {
      sessionId: row.sessionId,
      changedProperties: ['source', 'targetWorkingDirectory', 'title'],
    })
    .catch((err) => console.error('[SessionStorage] Failed to emit session.updated:', err));
}

/**
 * Attempt to link a newly created imported session to its parent.
 * @param db - Drizzle database instance.
 * @param newSessionId - ID of the session that was just created.
 * @param parentExternalSessionId - External session ID of the intended parent, or null.
 * @param source - Source tool identity for the imported lineage.
 * @returns The resolved Makaio parent session ID, or null if not found.
 */
async function resolveParentSession(
  db: MakaioDatabase,
  newSessionId: string,
  parentExternalSessionId: string | null,
  source: string | undefined,
): Promise<string | null> {
  const { sessions } = resolveSchema(db, sessionStorageSchema);
  if (parentExternalSessionId === null || source === undefined) {
    return null;
  }

  const [parentRow] = await db
    .select({ sessionId: sessions.sessionId, rootSessionId: sessions.rootSessionId })
    .from(sessions)
    .where(and(eq(sessions.adapterSessionId, parentExternalSessionId), eq(sessions.source, source)))
    .limit(1);

  if (!parentRow) {
    return null;
  }

  const resolvedRootSessionId = parentRow.rootSessionId ?? parentRow.sessionId;
  await db
    .update(sessions)
    .set({ parentSessionId: parentRow.sessionId, rootSessionId: resolvedRootSessionId })
    .where(eq(sessions.sessionId, newSessionId));

  return parentRow.sessionId;
}
