import { eq, desc, count, inArray, and, sql, type SQL } from 'drizzle-orm';
import { didAffectRows, executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionStorageSetRequestSchema, SessionStorageUpdateSchema, type IMakaioSession } from '@makaio/contracts';
import type { z } from 'zod';
import { SessionStorageSubjects, type SessionWithPreview } from './namespace.js';
import { sessionStorageSchema } from './schema.variants.js';
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
import { registerGetChildrenHandler } from './drizzle-get-children-handler.js';
import { registerDrizzleSessionImportHandlers } from './drizzle-import-handlers.js';

/**
 * Handler dependencies for session storage handlers.
 */
export interface SessionHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
}

/** Canonical column shape of the sessions table, resolved through the dialect seam. */
type SessionsTable = typeof sessionStorageSchema.sqlite.sessions;
type SessionInsertValues = SessionsTable['$inferInsert'];
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
    metadata: toNullableDbValue(session.metadata),
    spawningToolCallId: toNullableDbValue(session.spawningToolCallId),
    // Import provenance fields (null for live sessions)
    source: toNullableDbValue(session.source),
    parentExternalSessionId: toNullableDbValue(session.parentExternalSessionId),
    logFilePath: toNullableDbValue(session.logFilePath),
    discoveredAt: toNullableDbValue(session.discoveredAt),
    importStatus: toNullableDbValue(session.importStatus),
    machineId: toNullableDbValue(session.machineId),
    // `currentAdapterSessionId` / `currentAdapterSessionIdState` are deliberately
    // absent. The resume currency is owned exclusively by the
    // `storage:sessionOwnership` seam: `set` is a read-modify-write of a whole
    // session object, so routing currency through it would let a concurrent
    // writer holding a stale snapshot resurrect an abandoned provider session.
    // Omitting the columns here leaves them untouched on every `set`.
  };
}

/**
 * Narrow the whole-record write to the columns it may change on an existing row.
 *
 * `leadAgentId` is written by exactly one writer — the reserving transaction of
 * `storage:sessionOwnership.claim`, which designates and clears it under a
 * compare-and-swap. A `set` carries a caller-held snapshot with no expectation
 * in it, so a caller that read the session before a designation landed would
 * otherwise put the previous lead back, or unset one, without ever having
 * observed the value it replaced. On conflict the stored designation therefore
 * wins; the insert path keeps the caller's value, because a fresh row has no
 * designation to lose.
 * @param values - Full column values produced by {@link toDbValues}
 * @returns The same values without the designation column
 */
function toSessionConflictValues<T extends { leadAgentId: string | null }>(values: T): Omit<T, 'leadAgentId'> {
  const { leadAgentId: _storedDesignationWins, ...conflictValues } = values;
  return conflictValues;
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
 * @param sessions - Dialect-resolved sessions table object.
 * @returns Drizzle-compatible update fields
 */
function buildSessionUpdateFields(payload: SessionUpdatePayload, sessions: SessionsTable): SessionUpdateFields {
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
  assignDefinedField(updateFields, 'machineId', payload.machineId);
  // No currency projection: the pair is written exclusively by the
  // `storage:sessionOwnership` seam, which is the only writer that carries an
  // authority (a claim generation) into the write.

  assignNullableField(updateFields, 'executionTargetId', payload.executionTargetId);
  assignNullableField(updateFields, 'approvalPolicyOverride', payload.approvalPolicyOverride);
  assignNullableField(updateFields, 'metadata', payload.metadata);
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
  const { sessions, agents } = resolveSchema(db, sessionStorageSchema);

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
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.set, async (ctx) => {
    const { sessionId, session, ifAbsent } = SessionStorageSetRequestSchema.parse(ctx.payload);
    const dbValues = toDbValues(session);
    if (ifAbsent) {
      assertSessionClientAccountStateIsConsistent(null, session);
      const insertResult = await db
        .insert(sessions)
        .values({ sessionId, createdAt: session.createdAt, ...dbValues })
        .onConflictDoNothing();
      const inserted = didAffectRows(insertResult);
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
          set: toSessionConflictValues(dbValues),
          setWhere: buildClientAccountBaselinePredicate(previousRow, sessions),
        });

      if (!didAffectRows(result)) {
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
 *
 * **Deletes its ownership children first, in the ownership lock order.** The
 * foreign keys cascade, so a bare `DELETE FROM sessions` is functionally
 * complete — but it takes its locks in the order the *database* chooses, which
 * is the session row first and the `agents` / `adapter_session_claims` rows it
 * cascades to afterwards. Every ownership operation locks in the opposite order
 * (`agents` → claims → `sessions`, see the ownership storage handlers), so a
 * claim racing a delete of its own session deadlocks under Postgres, with no
 * retry to absorb it. Deleting the children explicitly, in that same order,
 * inside one transaction makes both sides agree and removes the cycle; the
 * cascade then has nothing left to reach.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerDeleteHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions, agents, adapterSessionClaims } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.delete, async (ctx) => {
    const { sessionId } = ctx.payload;
    await executeTransaction(db, async (tx) => {
      // `agents` first, then the claims filed under this session that no agent
      // of it holds — an agent that moved to another session can still hold a
      // claim filed under this one, which the agent delete above does not reach.
      await tx.delete(agents).where(eq(agents.sessionId, sessionId));
      await tx.delete(adapterSessionClaims).where(eq(adapterSessionClaims.sessionId, sessionId));
      await tx.delete(sessions).where(eq(sessions.sessionId, sessionId));
    });
    ctx.setResult({ success: true });
  });
}

/**
 * Build the compare-and-swap conjunct for an expected-status guard.
 * @param expectedStatus - Statuses the caller will accept, or `undefined` for an unconditional write.
 * @param sessions - Dialect-resolved sessions table object.
 * @returns The predicate, or `undefined` when the write is unconditional.
 */
function buildExpectedStatusPredicate(
  expectedStatus: SessionUpdatePayload['expectedStatus'],
  sessions: SessionsTable,
): SQL | undefined {
  return expectedStatus === undefined ? undefined : inArray(sessions.status, expectedStatus);
}

/**
 * Register handler for storage:session.update.
 *
 * Performs partial update of session fields without touching agents. A supplied
 * `expectedStatus` makes the write a compare-and-swap: it is applied only while
 * the stored status is still one the caller named, and reports `success: false`
 * otherwise — the same answer a missing row gives, which the caller tells apart
 * by re-reading.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.update, async (ctx) => {
    const payload = SessionStorageUpdateSchema.request.parse(ctx.payload);
    const { sessionId } = payload;
    const updateFields = buildSessionUpdateFields(payload, sessions);
    const updatesClientAccountState = touchesClientAccountState(payload);
    // Skip if no fields to update
    if (Object.keys(updateFields).length === 0) {
      ctx.setResult({ success: true, clientAccountChanged: false });
      return;
    }
    // The compare-and-swap guard travels with the write, in the same predicate:
    // a caller acting on an observation must not be able to overwrite a status
    // that changed after it read the row.
    const statusGuard = buildExpectedStatusPredicate(payload.expectedStatus, sessions);
    if (!updatesClientAccountState) {
      const result = await db
        .update(sessions)
        .set(updateFields)
        .where(and(eq(sessions.sessionId, sessionId), statusGuard));
      ctx.setResult({ success: didAffectRows(result), clientAccountChanged: false });
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
      if (payload.expectedStatus !== undefined && !payload.expectedStatus.includes(previousSession.status)) {
        // Refused rather than retried: the baseline loop exists to re-read a
        // client-account race, and a status the caller did not expect is not one
        // — retrying would only re-read the same refusal.
        ctx.setResult({ success: false, clientAccountChanged: false });
        return;
      }
      const result = await db
        .update(sessions)
        .set(updateFields)
        .where(
          and(
            eq(sessions.sessionId, sessionId),
            statusGuard,
            buildClientAccountBaselinePredicate(previousRow, sessions),
          ),
        );
      if (!didAffectRows(result)) {
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
 * @param sessions - Dialect-resolved sessions table object.
 * @returns Combined SQL predicate, or undefined when no filters apply
 */
function buildListPredicates(
  filters: {
    status: 'active' | 'closed' | 'archived' | 'discovered' | 'all';
    executionTargetId?: string;
  },
  sessions: SessionsTable,
): SQL | undefined {
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
  const { sessions, agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.list, async (ctx) => {
    const { status = 'all', limit, offset = 0, includePreview = false, executionTargetId } = ctx.payload;
    const whereClause = buildListPredicates(
      {
        status,
        executionTargetId,
      },
      sessions,
    );

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
 * Register handler for storage:session.getStatusCounts.
 *
 * Efficiently counts sessions by status using GROUP BY.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetStatusCountsHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);

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
 * Persists sessions via Drizzle ORM.
 * Provides durable storage suitable for production deployments.
 *
 * CONCURRENCY INVARIANT: All handlers must use single-statement operations only.
 * Storage handlers share a single DB connection. Fire-and-forget bus events
 * (e.g., agent.added) race with sequential RPC handlers (e.g., turn.create).
 * db.transaction() holds write locks across await boundaries, causing SQLITE_BUSY
 * deadlocks on the same connection. Single statements serialize automatically
 * via SQLite's busy_timeout + WAL mode.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerDrizzleSessionStorage } from '@makaio/services-core/session';
 * import { drizzle } from 'drizzle-orm/libsql';
 * import { createClient } from '@libsql/client';
 *
 * const client = createClient({ url: 'file:./makaio.db' });
 * const db = drizzle(client);
 * const cleanup = registerDrizzleSessionStorage(bus, db);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerDrizzleSessionStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
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
