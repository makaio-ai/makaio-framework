import type { IMakaioBus } from '@makaio/bus-core';
import {
  type IMakaioSession,
  type MakaioSessionAgent,
  SessionStorageSetRequestSchema,
  SessionStorageUpdateSchema,
} from '@makaio/contracts';
import type { z } from 'zod';
import { SessionStorageSubjects } from './namespace.js';
import { AgentStorageSubjects } from './agent-namespace.js';
import {
  assertSessionClientAccountStateIsConsistent,
  emitSessionClientAccountChangedIfNeeded,
} from './client-account-change-events.js';
import { registerMemorySessionImportHandlers } from './memory-import-handlers.js';

// NOTE: do NOT change without explicit human approval
/* eslint max-lines-per-function: ["error", { "max": 145 }] */

/**
 * Populate a session's agents array from agent storage.
 * @param bus - The bus instance to query agent storage
 * @param sessionId - Session ID to fetch agents for
 * @returns Array of agents for the session
 */
async function populateAgents(bus: IMakaioBus, sessionId: string): Promise<MakaioSessionAgent[]> {
  const agentsResult = await bus.requestOptional(AgentStorageSubjects.listBySession, { sessionId });
  return agentsResult.handled ? agentsResult.data.agents : [];
}

interface SessionListFilters {
  status: 'active' | 'closed' | 'archived' | 'discovered' | 'all';
  executionTargetId?: string;
}

type SessionUpdatePayload = z.infer<typeof SessionStorageUpdateSchema.request>;

/**
 * Clone a session record so in-memory storage never keeps caller-owned references.
 * @param session - Session to clone
 * @returns Detached copy
 */
function cloneSession(session: IMakaioSession): IMakaioSession {
  return structuredClone(session);
}

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
 * Assign an optional session field where null means "clear to undefined".
 * @param session - Session being mutated
 * @param key - Field to update
 * @param value - Nullable new value
 */
function assignNullableSessionField<K extends keyof IMakaioSession>(
  session: IMakaioSession,
  key: K,
  value: IMakaioSession[K] | null | undefined,
): void {
  if (value !== undefined) {
    session[key] = (value ?? undefined) as IMakaioSession[K];
  }
}

/**
 * Applies list filters for in-memory sessions.
 * @param sessions - Session collection
 * @param filters - List request filters
 * @returns Filtered sessions
 */
function applyListFilters(sessions: IMakaioSession[], filters: SessionListFilters): IMakaioSession[] {
  let filtered = sessions;
  if (filters.status !== 'all') {
    filtered = filtered.filter((session) => session.status === filters.status);
  }
  if (filters.executionTargetId !== undefined) {
    filtered = filtered.filter((session) => session.executionTargetId === filters.executionTargetId);
  }
  return filtered;
}

/**
 * Carry the stored adapter-session currency across a whole-record `set`.
 *
 * Mirrors the Drizzle backend, whose `set` column list deliberately omits the
 * currency pair: `set` writes a caller-held snapshot, so letting it carry
 * currency would allow a writer that read the session before a provider-session
 * movement to resurrect the abandoned provider session. Currency is owned
 * exclusively by the targeted `storage:session.update` path.
 * @param next - Incoming session record about to be stored
 * @param previous - Currently stored record, or `null` on first insert
 */
function preserveAdapterSessionCurrency(next: IMakaioSession, previous: IMakaioSession | null): void {
  next.currentAdapterSessionId = previous?.currentAdapterSessionId;
  next.currentAdapterSessionIdState = previous?.currentAdapterSessionIdState ?? 'inherited';
}

/**
 * Apply the adapter-session currency pair as one unit.
 *
 * The two columns carry a single fact, and the SQL backends enforce that with
 * `sessions_current_adapter_session_id_currency_check`. Applying them through
 * the generic per-field assigners would let a half-supplied payload leave this
 * backend holding a pair the SQL backends would have rejected — a silent
 * behavioral divergence between the in-memory and Drizzle handlers. The update
 * request schema rejects such payloads before either backend sees them
 * (`validateAdapterSessionCurrencyPair`); applying the pair atomically here
 * keeps that guarantee local instead of borrowed.
 * @param session - Session to mutate
 * @param update - Partial update payload
 */
function applyAdapterSessionCurrency(session: IMakaioSession, update: SessionUpdatePayload): void {
  const { currentAdapterSessionId: id, currentAdapterSessionIdState: state } = update;
  if (id === undefined || state === undefined) return;
  session.currentAdapterSessionId = id ?? undefined;
  session.currentAdapterSessionIdState = state;
}

/**
 * Applies partial update payload to an in-memory session.
 * @param session - Session to mutate
 * @param update - Partial update payload
 */
function applySessionUpdate(session: IMakaioSession, update: SessionUpdatePayload): void {
  assignDefinedSessionField(session, 'status', update.status);
  assignDefinedSessionField(session, 'parentSessionId', update.parentSessionId);
  assignDefinedSessionField(session, 'contextInheritance', update.contextInheritance);
  assignDefinedSessionField(session, 'rootSessionId', update.rootSessionId);
  assignDefinedSessionField(session, 'forkPointMessageId', update.forkPointMessageId);
  assignDefinedSessionField(session, 'branchKind', update.branchKind);
  assignDefinedSessionField(session, 'isOrchestrated', update.isOrchestrated);
  assignDefinedSessionField(session, 'clientId', update.clientId);
  assignDefinedSessionField(session, 'clientAccountId', update.clientAccountId);
  assignDefinedSessionField(session, 'lastClientIdentityObservation', update.lastClientIdentityObservation);
  assignDefinedSessionField(session, 'title', update.title);
  assignDefinedSessionField(session, 'targetWorkingDirectory', update.targetWorkingDirectory);
  assignDefinedSessionField(session, 'createdAt', update.createdAt);
  assignDefinedSessionField(session, 'lastActivityAt', update.lastActivityAt);
  assignDefinedSessionField(session, 'machineId', update.machineId);
  applyAdapterSessionCurrency(session, update);

  assignNullableSessionField(session, 'executionTargetId', update.executionTargetId);
  assignNullableSessionField(session, 'approvalPolicyOverride', update.approvalPolicyOverride);
  assignNullableSessionField(session, 'metadata', update.metadata);
  if (update.spawningToolCallId === null) {
    session.spawningToolCallId = undefined;
  } else if (update.spawningToolCallId !== undefined && session.spawningToolCallId === undefined) {
    session.spawningToolCallId = update.spawningToolCallId;
  }
}

/**
 * Registers memory list handler.
 * @param bus - Bus instance
 * @param store - In-memory session store
 * @returns Cleanup function
 */
function registerListHandler(bus: IMakaioBus, store: Map<string, IMakaioSession>): () => void {
  return bus.on(SessionStorageSubjects.list, async (ctx) => {
    const { status = 'all', limit, offset = 0, includePreview = false, executionTargetId } = ctx.payload;

    let sessions = applyListFilters(Array.from(store.values()), {
      status,
      executionTargetId,
    });
    sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const total = sessions.length;

    if (limit !== undefined) {
      sessions = sessions.slice(offset, offset + limit);
    }

    const sessionsWithAgents = await Promise.all(
      sessions.map(async (session) => ({
        ...cloneSession(session),
        agents: await populateAgents(bus, session.sessionId),
      })),
    );

    const result = includePreview
      ? sessionsWithAgents.map((session) => ({ ...session, preview: { messageCount: 0, firstUserMessage: null } }))
      : sessionsWithAgents;

    ctx.setResult({ sessions: result, total });
  });
}

/**
 * Registers memory update handler.
 * @param bus - Bus instance
 * @param store - In-memory session store
 * @returns Cleanup function
 */
function registerUpdateHandler(bus: IMakaioBus, store: Map<string, IMakaioSession>): () => void {
  return bus.on(SessionStorageSubjects.update, async (ctx) => {
    const payload = structuredClone(SessionStorageUpdateSchema.request.parse(ctx.payload));
    const session = store.get(payload.sessionId);
    if (!session) {
      ctx.setResult({ success: false, clientAccountChanged: false });
      return;
    }
    const previous = cloneSession(session);
    assertSessionClientAccountStateIsConsistent(previous, {
      sessionId: session.sessionId,
      clientId: payload.clientId ?? session.clientId,
      clientAccountId: payload.clientAccountId ?? session.clientAccountId,
      lastClientIdentityObservation: payload.lastClientIdentityObservation ?? session.lastClientIdentityObservation,
    });
    applySessionUpdate(session, payload);
    ctx.setResult({
      success: true,
      clientAccountChanged: (previous.clientAccountId ?? null) !== (session.clientAccountId ?? null),
    });
    emitSessionClientAccountChangedIfNeeded(bus, previous, cloneSession(session));
  });
}
/**
 * Register in-memory session storage handlers.
 *
 * Suitable for development, testing, and single-instance deployments.
 * Data is lost when the process exits.
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerMemorySessionStorage } from '@makaio/services-core/session';
 *
 * const cleanup = registerMemorySessionStorage(bus);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerMemorySessionStorage(bus: IMakaioBus): () => void {
  const store = new Map<string, IMakaioSession>();
  const unsubs: Array<() => void> = [];
  // storage:session.get
  unsubs.push(
    bus.on(SessionStorageSubjects.get, async (ctx) => {
      const session = store.get(ctx.payload.sessionId);
      if (!session) {
        ctx.setResult({ session: null });
        return;
      }

      // Populate agents[] from agent storage (simulates JOIN in drizzle handler)
      const agents = await populateAgents(bus, ctx.payload.sessionId);
      ctx.setResult({ session: { ...cloneSession(session), agents } });
    }),
  );
  // storage:session.set
  unsubs.push(
    bus.on(SessionStorageSubjects.set, async (ctx) => {
      const { sessionId, session, ifAbsent } = SessionStorageSetRequestSchema.parse(ctx.payload);
      if (ifAbsent && store.has(sessionId)) {
        ctx.setResult({ success: false, clientAccountChanged: false });
        return;
      }
      const detachedSession = structuredClone(session);
      const previous = store.get(sessionId) ?? null;
      const previousSession = previous ? cloneSession(previous) : null;
      preserveAdapterSessionCurrency(detachedSession, previousSession);
      assertSessionClientAccountStateIsConsistent(previous, detachedSession);
      store.set(sessionId, detachedSession);
      ctx.setResult({
        success: true,
        clientAccountChanged: (previousSession?.clientAccountId ?? null) !== (detachedSession.clientAccountId ?? null),
      });
      emitSessionClientAccountChangedIfNeeded(bus, previousSession, cloneSession(detachedSession));
    }),
  );
  // storage:session.delete
  unsubs.push(
    bus.on(SessionStorageSubjects.delete, async (ctx) => {
      store.delete(ctx.payload.sessionId);
      ctx.setResult({ success: true });
      await ctx.next();
    }),
  );
  // storage:session.list
  unsubs.push(registerListHandler(bus, store));
  // storage:session.getChildren
  unsubs.push(
    bus.on(SessionStorageSubjects.getChildren, (ctx) => {
      const { sessionId } = ctx.payload;
      const sessions = Array.from(store.values());
      const childSessions = sessions.filter((s) => s.parentSessionId === sessionId);
      const parentIds = new Set(sessions.map((s) => s.parentSessionId).filter((id): id is string => Boolean(id)));

      const children = childSessions.map((child) => ({
        sessionId: child.sessionId,
        title: child.title ?? null,
        forkPointMessageId: child.forkPointMessageId ?? null,
        branchKind: child.branchKind ?? null,
        messageCount: 0,
        hasChildren: parentIds.has(child.sessionId),
        spawningToolCallId: child.spawningToolCallId,
      }));

      ctx.setResult({ children });
    }),
  );

  // storage:session.getStatusCounts
  unsubs.push(
    bus.on(SessionStorageSubjects.getStatusCounts, (ctx) => {
      void ctx.payload;
      const sessions = Array.from(store.values());
      const active = sessions.filter((s) => s.status === 'active').length;
      const closed = sessions.filter((s) => s.status === 'closed').length;
      const archived = sessions.filter((s) => s.status === 'archived').length;
      const discovered = sessions.filter((s) => s.status === 'discovered').length;
      ctx.setResult({ all: active + closed + archived + discovered, active, closed, archived, discovered });
    }),
  );

  // storage:session.update - partial update of session fields
  unsubs.push(registerUpdateHandler(bus, store));

  // storage:session.getByAdapterSessionId
  unsubs.push(registerGetByAdapterSessionIdHandler(bus, store));
  unsubs.push(...registerMemorySessionImportHandlers({ bus, store, populateAgents, cloneSession }));

  return () => unsubs.forEach((fn) => fn());
}

/**
 * Register handler for storage:session.getByAdapterSessionId.
 * @param bus - The bus instance to register handlers on
 * @param store - The in-memory session store
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetByAdapterSessionIdHandler(bus: IMakaioBus, store: Map<string, IMakaioSession>): () => void {
  return bus.on(SessionStorageSubjects.getByAdapterSessionId, async (ctx) => {
    const { adapterSessionId, source, adapterName } = ctx.payload;
    const matches = Array.from(store.values()).filter(
      (session) =>
        session.adapterSessionId !== undefined &&
        session.adapterSessionId === adapterSessionId &&
        (source === undefined || session.source === source) &&
        (adapterName === undefined || session.adapterName === adapterName),
    );

    const session = matches[0];
    if (matches.length !== 1 || session === undefined) {
      ctx.setResult({ session: null });
      return;
    }

    // Populate agents[] from agent storage (simulates JOIN in drizzle handler)
    const agentsResult = await bus.requestOptional(AgentStorageSubjects.listBySession, {
      sessionId: session.sessionId,
    });
    const agents = agentsResult.handled ? agentsResult.data.agents : [];

    ctx.setResult({ session: { ...cloneSession(session), agents } });
  });
}
