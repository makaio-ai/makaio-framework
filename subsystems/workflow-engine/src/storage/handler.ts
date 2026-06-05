import { eq, and, desc, lt, or } from 'drizzle-orm';
import { executeTransaction, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { EXECUTION_LIST_DEFAULT_LIMIT, EXECUTION_LIST_MAX_LIMIT, EXECUTION_LIST_MIN_LIMIT } from '@makaio/contracts';
import type { ExtensionContext, JsonValue, WorkflowExecution, WorkflowRunContext } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowExecutions, type InsertWorkflowExecution } from './schema.js';
import { registerDefinitionHandlers } from './definition-handler.js';
import { registerFrameHandlers } from './frame-handler.js';
import { registerGateInstanceHandlers } from './gate-handler.js';
import { registerSpanHandlers } from './span-handler.js';
import { registerRunContextHandlers, upsertWorkflowRunContext } from './run-context-handler.js';
import { buildScopePredicates, toScopeColumns, fromScopeColumns } from './scope-helpers.js';
import { registerWorklogProjection } from '../worklog/worklog-projection-service.js';

type DbExecutionRow = typeof workflowExecutions.$inferSelect;

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
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    triggerPayload: row.triggerPayload ?? undefined,
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
    startedAt: execution.startedAt,
    completedAt: execution.completedAt ?? null,
    triggerPayload: (execution.triggerPayload as Record<string, JsonValue> | undefined) ?? null,
    ...scopeColumns,
  };
}

/**
 * Build Drizzle predicates for filtering the `workflowExecutions` table.
 * @param workflowId - Optional workflow definition ID filter.
 * @param scope - Optional execution scope filter.
 * @param status - Optional execution status filter.
 * @param cursor - Optional pagination cursor.
 * @returns Array of SQL predicates for use in a `.where(and(...predicates))` clause.
 */
function buildExecutionListPredicates(
  workflowId: string | undefined,
  scope: Parameters<typeof buildScopePredicates>[1] | undefined,
  status: InsertWorkflowExecution['status'] | undefined,
  cursor: { startedAt: number; id: string } | undefined,
) {
  const predicates = [
    ...(workflowId ? [eq(workflowExecutions.workflowId, workflowId)] : []),
    ...(status ? [eq(workflowExecutions.status, status)] : []),
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
 */
async function upsertExecutionStart(
  db: MakaioDatabase,
  execution: WorkflowExecution,
  runContext: WorkflowRunContext,
): Promise<void> {
  if (runContext.executionId !== execution.id) {
    throw new Error('setExecutionStart requires execution.id to match runContext.executionId');
  }
  const dbValues = toExecutionDbValues(execution);
  await executeTransaction(db, async (tx) => {
    await tx.insert(workflowExecutions).values(dbValues).onConflictDoUpdate({
      target: workflowExecutions.id,
      set: dbValues,
    });
    await upsertWorkflowRunContext(tx, runContext);
  });
}

/**
 * Apply partial execution metadata updates.
 * @param db - Drizzle database instance.
 * @param executionId - Target execution identifier.
 * @param status - Optional new execution status.
 * @param error - Optional error message (nullable to clear).
 * @param completedAt - Optional completion timestamp (nullable to clear).
 * @returns True when the execution was found and updated.
 */
async function applyExecutionUpdate(
  db: MakaioDatabase,
  executionId: string,
  status: InsertWorkflowExecution['status'] | undefined,
  error: string | null | undefined,
  completedAt: number | null | undefined,
): Promise<boolean> {
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
    if (completedAt !== undefined) metadataValues.completedAt = completedAt;

    if (Object.keys(metadataValues).length > 0) {
      await tx.update(workflowExecutions).set(metadataValues).where(eq(workflowExecutions.id, executionId));
    }
    return true;
  });
}

/**
 * Register all execution-related bus handlers (get, set, update, list).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
function registerExecutionHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
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
    await upsertExecutionStart(db, execution, runContext);

    ctx.setResult({ id: execution.id, executionId: execution.id });
  });

  const unsubUpdateExecution = bus.on(WorkflowStorageSubjects.updateExecution, async (ctx) => {
    const { executionId, status, error, completedAt } = ctx.payload;
    const success = await applyExecutionUpdate(db, executionId, status, error, completedAt);
    ctx.setResult({ success });
  });

  const unsubListExecutions = bus.on(WorkflowStorageSubjects.listExecutions, async (ctx) => {
    const { workflowId, scope, status, limit, cursor } = ctx.payload;

    // Guard: schema refine runs in dev/test but is skipped in production.
    // Re-validate the constraint here to ensure bounded listing in all environments.
    if (workflowId === undefined && scope === undefined) {
      throw new Error('Either workflowId or scope is required to list executions.');
    }

    const predicates = buildExecutionListPredicates(workflowId, scope, status, cursor);
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

  return () => {
    unsubGetExecution();
    unsubSetExecution();
    unsubSetExecutionStart();
    unsubUpdateExecution();
    unsubListExecutions();
  };
}

/**
 * Registers all Drizzle-based workflow storage handlers with the bus.
 *
 * Handles:
 * - Definition CRUD: get, set, delete, list
 * - Execution CRUD: getExecution, setExecution, updateExecution, listExecutions
 * - Frame CRUD: setFrame, getFrame, listFrames
 * - Gate instance CRUD: setGateInstance, getGateInstance, listGateInstances
 * - Span CRUD: setSpan, listSpans
 * - Execution link CRUD: setExecutionLink, listExecutionLinks
 * - Run context CRUD: setRunContext, getRunContext
 * - WorkLog projection: worklog.get, worklog.list, worklog.changed (event-driven)
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzleWorkflowStorage(
  bus: IMakaioBus,
  db: MakaioDatabase,
  _ctx: ExtensionContext,
): () => void {
  const definitionCleanup = registerDefinitionHandlers(bus, db);
  const executionCleanup = registerExecutionHandlers(bus, db);
  const frameCleanup = registerFrameHandlers(bus, db);
  const gateCleanup = registerGateInstanceHandlers(bus, db);
  const spanCleanup = registerSpanHandlers(bus, db);
  const runContextCleanup = registerRunContextHandlers(bus, db);
  const worklogCleanup = registerWorklogProjection(bus, db);

  return () => {
    definitionCleanup();
    executionCleanup();
    frameCleanup();
    gateCleanup();
    spanCleanup();
    runContextCleanup();
    worklogCleanup();
  };
}
