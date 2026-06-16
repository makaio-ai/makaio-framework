import { eq, and, desc, lt, or } from 'drizzle-orm';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  EXECUTION_LIST_DEFAULT_LIMIT,
  EXECUTION_LIST_MAX_LIMIT,
  EXECUTION_LIST_MIN_LIMIT,
  ExecutionsByArtifactRefsQuerySchema,
  serializeArtifactRef,
} from '@makaio/contracts';
import type {
  JsonPatchOperation,
  JsonValue,
  ExecutionLink,
  WorkflowExecution,
  WorkflowGateInstance,
  WorkflowRunContext,
} from '@makaio/contracts';
import { WorkflowStorageSubjects } from './namespace.js';
import type { InsertWorkflowExecution } from './schema.js';
import { workflowEngineSchema } from './schema.variants.js';
import { registerDefinitionHandlers } from './definition-handler.js';
import { registerFrameHandlers } from './frame-handler.js';
import { mapGateInstance, registerGateInstanceHandlers, toGateDbValues } from './gate-handler.js';
import { registerSpanHandlers } from './span-handler.js';
import { registerRunContextHandlers, upsertWorkflowRunContext } from './run-context-handler.js';
import { registerStateHandlers } from './state-handler.js';
import { toWorkflowStateJsonColumnValue } from './state-json-column.js';
import { buildScopePredicates, toScopeColumns, fromScopeColumns } from './scope-helpers.js';
import { registerWorklogProjection } from '../worklog/worklog-projection-service.js';

// The `.sqlite` face is the canonical static type for BOTH dialects:
// `DialectSchema` presents the Postgres twins through the same SQLite-typed
// face and `defineDialectSchema` rejects select-row drift between the twins at
// compile time, so this alias is exactly the type `resolveSchema()` returns at
// runtime regardless of the active dialect.
type WorkflowExecutionsTable = typeof workflowEngineSchema.sqlite.workflowExecutions;
type DbExecutionRow = WorkflowExecutionsTable['$inferSelect'];

/**
 * Maps a database row to the `WorkflowExecution` API type.
 * @param row - Database row from `workflow_executions`
 * @returns Mapped `WorkflowExecution` with optional fields normalised
 */
function mapExecution(row: DbExecutionRow): WorkflowExecution {
  return {
    id: row.id,
    workflowId: row.workflowId,
    coordinatorSessionId: row.coordinatorSessionId ?? undefined,
    status: row.status,
    inputs: row.inputs,
    config: {},
    error: row.error ?? undefined,
    reason: row.reason ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    triggerPayload: row.triggerPayload ?? undefined,
    ...(row.artifactKind !== null && row.artifactId !== null
      ? { artifactRef: { kind: row.artifactKind, id: row.artifactId } }
      : {}),
    scope: fromScopeColumns(row),
  };
}

/**
 * Maps a `WorkflowExecution` to canonical database values.
 * @param execution - Workflow execution to persist
 * @returns Column values for the `workflow_executions` table
 */
function toExecutionDbValues(execution: WorkflowExecution): InsertWorkflowExecution {
  const scopeColumns = toScopeColumns(execution.scope);
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    coordinatorSessionId: execution.coordinatorSessionId ?? null,
    status: execution.status,
    inputs: execution.inputs,
    error: execution.error ?? null,
    reason: execution.reason ?? null,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt ?? null,
    triggerPayload: (execution.triggerPayload as Record<string, JsonValue> | undefined) ?? null,
    artifactKind: execution.artifactRef?.kind ?? null,
    artifactId: execution.artifactRef?.id ?? null,
    ...scopeColumns,
  };
}

/**
 * Build Drizzle predicates for filtering the `workflowExecutions` table.
 * @param workflowId - Optional workflow definition ID filter.
 * @param scope - Optional execution scope filter.
 * @param status - Optional execution status filter.
 * @param cursor - Optional pagination cursor.
 * @param artifactRef - Optional bound artifact reference filter (exact kind + id match).
 * @param workflowExecutions - Dialect-resolved table object, supplied by the
 *   caller after resolving from a branded handle via `resolveSchema`.
 * @returns Array of SQL predicates for use in a `.where(and(...predicates))` clause.
 */
function buildExecutionListPredicates(
  workflowId: string | undefined,
  scope: Parameters<typeof buildScopePredicates>[1] | undefined,
  status: InsertWorkflowExecution['status'] | undefined,
  cursor: { startedAt: number; id: string } | undefined,
  artifactRef: { kind: string; id: string } | undefined,
  workflowExecutions: WorkflowExecutionsTable,
) {
  const predicates = [
    ...(workflowId ? [eq(workflowExecutions.workflowId, workflowId)] : []),
    ...(status ? [eq(workflowExecutions.status, status)] : []),
    ...(artifactRef !== undefined
      ? [eq(workflowExecutions.artifactKind, artifactRef.kind), eq(workflowExecutions.artifactId, artifactRef.id)]
      : []),
  ];
  if (scope) {
    predicates.push(...buildScopePredicates(workflowExecutions, scope));
  }
  if (cursor) {
    const cursorPredicate = or(
      lt(workflowExecutions.startedAt, cursor.startedAt),
      and(eq(workflowExecutions.startedAt, cursor.startedAt), lt(workflowExecutions.id, cursor.id)),
    );
    if (cursorPredicate) predicates.push(cursorPredicate);
  }
  return predicates;
}

/**
 * Persist a newly-started execution and its run-context snapshot in one transaction.
 * @param db - Database handle.
 * @param execution - Execution row to upsert.
 * @param runContext - Matching run-context snapshot to upsert.
 * @param initialState - Validated initial workflow state to persist, when the workflow declares state.
 * @param executionLinks - Optional provenance links to persist with the execution start.
 */
async function upsertExecutionStart(
  db: MakaioDatabase,
  execution: WorkflowExecution,
  runContext: WorkflowRunContext,
  initialState: JsonValue | undefined,
  executionLinks: readonly ExecutionLink[] | undefined,
): Promise<void> {
  if (runContext.executionId !== execution.id) {
    throw new Error('setExecutionStart requires execution.id to match runContext.executionId');
  }
  const {
    workflowExecutions,
    workflowRunContexts,
    workflowExecutionState,
    workflowExecutionStateEvents,
    workflowExecutionLinks,
  } = resolveSchema(db, workflowEngineSchema);
  const dbValues = toExecutionDbValues(execution);
  await executeTransaction(db, async (tx) => {
    await tx.insert(workflowExecutions).values(dbValues).onConflictDoUpdate({
      target: workflowExecutions.id,
      set: dbValues,
    });
    const existingRunContexts =
      runContext.dispatchMetadata === undefined
        ? await tx
            .select({ dispatchMetadata: workflowRunContexts.dispatchMetadata })
            .from(workflowRunContexts)
            .where(eq(workflowRunContexts.executionId, runContext.executionId))
            .limit(1)
        : [];
    const existingDispatchMetadata = existingRunContexts[0]?.dispatchMetadata;
    const runContextSnapshot =
      runContext.dispatchMetadata === undefined &&
      existingDispatchMetadata !== null &&
      existingDispatchMetadata !== undefined
        ? { ...runContext, dispatchMetadata: existingDispatchMetadata as WorkflowRunContext['dispatchMetadata'] }
        : runContext;
    await upsertWorkflowRunContext(tx, runContextSnapshot, workflowRunContexts);
    if (initialState !== undefined) {
      const now = Date.now();
      const initialColumnValue = toWorkflowStateJsonColumnValue(db, initialState);
      await tx
        .insert(workflowExecutionState)
        .values({
          executionId: execution.id,
          sequence: 0,
          value: initialColumnValue,
          updatedAt: now,
        })
        .onConflictDoNothing();

      await tx
        .insert(workflowExecutionStateEvents)
        .values({
          executionId: execution.id,
          sequence: 0,
          patch: [] as JsonPatchOperation[],
          value: initialColumnValue,
          createdAt: now,
        })
        .onConflictDoNothing();
    }
    for (const link of executionLinks ?? []) {
      await tx
        .insert(workflowExecutionLinks)
        .values(link)
        .onConflictDoUpdate({
          target: [workflowExecutionLinks.sourceExecutionId, workflowExecutionLinks.targetExecutionId],
          set: link,
        });
    }
  });
}

/**
 * Restore a paused execution and its waiting gate in one storage transaction.
 * @param db - Database handle.
 * @param execution - Paused execution row to restore.
 * @param gate - Waiting gate row to restore.
 */
async function restorePausedGateResumeState(
  db: MakaioDatabase,
  execution: WorkflowExecution,
  gate: WorkflowGateInstance,
): Promise<void> {
  if (gate.executionId !== execution.id) {
    throw new Error('restorePausedGateResumeState requires execution.id to match gate.executionId');
  }
  if (execution.status !== 'paused' || gate.status !== 'waiting') {
    throw new Error('restorePausedGateResumeState requires a paused execution and waiting gate');
  }
  const { workflowExecutions, workflowGateInstances } = resolveSchema(db, workflowEngineSchema);
  const executionValues = toExecutionDbValues(execution);
  const gateValues = toGateDbValues(gate);
  await executeTransaction(db, async (tx) => {
    await tx.insert(workflowExecutions).values(executionValues).onConflictDoUpdate({
      target: workflowExecutions.id,
      set: executionValues,
    });
    await tx.insert(workflowGateInstances).values(gateValues).onConflictDoUpdate({
      target: workflowGateInstances.id,
      set: gateValues,
    });
  });
}

/**
 * Cancel a paused execution and every still-waiting gate in one transaction.
 * @param db - Drizzle database instance.
 * @param executionId - Paused execution to terminalize.
 * @param completedAt - Cancellation timestamp to persist on execution and gates.
 * @param reason - Optional cancellation reason to persist on the execution.
 * @returns Cancel result with the gate rows transitioned to `cancelled`.
 */
async function cancelPausedExecution(
  db: MakaioDatabase,
  executionId: string,
  completedAt: number,
  reason: string | undefined,
): Promise<{
  readonly cancelled: boolean;
  readonly gates: Array<WorkflowGateInstance & { readonly status: 'cancelled' }>;
}> {
  const { workflowExecutions, workflowGateInstances } = resolveSchema(db, workflowEngineSchema);
  return executeTransaction(db, async (tx) => {
    const executionRows = await tx
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .limit(1);
    const execution = executionRows[0];
    if (execution?.status !== 'paused') return { cancelled: false, gates: [] };

    const gateRows = await tx
      .select()
      .from(workflowGateInstances)
      .where(and(eq(workflowGateInstances.executionId, executionId), eq(workflowGateInstances.status, 'waiting')));
    const gates = gateRows.map((row) => ({
      ...mapGateInstance(row),
      status: 'cancelled' as const,
      resolvedAt: completedAt,
    }));

    await tx
      .update(workflowExecutions)
      .set({ status: 'cancelled', completedAt, reason: reason ?? null })
      .where(eq(workflowExecutions.id, executionId));
    for (const gate of gates) {
      const gateValues = toGateDbValues(gate);
      await tx.update(workflowGateInstances).set(gateValues).where(eq(workflowGateInstances.id, gateValues.id));
    }

    return { cancelled: true, gates };
  });
}

/**
 * Apply partial execution metadata updates.
 * @param db - Drizzle database instance.
 * @param executionId - Target execution identifier.
 * @param status - Optional new execution status.
 * @param error - Optional error message (nullable to clear).
 * @param reason - Optional cancellation reason (nullable to clear).
 * @param completedAt - Optional completion timestamp (nullable to clear).
 * @returns True when the execution was found and updated.
 */
async function applyExecutionUpdate(
  db: MakaioDatabase,
  executionId: string,
  status: InsertWorkflowExecution['status'] | undefined,
  error: string | null | undefined,
  reason: string | null | undefined,
  completedAt: number | null | undefined,
): Promise<boolean> {
  const { workflowExecutions } = resolveSchema(db, workflowEngineSchema);
  return executeTransaction(db, async (tx) => {
    const existing = await tx
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .limit(1);
    if (existing[0] === undefined) return false;

    const metadataValues: Partial<InsertWorkflowExecution> = {};
    if (status !== undefined) metadataValues.status = status;
    if (error !== undefined) metadataValues.error = error;
    if (reason !== undefined) metadataValues.reason = reason;
    if (completedAt !== undefined) metadataValues.completedAt = completedAt;

    if (Object.keys(metadataValues).length > 0) {
      await tx.update(workflowExecutions).set(metadataValues).where(eq(workflowExecutions.id, executionId));
    }
    return true;
  });
}

/**
 * Register execution CRUD handlers (get, set, update, cancel, restore).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
function registerExecutionCrudHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { workflowExecutions } = resolveSchema(db, workflowEngineSchema);

  const unsubGetExecution = bus.on(WorkflowStorageSubjects.getExecution, async (ctx) => {
    const { executionId } = ctx.payload;
    const rows = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
    ctx.setResult({ execution: rows[0] ? mapExecution(rows[0]) : null });
  });

  const unsubSetExecution = bus.on(WorkflowStorageSubjects.setExecution, async (ctx) => {
    const execution = ctx.payload.execution as WorkflowExecution;
    const dbValues = toExecutionDbValues(execution);
    await db.insert(workflowExecutions).values(dbValues).onConflictDoUpdate({
      target: workflowExecutions.id,
      set: dbValues,
    });
    ctx.setResult({ id: execution.id });
  });

  const unsubSetExecutionStart = bus.on(WorkflowStorageSubjects.setExecutionStart, async (ctx) => {
    // Cast: the bus infers structurally identical types from workflow schemas,
    // but TypeScript cannot unify duplicate z.infer results here.
    const execution = ctx.payload.execution as WorkflowExecution;
    const runContext = ctx.payload.runContext as WorkflowRunContext;
    await upsertExecutionStart(
      db,
      execution,
      runContext,
      ctx.payload.initialState as JsonValue | undefined,
      ctx.payload.executionLinks as ExecutionLink[] | undefined,
    );

    ctx.setResult({ id: execution.id, executionId: execution.id });
  });

  const unsubRestorePausedGateResumeState = bus.on(
    WorkflowStorageSubjects.restorePausedGateResumeState,
    async (ctx) => {
      const execution = ctx.payload.execution as WorkflowExecution;
      const gate = ctx.payload.gate as WorkflowGateInstance;
      await restorePausedGateResumeState(db, execution, gate);
      ctx.setResult({ executionId: execution.id, gateId: gate.nodeId });
    },
  );

  const unsubUpdateExecution = bus.on(WorkflowStorageSubjects.updateExecution, async (ctx) => {
    const { executionId, status, error, reason, completedAt } = ctx.payload;
    const success = await applyExecutionUpdate(db, executionId, status, error, reason, completedAt);
    ctx.setResult({ success });
  });

  const unsubCancelPausedExecution = bus.on(WorkflowStorageSubjects.cancelPausedExecution, async (ctx) => {
    const { executionId, completedAt, reason } = ctx.payload;
    ctx.setResult(await cancelPausedExecution(db, executionId, completedAt, reason));
  });

  return () => {
    unsubGetExecution();
    unsubSetExecution();
    unsubSetExecutionStart();
    unsubRestorePausedGateResumeState();
    unsubUpdateExecution();
    unsubCancelPausedExecution();
  };
}

/**
 * Register execution listing handlers (single and batch).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
function registerExecutionListHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { workflowExecutions } = resolveSchema(db, workflowEngineSchema);

  const unsubListExecutions = bus.on(WorkflowStorageSubjects.listExecutions, async (ctx) => {
    const { workflowId, scope, status, limit, cursor, artifactRef } = ctx.payload;

    // Guard: schema refine runs in dev/test but is skipped in production.
    // Re-validate the constraint here to ensure bounded listing in all environments.
    if (workflowId === undefined && scope === undefined && artifactRef === undefined) {
      throw new Error('Either workflowId, scope, or artifactRef is required to list executions.');
    }

    const predicates = buildExecutionListPredicates(workflowId, scope, status, cursor, artifactRef, workflowExecutions);
    // Limits are declared with ExecutionListQuerySchema, but production bus dispatch
    // does not parse schemas, so enforce the bounded-list invariant here as well.
    const resolvedLimit = limit ?? EXECUTION_LIST_DEFAULT_LIMIT;
    if (
      !Number.isInteger(resolvedLimit) ||
      resolvedLimit < EXECUTION_LIST_MIN_LIMIT ||
      resolvedLimit > EXECUTION_LIST_MAX_LIMIT
    ) {
      throw new Error(
        `Execution list limit must be an integer between ${EXECUTION_LIST_MIN_LIMIT} and ${EXECUTION_LIST_MAX_LIMIT}.`,
      );
    }

    const rows = await db
      .select()
      .from(workflowExecutions)
      .where(and(...predicates))
      .orderBy(desc(workflowExecutions.startedAt), desc(workflowExecutions.id))
      .limit(resolvedLimit);

    ctx.setResult({ executions: rows.map(mapExecution) });
  });

  const unsubListExecutionsByArtifactRefs = bus.on(
    WorkflowStorageSubjects.listExecutionsByArtifactRefs,
    async (ctx) => {
      const parsed = ExecutionsByArtifactRefsQuerySchema.safeParse(ctx.payload);
      if (!parsed.success) {
        throw new Error(`Invalid listExecutionsByArtifactRefs query: ${parsed.error.message}`);
      }
      const { refs, limitPerRef: resolvedLimit } = parsed.data;

      const executionsByRef: Record<string, WorkflowExecution[]> = {};

      for (const ref of refs) {
        const rows = await db
          .select()
          .from(workflowExecutions)
          .where(and(eq(workflowExecutions.artifactKind, ref.kind), eq(workflowExecutions.artifactId, ref.id)))
          .orderBy(desc(workflowExecutions.startedAt), desc(workflowExecutions.id))
          .limit(resolvedLimit);

        if (rows.length > 0) {
          executionsByRef[serializeArtifactRef(ref)] = rows.map(mapExecution);
        }
      }

      ctx.setResult({ executionsByRef });
    },
  );

  return () => {
    unsubListExecutions();
    unsubListExecutionsByArtifactRefs();
  };
}

/**
 * Registers all Drizzle-based workflow storage handlers with the bus.
 *
 * Handles:
 * - Definition CRUD: get, set, delete, list
 * - Execution CRUD: getExecution, setExecution, updateExecution, listExecutions, listExecutionsByArtifactRefs
 * - Frame CRUD: setFrame, getFrame, listFrames
 * - Gate instance CRUD: setGateInstance, getGateInstance, listGateInstances
 * - Span CRUD: setSpan, listSpans
 * - Execution link CRUD: setExecutionLink, listExecutionLinks
 * - Run context CRUD: setRunContext, getRunContext
 * - WorkLog projection: worklog.get, worklog.list, worklog.changed (event-driven)
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzleWorkflowStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const definitionCleanup = registerDefinitionHandlers(bus, db);
  const executionCrudCleanup = registerExecutionCrudHandlers(bus, db);
  const executionListCleanup = registerExecutionListHandlers(bus, db);
  const frameCleanup = registerFrameHandlers(bus, db);
  const gateCleanup = registerGateInstanceHandlers(bus, db);
  const spanCleanup = registerSpanHandlers(bus, db);
  const runContextCleanup = registerRunContextHandlers(bus, db);
  const stateCleanup = registerStateHandlers(bus, db);
  const worklogCleanup = registerWorklogProjection(bus, db);

  return () => {
    definitionCleanup();
    executionCrudCleanup();
    executionListCleanup();
    frameCleanup();
    gateCleanup();
    spanCleanup();
    runContextCleanup();
    stateCleanup();
    worklogCleanup();
  };
}
