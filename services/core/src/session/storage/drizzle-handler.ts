import { eq, desc, count, inArray, and, sql, type SQL } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionStorageSetRequestSchema,
  SessionStorageUpdateSchema,
  type ExtensionContext,
  type IMakaioSession,
} from '@makaio/contracts';
import type { z } from 'zod';
import { SessionStorageSubjects, type SessionWithPreview } from './namespace.js';
import { messages } from '../messages/schema.js';
import { sessions, agents } from './schema.js';
import {
  buildClientAccountBaselinePredicate,
  CLIENT_ACCOUNT_WRITE_RETRY_LIMIT,
} from './client-account-write-guards.js';
import { fetchSessionPreviewMaps, mapAgentsBySession, mapToSession } from './drizzle-utils.js';
import {
  assertSessionClientAccountStateIsConsistent,
  emitSessionClientAccountChangedIfNeeded,
} from './client-account-change-events.js';
import { buildNextSessionClientAccountState, touchesClientAccountState } from './client-account-update-state.js';
import { registerGetByAdapterSessionIdHandler } from './drizzle-get-by-adapter-session-id-handler.js';
import { registerDrizzleSessionImportHandlers } from './drizzle-import-handlers.js';

/**
 * Handler dependencies for session storage handlers.
 */
export interface SessionHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
}

type SessionInsertValues = typeof sessions.$inferInsert;
type SessionUpdateFields = Partial<Omit<SessionInsertValues, 'spawningToolCallId'>> & {
  spawningToolCallId?: SessionInsertValues['spawningToolCallId'] | SQL;
};
type ClientIdentityObservation = IMakaioSession['lastClientIdentityObservation'];
type SessionUpdatePayload = z.infer<typeof SessionStorageUpdateSchema.request>;

/**
 * Convert an optional API field into a nullable database column value.
 * @param value - API value that may be undefined.
 * @returns Database-ready value using null for absence.
 */
function toNullableDbValue<T>(value: T | undefined): T | null {
  return value ?? null;
}

/**
 * Serialize fork transforms for storage.
 * @param forkTransforms - Session fork transforms.
 * @returns JSON blob for persistence, or null when absent.
 */
function serializeForkTransforms(forkTransforms: IMakaioSession['forkTransforms']): string | null {
  return forkTransforms ? JSON.stringify(forkTransforms) : null;
}

/**
 * Map MakaioSession to DB column values (for insert/update).
 * @param session - The session to convert
 * @returns DB column values for insert/update operations
 */
function toDbValues(session: IMakaioSession) {
  return {
    lastActivityAt: session.lastActivityAt,
    status: session.status,
    leadAgentId: toNullableDbValue(session.leadAgentId),
    parentSessionId: toNullableDbValue(session.parentSessionId),
    contextInheritance: toNullableDbValue(session.contextInheritance),
    rootSessionId: toNullableDbValue(session.rootSessionId),
    forkPointMessageId: toNullableDbValue(session.forkPointMessageId),
    branchKind: toNullableDbValue(session.branchKind),
    adapterName: toNullableDbValue(session.adapterName),
    adapterSessionId: toNullableDbValue(session.adapterSessionId),
    adapterId: toNullableDbValue(session.adapterId),
    clientId: toNullableDbValue(session.clientId),
    clientAccountId: toNullableDbValue(session.clientAccountId),
    lastClientIdentityObservation: serializeClientIdentityObservation(session.lastClientIdentityObservation),
    isOrchestrated: session.isOrchestrated ?? false,
    isImported: session.isImported ?? false,
    title: toNullableDbValue(session.title),
    summary: toNullableDbValue(session.summary),
    summaryUpdatedAt: toNullableDbValue(session.summaryUpdatedAt),
    forkTransforms: serializeForkTransforms(session.forkTransforms),
    targetWorkingDirectory: toNullableDbValue(session.targetWorkingDirectory),
    executionTargetId: toNullableDbValue(session.executionTargetId),
    approvalPolicyOverride: toNullableDbValue(session.approvalPolicyOverride),
    spawningToolCallId: toNullableDbValue(session.spawningToolCallId),
    // Import provenance fields (null for live sessions)
    source: toNullableDbValue(session.source),
    parentExternalSessionId: toNullableDbValue(session.parentExternalSessionId),
    logFilePath: toNullableDbValue(session.logFilePath),
    discoveredAt: toNullableDbValue(session.discoveredAt),
    importStatus: toNullableDbValue(session.importStatus),
  };
}

/**
 * Serializes the latest client identity observation for persistence.
 * @param observation - Latest observed client identity payload, if any
 * @returns JSON string for storage, or null when no observation is present
 */
function serializeClientIdentityObservation(observation: ClientIdentityObservation | undefined): string | null {
  return observation ? JSON.stringify(observation) : null;
}

/**
 * Assign a field when the provided value is defined.
 * @param target - Mutable update object
 * @param key - Session column key to write
 * @param value - Value to assign when defined
 */
function assignDefinedField<K extends keyof SessionInsertValues>(
  target: SessionUpdateFields,
  key: K,
  value: SessionInsertValues[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value as SessionUpdateFields[K];
  }
}

/**
 * Assign a nullable field when the provided value is defined.
 * Undefined means "leave unchanged"; null means "clear the column".
 * @param target - Mutable update object
 * @param key - Session column key to write
 * @param value - Nullable value from the update payload
 */
function assignNullableField<K extends keyof SessionInsertValues>(
  target: SessionUpdateFields,
  key: K,
  value: SessionInsertValues[K] | null | undefined,
): void {
  if (value !== undefined) {
    target[key] = (value ?? null) as SessionUpdateFields[K];
  }
}

/**
 * Build the partial update object for storage:session.update.
 * @param payload - Session update payload
 * @returns Drizzle-compatible update fields
 */
function buildSessionUpdateFields(payload: SessionUpdatePayload): SessionUpdateFields {
  const updateFields: SessionUpdateFields = {};

  assignDefinedField(updateFields, 'status', payload.status);
  assignDefinedField(updateFields, 'parentSessionId', payload.parentSessionId);
  assignDefinedField(updateFields, 'contextInheritance', payload.contextInheritance);
  assignDefinedField(updateFields, 'rootSessionId', payload.rootSessionId);
  assignDefinedField(updateFields, 'forkPointMessageId', payload.forkPointMessageId);
  assignDefinedField(updateFields, 'branchKind', payload.branchKind);
  assignDefinedField(updateFields, 'isOrchestrated', payload.isOrchestrated);
  assignDefinedField(updateFields, 'clientId', payload.clientId);
  assignDefinedField(updateFields, 'clientAccountId', payload.clientAccountId);
  assignDefinedField(updateFields, 'title', payload.title);
  assignDefinedField(updateFields, 'targetWorkingDirectory', payload.targetWorkingDirectory);
  assignDefinedField(updateFields, 'createdAt', payload.createdAt);
  assignDefinedField(updateFields, 'lastActivityAt', payload.lastActivityAt);

  assignNullableField(updateFields, 'executionTargetId', payload.executionTargetId);
  assignNullableField(updateFields, 'approvalPolicyOverride', payload.approvalPolicyOverride);
  if (payload.spawningToolCallId === null) {
    updateFields.spawningToolCallId = null;
  } else if (payload.spawningToolCallId !== undefined) {
    updateFields.spawningToolCallId = sql`coalesce(${sessions.spawningToolCallId}, ${payload.spawningToolCallId})`;
  }
  if (payload.lastClientIdentityObservation !== undefined) {
    updateFields.lastClientIdentityObservation = serializeClientIdentityObservation(
      payload.lastClientIdentityObservation,
    );
  }

  return updateFields;
}

/**
 * Register handler for storage:session.get.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(SessionStorageSubjects.get, async (ctx) => {
    const [sessionRow] = await db.select().from(sessions).where(eq(sessions.sessionId, ctx.payload.sessionId)).limit(1);
    if (!sessionRow) {
      ctx.setResult({ session: null });
      return;
    }
    const agentRows = await db.select().from(agents).where(eq(agents.sessionId, ctx.payload.sessionId));
    ctx.setResult({ session: mapToSession(sessionRow, agentRows) });
  });
}

/**
 * Register handler for storage:session.set.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerSetHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(SessionStorageSubjects.set, async (ctx) => {
    const { sessionId, session, ifAbsent } = SessionStorageSetRequestSchema.parse(ctx.payload);
    const dbValues = toDbValues(session);
    if (ifAbsent) {
      assertSessionClientAccountStateIsConsistent(null, session);
      const insertResult = await db
        .insert(sessions)
        .values({ sessionId, createdAt: session.createdAt, ...dbValues })
        .onConflictDoNothing();
      const inserted = (insertResult.rowsAffected ?? 0) > 0;
      ctx.setResult({ success: inserted, clientAccountChanged: inserted && session.clientAccountId !== undefined });
      if (inserted) {
        emitSessionClientAccountChangedIfNeeded(bus, null, session);
      }
      return;
    }
    for (let attempt = 0; attempt < CLIENT_ACCOUNT_WRITE_RETRY_LIMIT; attempt++) {
      const [previousRow] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
      const previousSession = previousRow ? mapToSession(previousRow, []) : null;
      assertSessionClientAccountStateIsConsistent(previousSession, session);

      const result = await db
        .insert(sessions)
        .values({ sessionId, createdAt: session.createdAt, ...dbValues })
        .onConflictDoUpdate({
          target: sessions.sessionId,
          set: dbValues,
          setWhere: buildClientAccountBaselinePredicate(previousRow),
        });

      if ((result.rowsAffected ?? 0) === 0) {
        continue;
      }

      ctx.setResult({
        success: true,
        clientAccountChanged: (previousSession?.clientAccountId ?? null) !== (session.clientAccountId ?? null),
      });
      emitSessionClientAccountChangedIfNeeded(bus, previousSession, session);
      return;
    }
    throw new Error(`Failed to write session "${sessionId}" with a stable client-account baseline`);
  });
}

/**
 * Register handler for storage:session.delete.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerDeleteHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(SessionStorageSubjects.delete, async (ctx) => {
    await db.delete(sessions).where(eq(sessions.sessionId, ctx.payload.sessionId));
    ctx.setResult({ success: true });
  });
}

/**
 * Register handler for storage:session.update.
 *
 * Performs partial update of session fields without touching agents.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(SessionStorageSubjects.update, async (ctx) => {
    const payload = SessionStorageUpdateSchema.request.parse(ctx.payload);
    const { sessionId } = payload;
    const updateFields = buildSessionUpdateFields(payload);
    const updatesClientAccountState = touchesClientAccountState(payload);
    // Skip if no fields to update
    if (Object.keys(updateFields).length === 0) {
      ctx.setResult({ success: true, clientAccountChanged: false });
      return;
    }
    if (!updatesClientAccountState) {
      const result = await db.update(sessions).set(updateFields).where(eq(sessions.sessionId, sessionId));
      ctx.setResult({ success: (result.rowsAffected ?? 0) > 0, clientAccountChanged: false });
      return;
    }
    for (let attempt = 0; attempt < CLIENT_ACCOUNT_WRITE_RETRY_LIMIT; attempt++) {
      const [previousRow] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
      if (!previousRow) {
        ctx.setResult({ success: false, clientAccountChanged: false });
        return;
      }
      const previousSession = mapToSession(previousRow, []);
      const nextSession = buildNextSessionClientAccountState(previousSession, payload);
      assertSessionClientAccountStateIsConsistent(previousSession, nextSession);
      const result = await db
        .update(sessions)
        .set(updateFields)
        .where(and(eq(sessions.sessionId, sessionId), buildClientAccountBaselinePredicate(previousRow)));
      if ((result.rowsAffected ?? 0) === 0) {
        continue;
      }
      ctx.setResult({
        success: true,
        clientAccountChanged: (previousSession.clientAccountId ?? null) !== (nextSession.clientAccountId ?? null),
      });
      emitSessionClientAccountChangedIfNeeded(bus, previousSession, nextSession);
      return;
    }
    throw new Error(`Failed to update session "${sessionId}" with a stable client-account baseline`);
  });
}

/**
 * Builds filter predicates for session list queries.
 * @param filters - Filter criteria
 * @returns Combined SQL predicate, or undefined when no filters apply
 */
function buildListPredicates(filters: {
  status: 'active' | 'closed' | 'archived' | 'discovered' | 'all';
  executionTargetId?: string;
}): SQL | undefined {
  const predicates: SQL[] = [];
  if (filters.status !== 'all') {
    predicates.push(eq(sessions.status, filters.status));
  }
  if (filters.executionTargetId !== undefined) {
    predicates.push(eq(sessions.executionTargetId, filters.executionTargetId));
  }
  // Drizzle's and() with no args returns undefined, which .where() treats
  // as "no filter" — equivalent to the prior explicit ternary guard.
  return and(...predicates);
}

/**
 * Register handler for storage:session.list with optional preview data.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerListHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(SessionStorageSubjects.list, async (ctx) => {
    const { status = 'all', limit, offset = 0, includePreview = false, executionTargetId } = ctx.payload;
    const whereClause = buildListPredicates({
      status,
      executionTargetId,
    });

    // Build base query with optional filters
    const baseQuery = whereClause ? db.select().from(sessions).where(whereClause) : db.select().from(sessions);

    // Fetch sessions ordered by last activity, with optional pagination
    const sessionRows =
      limit !== undefined
        ? await baseQuery.orderBy(desc(sessions.lastActivityAt)).limit(limit).offset(offset)
        : await baseQuery.orderBy(desc(sessions.lastActivityAt));

    // Get total count for pagination
    const countQuery = whereClause
      ? db.select({ count: count() }).from(sessions).where(whereClause)
      : db.select({ count: count() }).from(sessions);
    const [countResult] = await countQuery;
    const total = countResult?.count ?? 0;

    if (sessionRows.length === 0) {
      ctx.setResult({ sessions: [], total });
      return;
    }

    const sessionIds = sessionRows.map((row) => row.sessionId);

    // Batch fetch agents only for listed sessions
    const allAgentRows = await db.select().from(agents).where(inArray(agents.sessionId, sessionIds));
    const agentsBySession = mapAgentsBySession(allAgentRows);
    const { previewBySession, countBySession } = await fetchSessionPreviewMaps(db, sessionIds, includePreview);

    // Map to response format
    const result: SessionWithPreview[] = sessionRows.map((row) => {
      const session = mapToSession(row, agentsBySession.get(row.sessionId) ?? []);
      if (includePreview && previewBySession && countBySession) {
        return {
          ...session,
          preview: {
            messageCount: countBySession.get(row.sessionId) ?? 0,
            firstUserMessage: previewBySession.get(row.sessionId) ?? null,
          },
        };
      }
      return session;
    });

    ctx.setResult({ sessions: result, total });
  });
}

/**
 * Register handler for storage:session.getChildren - direct children with enriched data.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetChildrenHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

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

    // Translate adapter fork point IDs to Makaio message IDs
    // The sessions table stores adapter_message_id as forkPointMessageId (from imports)
    // but the UI needs the Makaio message_id to match against turn.id
    const adapterForkPointIds = childRows.map((c) => c.forkPointMessageId).filter((id): id is string => id !== null);
    const forkPointMapping = new Map<string, string>();

    if (adapterForkPointIds.length > 0) {
      const forkPointRows = await db
        .select({ messageId: messages.messageId, adapterMessageId: messages.adapterMessageId })
        .from(messages)
        .where(inArray(messages.adapterMessageId, adapterForkPointIds));

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

/**
 * Register handler for storage:session.getStatusCounts.
 *
 * Efficiently counts sessions by status using GROUP BY.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetStatusCountsHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(SessionStorageSubjects.getStatusCounts, async (ctx) => {
    void ctx.payload;

    // Query with GROUP BY status to get counts per status
    const countRows = await db
      .select({ status: sessions.status, count: count() })
      .from(sessions)
      .groupBy(sessions.status);

    // Initialize counts
    let activeCount = 0;
    let closedCount = 0;
    let archivedCount = 0;
    let discoveredCount = 0;

    // Aggregate counts from GROUP BY results
    for (const row of countRows) {
      if (row.status === 'active') {
        activeCount = row.count;
      } else if (row.status === 'closed') {
        closedCount = row.count;
      } else if (row.status === 'archived') {
        archivedCount = row.count;
      } else if (row.status === 'discovered') {
        discoveredCount = row.count;
      }
    }

    const totalCount = activeCount + closedCount + archivedCount + discoveredCount;

    ctx.setResult({
      all: totalCount,
      active: activeCount,
      closed: closedCount,
      archived: archivedCount,
      discovered: discoveredCount,
    });
  });
}

/**
 * Register Drizzle-based session storage handlers.
 *
 * Persists sessions to SQLite/libSQL via Drizzle ORM.
 * Provides durable storage suitable for production deployments.
 *
 * CONCURRENCY INVARIANT: All handlers must use single-statement operations only.
 * Storage handlers share a single DB connection. Fire-and-forget bus events
 * (e.g., agent.added) race with sequential RPC handlers (e.g., turn.create).
 * db.transaction() holds write locks across await boundaries, causing SQLITE_BUSY
 * deadlocks on the same connection. Single statements serialize automatically
 * via SQLite's busy_timeout + WAL mode.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance (any libSQL database)
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerDrizzleSessionStorage } from '@makaio/services-core/session';
 * import { drizzle } from 'drizzle-orm/libsql';
 * import { createClient } from '@libsql/client';
 *
 * const client = createClient({ url: 'file:./makaio.db' });
 * const db = drizzle(client);
 * const cleanup = registerDrizzleSessionStorage(bus, db, ctx);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerDrizzleSessionStorage(bus: IMakaioBus, db: MakaioDatabase, _ctx: ExtensionContext): () => void {
  const deps: SessionHandlerDeps = { bus, db };
  const cleanups = [
    registerGetHandler(deps),
    registerSetHandler(deps),
    registerDeleteHandler(deps),
    registerUpdateHandler(deps),
    registerListHandler(deps),
    registerGetChildrenHandler(deps),
    registerGetByAdapterSessionIdHandler(deps),
    registerGetStatusCountsHandler(deps),
    // Import-specific handlers live in drizzle-import-handlers.ts
    ...registerDrizzleSessionImportHandlers(bus, db),
  ];

  // Search handler is registered separately via registerFtsSearchHandler()

  return () => cleanups.forEach((fn) => fn());
}
