import { eq, desc, and, inArray, isNull, or, sql } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type BranchKind } from '@makaio/contracts';
import { SessionStorageSubjects } from './namespace.js';
import { sessionStorageSchema } from './schema.variants.js';
import { mapAgentsBySession, mapToSession } from './drizzle-utils.js';
import { kindToBranchKind } from '../import/lineage-utils.js';
import type { SessionHandlerDeps } from './drizzle-handler.js';
import { createMonotonicClock } from './monotonic-clock.js';

const nextDiscoveredAt = createMonotonicClock();

/** Canonical column shape of the sessions table, resolved through the dialect seam. */
type SessionsTable = typeof sessionStorageSchema.sqlite.sessions;

/**
 * Build a SQL CASE clause that corrects an unstarted discovery-stub timestamp on re-import.
 * @param column - The timestamp column to conditionally update
 * @param startedAt - The real start timestamp from the import, or undefined to keep existing
 * @param sessions - Dialect-resolved sessions table object.
 * @returns SQL expression for the conflict SET clause
 */
function timestampConflictClause(
  column: SessionsTable['createdAt'] | SessionsTable['lastActivityAt'],
  startedAt: number | undefined,
  sessions: SessionsTable,
) {
  return startedAt === undefined
    ? sql`${column}`
    : sql`
        CASE
          WHEN ${sessions.discoveredAt} IS NULL OR ${column} = ${sessions.discoveredAt} THEN ${startedAt}
          ELSE ${column}
        END
      `;
}

/**
 * Build the conflict-merge SET clause for the import UPSERT.
 *
 * Converges an existing row into the canonical imported-session shape and
 * merges enrichment fields so later scans can supply previously-unknown values.
 *
 * Extracted from {@link registerImportUpsertHandler} to keep it within the
 * max-lines-per-function lint threshold.
 * @param sessions - Dialect-resolved sessions table object.
 * @param startedAt - The real start timestamp from the import, or undefined to keep existing
 * @returns Drizzle `set` object for `onConflictDoUpdate`
 */
function buildImportConflictSet(sessions: SessionsTable, startedAt: number | undefined) {
  return {
    status: sql`
      CASE
        WHEN COALESCE(${sessions.importStatus}, excluded.import_status) = 'discovered' THEN excluded.status
        ELSE ${sessions.status}
      END
    `,
    isImported: true,
    importStatus: sql`COALESCE(${sessions.importStatus}, excluded.import_status)`,
    adapterName: sql`COALESCE(${sessions.adapterName}, excluded.adapter_name)`,
    discoveredAt: sql`COALESCE(${sessions.discoveredAt}, excluded.discovered_at)`,
    // Immutable identity fields: keep existing value, fall back to new.
    source: sql`COALESCE(${sessions.source}, excluded.source)`,
    logFilePath: sql`COALESCE(${sessions.logFilePath}, excluded.log_file_path)`,
    // Enrichment fields: prefer incoming value over stored null so each
    // re-scan can supply data that was absent on first discovery.
    targetWorkingDirectory: sql`COALESCE(excluded.target_working_directory, ${sessions.targetWorkingDirectory})`,
    title: sql`COALESCE(excluded.title, ${sessions.title})`,
    forkPointMessageId: sql`COALESCE(excluded.fork_point_message_id, ${sessions.forkPointMessageId})`,
    parentExternalSessionId: sql`COALESCE(excluded.parent_external_session_id, ${sessions.parentExternalSessionId})`,
    branchKind: sql`COALESCE(excluded.branch_kind, ${sessions.branchKind})`,
    adapterId: sql`COALESCE(excluded.adapter_id, ${sessions.adapterId})`,
    clientId: sql`COALESCE(excluded.client_id, ${sessions.clientId})`,
    createdAt: timestampConflictClause(sessions.createdAt, startedAt, sessions),
    lastActivityAt: timestampConflictClause(sessions.lastActivityAt, startedAt, sessions),
  };
}

/**
 * Register handler for storage:session.importUpsert.
 *
 * Single-statement UPSERT that creates or enriches an imported session.
 * On first discovery: inserts a new session with `status='discovered'`,
 * `isImported=true`, and `importStatus='discovered'`.
 * On conflict (same `source` + `adapterSessionId`): converges existing rows
 * into the canonical imported-session shape and merges enrichment fields so
 * that later scans can supply previously-unknown values.
 *
 * Created-detection compares the returned row ID against the generated insert
 * ID, so existing rows whose missing `discoveredAt` is initialized on conflict
 * are still reported as updates.
 *
 * When a new session is created:
 * - Attempts parent resolution: if `parentAdapterSessionId` is set, looks up
 *   the parent by `adapterSessionId` and populates `parentSessionId` /
 *   `rootSessionId` in a second single-statement UPDATE.
 * - Emits `session.created` for entity-cache reactivity (fire-and-forget).
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerImportUpsertHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.importUpsert, async (ctx) => {
    const {
      externalSessionId,
      source,
      clientId,
      adapterId,
      cwd,
      logFilePath,
      startedAt,
      title,
      kind,
      parentAdapterSessionId,
      forkPointMessageId,
    } = ctx.payload;

    const nowMs = nextDiscoveredAt();
    const sessionId = crypto.randomUUID();
    const createdAt = startedAt ?? nowMs;
    const branchKind = kindToBranchKind(kind) ?? null;

    // parentAdapterSessionId is null for root sessions and a string for
    // fork/subagent/compress sessions (guaranteed by the discriminated union).
    const parentExternalSessionId = parentAdapterSessionId ?? null;

    // Single-statement UPSERT — avoids SELECT+INSERT/UPDATE race on the shared
    // SQLite connection (see CONCURRENCY INVARIANT on registerDrizzleSessionStorage).
    const [row] = await db
      .insert(sessions)
      .values({
        sessionId,
        status: 'discovered',
        isImported: true,
        importStatus: 'discovered',
        adapterName: source,
        adapterSessionId: externalSessionId,
        source: source ?? null,
        clientId: clientId ?? null,
        adapterId: adapterId ?? null,
        targetWorkingDirectory: cwd ?? null,
        logFilePath: logFilePath ?? null,
        forkPointMessageId: forkPointMessageId ?? null,
        branchKind,
        parentExternalSessionId,
        discoveredAt: nowMs,
        title: title ?? null,
        createdAt,
        lastActivityAt: createdAt,
      })
      .onConflictDoUpdate({
        // Imported-session identity is source-scoped. Rows that lack `source`
        // cannot participate in the `(source, adapterSessionId)` invariant, so
        // this handler does not merge them into a sourced import.
        target: [sessions.source, sessions.adapterSessionId],
        set: buildImportConflictSet(sessions, startedAt),
      })
      .returning({
        sessionId: sessions.sessionId,
        discoveredAt: sessions.discoveredAt,
        parentExternalSessionId: sessions.parentExternalSessionId,
        parentSessionId: sessions.parentSessionId,
      });

    const created = row.sessionId === sessionId;

    await emitImportUpsertLifecycleEvent(bus, db, row, created, branchKind, createdAt, source);
    ctx.setResult({ sessionId: row.sessionId, created });
  });
}

/**
 * Emit the appropriate lifecycle event after an importUpsert operation.
 * @param bus - Bus for event emission
 * @param db - Database for parent resolution
 * @param row - The upserted row's key fields
 * @param created - Whether the row was newly created
 * @param branchKind - Branch kind for the created event
 * @param createdAt - Timestamp for the created event
 * @param source - Source tool identity for resolving imported parent links
 */
async function emitImportUpsertLifecycleEvent(
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
  source: string,
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
  } else {
    // Enrichment upsert may have filled parentExternalSessionId for the first
    // time while the parent was already imported. Resolve parent now so the
    // child doesn't stay orphaned waiting for a session.import.completed that
    // already fired.
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
}

/**
 * Attempt to link a newly created imported session to its parent.
 *
 * Queries for an existing session whose source-scoped `adapterSessionId`
 * matches `parentExternalSessionId`, then updates the new session's
 * `parentSessionId` and `rootSessionId` in a single UPDATE statement.
 *
 * This is best-effort: if the parent has not been imported yet the call is a
 * no-op, and the parent-resolver service will fill the gap when the parent
 * arrives.
 * @param db - Drizzle database instance
 * @param newSessionId - ID of the session that was just created
 * @param parentExternalSessionId - External session ID of the intended parent, or null
 * @param source - Source tool identity for the imported lineage
 * @returns The resolved Makaio parent session ID, or null if not found
 */
async function resolveParentSession(
  db: MakaioDatabase,
  newSessionId: string,
  parentExternalSessionId: string | null,
  source: string,
): Promise<string | null> {
  const { sessions } = resolveSchema(db, sessionStorageSchema);
  if (parentExternalSessionId === null) {
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

/**
 * Register handler for storage:session.getByLogFilePath.
 *
 * Returns the session record whose `logFilePath` matches the given path.
 * The column has a unique index, so at most one row can match.
 * Used by the discovery orchestrator for cursor resumption.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetByLogFilePathHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions, agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.getByLogFilePath, async (ctx) => {
    const { logFilePath } = ctx.payload;

    const [sessionRow] = await db.select().from(sessions).where(eq(sessions.logFilePath, logFilePath)).limit(1);

    if (!sessionRow) {
      ctx.setResult({ session: null });
      return;
    }

    const agentRows = await db.select().from(agents).where(eq(agents.sessionId, sessionRow.sessionId));
    ctx.setResult({ session: mapToSession(sessionRow, agentRows) });
  });
}

/**
 * Register handler for storage:session.listImported.
 *
 * Lists sessions where `isImported = true`, ordered by `createdAt DESC`.
 * Optionally filtered by `source`.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerListImportedHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions, agents } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.listImported, async (ctx) => {
    const { source, importStatus } = ctx.payload;

    const conditions = [eq(sessions.isImported, true)];
    if (source !== undefined) conditions.push(eq(sessions.source, source));
    if (importStatus !== undefined) conditions.push(eq(sessions.importStatus, importStatus));
    const predicate = and(...conditions);

    const sessionRows = await db.select().from(sessions).where(predicate).orderBy(desc(sessions.createdAt));

    if (sessionRows.length === 0) {
      ctx.setResult({ sessions: [] });
      return;
    }

    const sessionIds = sessionRows.map((row) => row.sessionId);
    const allAgentRows = await db.select().from(agents).where(inArray(agents.sessionId, sessionIds));
    const agentsBySession = mapAgentsBySession(allAgentRows);

    ctx.setResult({
      sessions: sessionRows.map((row) => mapToSession(row, agentsBySession.get(row.sessionId) ?? [])),
    });
  });
}

/**
 * Register handler for storage:session.countBySource.
 *
 * Counts imported sessions grouped by `importStatus` for the given `source`.
 * Returns total plus exclusive imported, tracking, and discovered buckets.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerCountBySourceHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.countBySource, async (ctx) => {
    const { source } = ctx.payload;

    const rows = await db
      .select({
        importStatus: sessions.importStatus,
        count: sql<number>`count(*)`,
      })
      .from(sessions)
      .where(and(eq(sessions.isImported, true), eq(sessions.source, source)))
      .groupBy(sessions.importStatus);

    let total = 0;
    let imported = 0;
    let tracking = 0;
    let discovered = 0;

    for (const row of rows) {
      const rowCount = Number(row.count);
      total += rowCount;
      if (row.importStatus === 'imported') {
        imported += rowCount;
      }
      if (row.importStatus === 'tracking') {
        tracking += rowCount;
      }
      if (row.importStatus === 'discovered') {
        discovered = rowCount;
      }
    }

    ctx.setResult({ total, imported, tracking, discovered });
  });
}

/**
 * Register handler for storage:session.updateImportStatus.
 *
 * Updates `importStatus` when the value differs from the current one
 * (idempotent — no-op if already at the target status).
 * Also transitions `status` from 'discovered' to 'active' when
 * `importStatus` moves to 'imported', reflecting that the session is
 * now fully available.
 *
 * Emits `session.importStatusChanged` on a successful status transition
 * so the entity cache can react without polling.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateImportStatusHandler(deps: SessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { sessions } = resolveSchema(db, sessionStorageSchema);

  return bus.on(SessionStorageSubjects.updateImportStatus, async (ctx) => {
    const { sessionId, importStatus } = ctx.payload;

    // Promote only newly discovered imports. Closed/archived sessions keep the
    // user-owned lifecycle status when discovery tracking settles back down.
    const additionalFields =
      importStatus === 'imported'
        ? {
            status: sql`
              CASE
                WHEN ${sessions.status} = 'discovered' THEN 'active'
                ELSE ${sessions.status}
              END
            `,
          }
        : {};

    const [updated] = await db
      .update(sessions)
      .set({ importStatus, ...additionalFields })
      .where(
        and(
          eq(sessions.sessionId, sessionId),
          or(isNull(sessions.importStatus), sql`${sessions.importStatus} <> ${importStatus}`),
        ),
      )
      .returning({
        adapterSessionId: sessions.adapterSessionId,
        adapterName: sessions.adapterName,
        source: sessions.source,
      });

    const success = updated !== undefined;
    ctx.setResult({ success });

    if (success) {
      // Fire-and-forget: entity cache reactivity is best-effort.
      void bus
        .emit(SessionSubjects.importStatusChanged, { sessionId, importStatus })
        .catch((err) => console.error('[SessionStorage] Failed to emit session.importStatusChanged:', err));

      // Emit session.import.completed when a session transitions to 'imported' so that
      // post-import lineage resolvers (parent-resolver, compress-lineage-resolver) can
      // backfill parentSessionId / rootSessionId for out-of-order imports.
      // Fire-and-forget: resolver failures must not surface to the import caller.
      const importSource = updated.source ?? updated.adapterName;
      if (importStatus === 'imported' && updated.adapterSessionId && importSource) {
        void bus
          .emit(SessionSubjects.import.completed, {
            sessionId,
            adapterSessionId: updated.adapterSessionId,
            source: importSource,
          })
          .catch((err) => console.error('[SessionStorage] Failed to emit session.import.completed:', err));
      }
    }
  });
}

/**
 * Register Drizzle-based session import storage handlers.
 *
 * Covers the 5 import-specific bus subjects: `importUpsert`, `getByLogFilePath`,
 * `listImported`, `countBySource`, and `updateImportStatus`.
 *
 * Called by `registerDrizzleSessionStorage` as part of the full handler set.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Array of cleanup functions, one per registered handler
 */
export function registerDrizzleSessionImportHandlers(bus: IMakaioBus, db: MakaioDatabase): Array<() => void> {
  const deps: SessionHandlerDeps = { bus, db };
  return [
    registerImportUpsertHandler(deps),
    registerGetByLogFilePathHandler(deps),
    registerListImportedHandler(deps),
    registerCountBySourceHandler(deps),
    registerUpdateImportStatusHandler(deps),
  ];
}
