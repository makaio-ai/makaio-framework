import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IMakaioSession, type MakaioSessionAgent } from '@makaio/contracts';
import type { ImportStatus, ImportUpsertRequest } from '@makaio/contracts/session';
import { SessionStorageSubjects } from './namespace.js';
import { kindToBranchKind } from '../import/lineage-utils.js';
import { createMonotonicClock } from './monotonic-clock.js';

type PopulateAgents = (bus: IMakaioBus, sessionId: string) => Promise<MakaioSessionAgent[]>;
type CloneSession = (session: IMakaioSession) => IMakaioSession;

interface MemoryImportHandlerDeps {
  bus: IMakaioBus;
  store: Map<string, IMakaioSession>;
  populateAgents: PopulateAgents;
  cloneSession: CloneSession;
}

interface ImportStatusCounts {
  total: number;
  imported: number;
  tracking: number;
  discovered: number;
}

const nextDiscoveredAt = createMonotonicClock();

/**
 * Assign a session field when the provided value is defined.
 * @param session - Session being mutated
 * @param key - Field to update
 * @param value - New value
 */
function assignDefinedSessionField<K extends keyof IMakaioSession>(
  session: IMakaioSession,
  key: K,
  value: IMakaioSession[K] | undefined,
): void {
  if (value !== undefined) {
    session[key] = value as IMakaioSession[K];
  }
}

/**
 * Builds the canonical imported session shape for a first discovery.
 * @param payload - Import upsert request payload
 * @param sessionId - New Makaio session ID
 * @param discoveredAt - Discovery timestamp
 * @returns Imported session record
 */
function createImportedSession(payload: ImportUpsertRequest, sessionId: string, discoveredAt: number): IMakaioSession {
  const createdAt = payload.startedAt ?? discoveredAt;
  const branchKind = kindToBranchKind(payload.kind);
  return {
    sessionId,
    createdAt,
    lastActivityAt: createdAt,
    agents: [],
    status: 'discovered',
    branchKind,
    adapterName: payload.source,
    adapterSessionId: payload.externalSessionId,
    adapterId: payload.adapterId,
    clientId: payload.clientId,
    isOrchestrated: false,
    isImported: true,
    title: payload.title ?? undefined,
    targetWorkingDirectory: payload.cwd ?? undefined,
    source: payload.source,
    parentExternalSessionId: payload.parentAdapterSessionId ?? undefined,
    logFilePath: payload.logFilePath ?? undefined,
    discoveredAt,
    importStatus: 'discovered',
    forkPointMessageId: payload.forkPointMessageId ?? undefined,
  };
}

/**
 * Applies canonical import identity fields to an existing session.
 * @param session - Existing session with the same adapter session ID
 * @param payload - Import upsert request payload
 * @param discoveredAt - Discovery timestamp for initializing missing provenance
 */
function convergeImportIdentity(session: IMakaioSession, payload: ImportUpsertRequest, discoveredAt: number): void {
  const nextImportStatus = session.importStatus ?? 'discovered';
  if (nextImportStatus === 'discovered') {
    session.status = 'discovered';
  }
  session.isImported = true;
  session.importStatus = nextImportStatus;
  session.adapterName ??= payload.source;
  session.adapterSessionId ??= payload.externalSessionId;
  session.source ??= payload.source;
  session.discoveredAt ??= discoveredAt;
}

/**
 * Applies import enrichment fields to an existing session.
 * @param session - Existing session with the same adapter session ID
 * @param payload - Import upsert request payload
 */
function convergeImportMetadata(session: IMakaioSession, payload: ImportUpsertRequest): void {
  if (payload.logFilePath !== undefined && payload.logFilePath !== null) {
    session.logFilePath ??= payload.logFilePath;
  }
  if (payload.cwd !== null) {
    session.targetWorkingDirectory = payload.cwd;
  }
  if (payload.title !== undefined && payload.title !== null) {
    session.title = payload.title;
  }
  if (payload.forkPointMessageId !== null) {
    session.forkPointMessageId = payload.forkPointMessageId;
  }
  if (payload.parentAdapterSessionId !== null) {
    session.parentExternalSessionId = payload.parentAdapterSessionId;
  }
  const branchKind = kindToBranchKind(payload.kind);
  if (branchKind !== undefined) {
    session.branchKind = branchKind;
  }
  assignDefinedSessionField(session, 'adapterId', payload.adapterId);
  assignDefinedSessionField(session, 'clientId', payload.clientId);
}

/**
 * Updates stub timestamps when a later import scan finds the real start time.
 * @param session - Existing session with the same adapter session ID
 * @param payload - Import upsert request payload
 * @param previousDiscoveredAt - Discovery timestamp before convergence
 */
function convergeImportTimestamps(
  session: IMakaioSession,
  payload: ImportUpsertRequest,
  previousDiscoveredAt: number | undefined,
): void {
  if (payload.startedAt === undefined) {
    return;
  }
  if (previousDiscoveredAt === undefined || session.createdAt === previousDiscoveredAt) {
    session.createdAt = payload.startedAt;
  }
  if (previousDiscoveredAt === undefined || session.lastActivityAt === previousDiscoveredAt) {
    session.lastActivityAt = payload.startedAt;
  }
}

/**
 * Applies import conflict convergence to an existing in-memory session.
 * @param session - Existing session with the same adapter session ID
 * @param payload - Import upsert request payload
 * @param discoveredAt - Discovery timestamp for initializing missing provenance
 */
function convergeImportedSession(session: IMakaioSession, payload: ImportUpsertRequest, discoveredAt: number): void {
  const previousDiscoveredAt = session.discoveredAt;
  convergeImportIdentity(session, payload, discoveredAt);
  convergeImportMetadata(session, payload);
  convergeImportTimestamps(session, payload, previousDiscoveredAt);
}

/**
 * Resolve parent links for a newly discovered memory import when possible.
 * @param store - In-memory session store
 * @param session - Newly inserted imported session
 */
function resolveMemoryImportParent(store: Map<string, IMakaioSession>, session: IMakaioSession): void {
  if (session.parentExternalSessionId === undefined) {
    return;
  }
  const source = session.source ?? session.adapterName;
  const parent = Array.from(store.values()).find(
    (candidate) =>
      candidate.adapterSessionId === session.parentExternalSessionId &&
      (candidate.source ?? candidate.adapterName) === source,
  );
  if (!parent) {
    return;
  }
  session.parentSessionId = parent.sessionId;
  session.rootSessionId = parent.rootSessionId ?? parent.sessionId;
}

/**
 * Emit the storage lifecycle event for a memory import upsert.
 * @param bus - Bus instance
 * @param session - Imported session
 * @param created - Whether the row was inserted
 */
function emitMemoryImportUpsertLifecycle(bus: IMakaioBus, session: IMakaioSession, created: boolean): void {
  if (created) {
    void bus
      .emit(SessionSubjects.created, {
        sessionId: session.sessionId,
        parentSessionId: session.parentSessionId ?? null,
        branchKind: session.branchKind ?? null,
        createdAt: session.createdAt,
      })
      .catch((err) => console.error('[SessionStorage] Failed to emit session.created:', err));
    return;
  }

  void bus
    .emit(SessionSubjects.updated, {
      sessionId: session.sessionId,
      changedProperties: ['source', 'targetWorkingDirectory', 'title'],
    })
    .catch((err) => console.error('[SessionStorage] Failed to emit session.updated:', err));
}

/**
 * Count imported sessions by import lifecycle buckets.
 * @param sessions - Imported sessions for one source
 * @returns Import counts
 */
function countImportStatuses(sessions: IMakaioSession[]): ImportStatusCounts {
  let imported = 0;
  let tracking = 0;
  let discovered = 0;
  for (const session of sessions) {
    if (session.importStatus === 'imported') {
      imported += 1;
    }
    if (session.importStatus === 'tracking') {
      tracking += 1;
    }
    if (session.importStatus === 'discovered') {
      discovered += 1;
    }
  }
  return { total: sessions.length, imported, tracking, discovered };
}

/**
 * Emit import status lifecycle events for memory storage.
 * @param bus - Bus instance
 * @param session - Updated imported session
 * @param importStatus - New import status
 */
function emitMemoryImportStatusChanged(bus: IMakaioBus, session: IMakaioSession, importStatus: ImportStatus): void {
  void bus
    .emit(SessionSubjects.importStatusChanged, { sessionId: session.sessionId, importStatus })
    .catch((err) => console.error('[SessionStorage] Failed to emit session.importStatusChanged:', err));

  const source = session.source ?? session.adapterName;
  if (importStatus !== 'imported' || session.adapterSessionId === undefined || source === undefined) {
    return;
  }

  void bus
    .emit(SessionSubjects.import.completed, {
      sessionId: session.sessionId,
      adapterSessionId: session.adapterSessionId,
      source,
    })
    .catch((err) => console.error('[SessionStorage] Failed to emit session.import.completed:', err));
}

/**
 * Register in-memory import-specific session storage handlers.
 * @param deps - Handler dependencies
 * @returns Cleanup functions for import handlers
 */
export function registerMemorySessionImportHandlers(deps: MemoryImportHandlerDeps): Array<() => void> {
  const { bus, store, cloneSession, populateAgents } = deps;
  return [
    bus.on(SessionStorageSubjects.importUpsert, (ctx) => {
      const payload = ctx.payload;
      const existing = Array.from(store.values()).find((session) => {
        return session.adapterSessionId === payload.externalSessionId && session.source === payload.source;
      });
      const discoveredAt = nextDiscoveredAt();
      const created = existing === undefined;
      const session = existing ?? createImportedSession(payload, crypto.randomUUID(), discoveredAt);

      if (existing) {
        convergeImportedSession(existing, payload, discoveredAt);
        if (existing.parentExternalSessionId !== undefined && existing.parentSessionId === undefined) {
          resolveMemoryImportParent(store, existing);
        }
      } else {
        store.set(session.sessionId, session);
        resolveMemoryImportParent(store, session);
      }

      emitMemoryImportUpsertLifecycle(bus, session, created);
      ctx.setResult({ sessionId: session.sessionId, created });
    }),
    bus.on(SessionStorageSubjects.getByLogFilePath, async (ctx) => {
      const session = Array.from(store.values()).find((candidate) => candidate.logFilePath === ctx.payload.logFilePath);
      if (!session) {
        ctx.setResult({ session: null });
        return;
      }
      const agents = await populateAgents(bus, session.sessionId);
      ctx.setResult({ session: { ...cloneSession(session), agents } });
    }),
    bus.on(SessionStorageSubjects.listImported, async (ctx) => {
      const { source, importStatus } = ctx.payload;
      const sessions = Array.from(store.values())
        .filter((session) => session.isImported === true)
        .filter((session) => source === undefined || session.source === source)
        .filter((session) => importStatus === undefined || session.importStatus === importStatus)
        .sort((a, b) => b.createdAt - a.createdAt);
      const sessionsWithAgents = await Promise.all(
        sessions.map(async (session) => ({
          ...cloneSession(session),
          agents: await populateAgents(bus, session.sessionId),
        })),
      );
      ctx.setResult({ sessions: sessionsWithAgents });
    }),
    bus.on(SessionStorageSubjects.countBySource, (ctx) => {
      const sessions = Array.from(store.values()).filter(
        (session) => session.isImported === true && session.source === ctx.payload.source,
      );
      ctx.setResult(countImportStatuses(sessions));
    }),
    bus.on(SessionStorageSubjects.updateImportStatus, (ctx) => {
      const session = store.get(ctx.payload.sessionId);
      const importStatus = ctx.payload.importStatus;
      if (!session || session.importStatus === importStatus) {
        ctx.setResult({ success: false });
        return;
      }

      session.importStatus = importStatus;
      if (importStatus === 'imported' && session.status === 'discovered') {
        session.status = 'active';
      }
      ctx.setResult({ success: true });
      emitMemoryImportStatusChanged(bus, session, importStatus);
    }),
  ];
}
