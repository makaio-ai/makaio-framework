import { eq, desc, and, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { getRawSqlExecutor, resolveSchema, type MakaioDatabase, type StorageDialect } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type BranchKind, type IMakaioSession, type ImportUpsertRequest } from '@makaio/contracts';
import { SessionStorageSubjects } from './namespace.js';
import { sessionStorageSchema } from './schema.variants.js';
import { mapAgentsBySession, mapToSession } from './drizzle-utils.js';
import { kindToBranchKind } from '../import/lineage-utils.js';
import type { SessionHandlerDeps } from './drizzle-handler.js';
import { createMonotonicClock } from './monotonic-clock.js';
import { resolveImportCreateStatus } from './import-lifecycle.js';

const nextDiscoveredAt = createMonotonicClock();

/** Canonical column shape of the sessions table, resolved through the dialect seam. */
type SessionsTable = typeof sessionStorageSchema.sqlite.sessions;

type ClientIdentityObservation = IMakaioSession['lastClientIdentityObservation'];

/**
 * Serialize a client identity observation for persistence.
 *
 * Mirrors the `storage:session.set` handler's serialization of the
 * `last_client_identity_observation` JSON-string column so both write paths
 * stay byte-compatible.
 * @param observation - Latest observed client identity payload, if any
 * @returns JSON string for storage, or null when no observation is present
 */
function serializeClientIdentityObservation(observation: ClientIdentityObservation | undefined): string | null {
  return observation ? JSON.stringify(observation) : null;
}

/**
 * Build the SELECT branch that re-encodes one metadata source's top-level
 * entries as `(key, vjson)` rows, where `vjson` is the value's JSON text.
 *
 * `json_each`'s `value` column loses JSON fidelity for three type classes
 * (nested object/array values arrive as plain SQL text, booleans as 0/1
 * integers, JSON nulls as SQL NULL), so the CASE re-derives canonical JSON
 * text per `type` — the only lossless way to rebuild an object with
 * `json_group_object(key, json(vjson))`.
 * @param source - SQL expression yielding the JSON object to expand
 * @param alias - Row alias for this `json_each` expansion (raw identifier)
 * @returns SELECT producing `key` / `vjson` columns for the merge subquery
 */
function buildMetadataEntriesSelect(source: SQL, alias: SQL): SQL {
  return sql`
    SELECT ${alias}.key AS key,
      CASE ${alias}.type
        WHEN 'object' THEN ${alias}.value
        WHEN 'array' THEN ${alias}.value
        WHEN 'true' THEN 'true'
        WHEN 'false' THEN 'false'
        WHEN 'null' THEN 'null'
        WHEN 'text' THEN json_quote(${alias}.value)
        ELSE CAST(${alias}.value AS TEXT)
      END AS vjson
    FROM json_each(${source}) AS ${alias}
  `;
}

/**
 * Build the conflict-merge expression for the `metadata` JSON column.
 *
 * Semantic: hook-first metadata is preserved; import enrichment merges, never
 * overwrites (AC14). The merge is a top-level key merge where EXISTING keys
 * win over incoming ones — including keys whose stored value is JSON `null`
 * (`SessionRecordMetadataSchema` values are `JsonValue`, so `null` is a legal
 * stored value, not a deletion sentinel). NULL stays NULL when neither side
 * carries metadata (no empty-object materialization on plain enrichment).
 *
 * The physical expression is dialect-specific because the `jsonCol` column
 * type maps to `text` (JSON string) on SQLite and `jsonb` on Postgres:
 * - Postgres: `incoming || existing` — jsonb concatenation where the right
 *   operand (existing) wins on key collisions and null-valued keys survive.
 * - SQLite: a `json_group_object` reassembly over the union of existing
 *   entries plus incoming-only entries. Deliberately NOT `json_patch`: RFC
 *   7386 treats a top-level `null` in the patch argument as a key DELETION,
 *   which would silently drop legally stored `{ key: null }` metadata on
 *   SQLite while Postgres and the memory backend preserve it.
 * @param sessions - Dialect-resolved sessions table object.
 * @param dialect - Storage dialect of the target database.
 * @returns SQL expression for the conflict SET clause
 */
function buildMetadataMergeExpression(sessions: SessionsTable, dialect: StorageDialect): SQL {
  const merged =
    dialect === 'postgres'
      ? sql`excluded.metadata || ${sessions.metadata}`
      : sql`(
          SELECT json_group_object(mk.key, json(mk.vjson)) FROM (
            ${buildMetadataEntriesSelect(sql`excluded.metadata`, sql`inc`)}
            WHERE inc.key NOT IN (SELECT ex2.key FROM json_each(${sessions.metadata}) AS ex2)
            UNION ALL
            ${buildMetadataEntriesSelect(sql`${sessions.metadata}`, sql`ex`)}
          ) AS mk
        )`;
  return sql`
    CASE
      WHEN ${sessions.metadata} IS NULL THEN excluded.metadata
      WHEN excluded.metadata IS NULL THEN ${sessions.metadata}
      ELSE ${merged}
    END
  `;
}

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
 * Build the import-status merge expression shared by `importStatus` and
 * lifecycle conflict handling.
 *
 * The precedence must match the memory backend: imported before tracking
 * before discovered. Lifecycle decisions that depend on import status must use
 * this richer-state merge, not plain COALESCE, or Drizzle can downgrade active
 * rows when a later call upgrades importStatus from discovered to tracking.
 * @param sessions - Dialect-resolved sessions table object
 * @returns SQL CASE expression yielding the merged import status
 */
function buildImportStatusMergeExpression(sessions: SessionsTable): SQL {
  return sql`
    CASE
      WHEN ${sessions.importStatus} = 'imported' OR excluded.import_status = 'imported' THEN 'imported'
      WHEN ${sessions.importStatus} = 'tracking' OR excluded.import_status = 'tracking' THEN 'tracking'
      ELSE COALESCE(${sessions.importStatus}, excluded.import_status, 'discovered')
    END
  `;
}

/**
 * Build the conflict-resolution SQL CASE for the `status` column.
 *
 * - `activation === 'live'`: promotes `'discovered'` rows to `'active'`; all
 *   other statuses are left untouched (no downgrade).
 * - Otherwise (standard enrichment): preserves terminal statuses (`closed`,
 *   `archived`) and already-imported active rows, and only overwrites `status`
 *   when the row is still a plain discovery stub after import-status
 *   precedence. Non-imported active rows may still converge into imports.
 * @param sessions - Dialect-resolved sessions table object
 * @param activation - Lifecycle activation intent from the import request
 * @returns SQL CASE expression for the `status` conflict SET column
 */
function buildImportConflictStatusExpression(
  sessions: SessionsTable,
  activation: ImportUpsertRequest['activation'],
): SQL {
  if (activation === 'live') {
    return sql`
      CASE
        WHEN ${sessions.status} = 'discovered' THEN 'active'
        ELSE ${sessions.status}
      END
    `;
  }

  return sql`
    CASE
      WHEN ${sessions.status} IN ('closed', 'archived') THEN ${sessions.status}
      WHEN ${sessions.status} = 'active' AND ${sessions.isImported} = TRUE THEN ${sessions.status}
      WHEN ${buildImportStatusMergeExpression(sessions)} = 'discovered' THEN excluded.status
      ELSE ${sessions.status}
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
 * @param dialect - Storage dialect of the target database (branches only the metadata merge expression).
 * @param machineId - Tri-state machine identity: `undefined` preserves the existing value,
 *   `null` explicitly clears it (relinquish ownership), non-null string fills if absent.
 * @param activation - Lifecycle activation intent from the import request
 * @returns Drizzle `set` object for `onConflictDoUpdate`
 */
function buildImportConflictSet(
  sessions: SessionsTable,
  startedAt: number | undefined,
  dialect: StorageDialect,
  machineId: string | null | undefined,
  activation: ImportUpsertRequest['activation'],
) {
  return {
    status: buildImportConflictStatusExpression(sessions, activation),
    isImported: true,
    // Status precedence is monotonic: watcher discovery can upgrade to hook
    // tracking, but later discovery enrichment cannot downgrade tracking/imported.
    importStatus: buildImportStatusMergeExpression(sessions),
    adapterName: sql`COALESCE(${sessions.adapterName}, excluded.adapter_name)`,
    discoveredAt: sql`COALESCE(${sessions.discoveredAt}, excluded.discovered_at)`,
    // Immutable identity fields: keep existing value, fall back to new.
    source: sql`COALESCE(${sessions.source}, excluded.source)`,
    logFilePath: sql`COALESCE(${sessions.logFilePath}, excluded.log_file_path)`,
    // Enrichment fields: prefer incoming value over stored null so each
    // re-scan can supply data that was absent on first discovery.
    targetWorkingDirectory: sql`COALESCE(excluded.target_working_directory, ${sessions.targetWorkingDirectory})`,
    title: sql`COALESCE(excluded.title, ${sessions.title})`,
    // Fork lineage identity fields use existing-wins (strict): once set
    // by hook-first fork registration, later imports cannot overwrite them.
    // forkPointMessageId is fill-once: null at hook-first registration,
    // enriched exactly once by the transcript import.
    forkPointMessageId: sql`COALESCE(${sessions.forkPointMessageId}, excluded.fork_point_message_id)`,
    parentExternalSessionId: sql`COALESCE(${sessions.parentExternalSessionId}, excluded.parent_external_session_id)`,
    branchKind: sql`COALESCE(${sessions.branchKind}, excluded.branch_kind)`,
    adapterId: sql`COALESCE(excluded.adapter_id, ${sessions.adapterId})`,
    clientId: sql`COALESCE(excluded.client_id, ${sessions.clientId})`,
    // Enrichment prefers a defined incoming sidechain flag over the stored one
    // (later scans can flip unknown → known; absent input keeps the stored value).
    isSidechain: sql`COALESCE(excluded.is_sidechain, ${sessions.isSidechain})`,
    // Newer identity observation wins when supplied; absent input keeps the stored one.
    lastClientIdentityObservation: sql`COALESCE(excluded.last_client_identity_observation, ${sessions.lastClientIdentityObservation})`,
    // Tri-state machineId: undefined preserves existing, null explicitly clears,
    // non-null string fills if absent (existing wins). The excluded row cannot
    // distinguish null from undefined (both are SQL NULL), so the branch is
    // resolved at the TypeScript level before the SQL is built.
    machineId:
      machineId === undefined
        ? sql`${sessions.machineId}`
        : machineId === null
          ? sql`NULL`
          : sql`COALESCE(${sessions.machineId}, excluded.machine_id)`,
    // Hook-first metadata is preserved; import enrichment merges, never overwrites (AC14).
    metadata: buildMetadataMergeExpression(sessions, dialect),
    createdAt: timestampConflictClause(sessions.createdAt, startedAt, sessions),
    lastActivityAt: timestampConflictClause(sessions.lastActivityAt, startedAt, sessions),
  };
}

/**
 * Register handler for storage:session.importUpsert.
 *
 * Single-statement UPSERT that creates or enriches an imported session.
 * On first import: inserts a new session with `isImported=true`; the import
 * status defaults to `'discovered'` unless the caller supplies a richer
 * allowed value. The lifecycle `status` defaults to `'discovered'`; when the
 * payload carries `activation: 'live'` the row is created directly as
 * `'active'` (see {@link resolveImportCreateStatus}).
 * On conflict (same `source` + `adapterSessionId`): converges existing rows
 * into the canonical imported-session shape and merges enrichment fields so
 * that later scans can supply previously-unknown values.
 *
 * This subject is also the hook-first registration seam for live-followed
 * observed sessions: callers may supply `importStatus: 'tracking'`, opaque
 * `metadata`, a `lastClientIdentityObservation`, and `isSidechain` at
 * registration time. Enrichment never downgrades `importStatus` and merges
 * `metadata` with existing keys winning (AC14).
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
  const { dialect } = getRawSqlExecutor(db);

  return bus.on(SessionStorageSubjects.importUpsert, async (ctx) => {
    const payload = ctx.payload;
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
      metadata,
      lastClientIdentityObservation,
      importStatus,
      isSidechain,
      machineId,
      activation,
    } = payload;

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
        status: resolveImportCreateStatus(payload),
        isImported: true,
        importStatus: importStatus ?? 'discovered',
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
        metadata: metadata ?? null,
        lastClientIdentityObservation: serializeClientIdentityObservation(lastClientIdentityObservation),
        isSidechain: isSidechain ?? null,
        machineId: machineId ?? null,
        createdAt,
        lastActivityAt: createdAt,
      })
      .onConflictDoUpdate({
        // Imported-session identity is source-scoped. Rows that lack `source`
        // cannot participate in the `(source, adapterSessionId)` invariant, so
        // this handler does not merge them into a sourced import.
        target: [sessions.source, sessions.adapterSessionId],
        set: buildImportConflictSet(sessions, startedAt, dialect, machineId, activation),
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
