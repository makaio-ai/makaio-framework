import { eq, and, desc, lt, or, inArray, sql, type Column } from 'drizzle-orm';
import { executeTransaction, type MakaioDatabase, type TransactionCallback } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { EXECUTION_LIST_DEFAULT_LIMIT, EXECUTION_LIST_MAX_LIMIT, EXECUTION_LIST_MIN_LIMIT } from '@makaio/contracts';
import type {
  ExecutableStepState,
  ExtensionContext,
  JsonValue,
  StepState,
  WorkflowExecutionScope,
  WorkflowRunContext,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { createDrizzleCrudHandlers, createDrizzleListHandler } from '@makaio/storage-handlers';
import {
  WorkflowStorageSubjects,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
  type WorkflowExecution,
  type WorkflowListQuery,
} from './namespace.js';
import {
  workflowDefinitions,
  workflowExecutions,
  workflowExecutionSteps,
  type InsertWorkflowExecution,
  type InsertWorkflowExecutionStep,
  type InsertWorkflowDefinition,
} from './schema.js';
import { registerSpanHandlers } from './span-handler.js';
import { registerRunContextHandlers, upsertWorkflowRunContext } from './run-context-handler.js';
import { toScopeColumns, fromScopeColumns } from './scope-helpers.js';

type DbDefinitionRow = typeof workflowDefinitions.$inferSelect;
type DbExecutionRow = typeof workflowExecutions.$inferSelect;
type StorageExecutor = MakaioDatabase | Parameters<TransactionCallback<void>>[0];

/**
 * Build equality predicates for scope columns on a given table.
 * @param table - Table reference with scope columns
 * @param scope - Scope to match against
 * @returns Array of three equality predicates
 */
function buildScopePredicates(
  table: { scopeType: Column; scopeKind: Column; scopeId: Column },
  scope: WorkflowExecutionScope,
) {
  const { scopeType, scopeKind, scopeId } = toScopeColumns(scope);
  return [eq(table.scopeType, scopeType), eq(table.scopeKind, scopeKind), eq(table.scopeId, scopeId)];
}

// ─────────────────────────────────────────────────────────────
// Definition Handlers
// ─────────────────────────────────────────────────────────────

/**
 * Maps database row to WorkflowDefinition API type.
 *
 * Uses explicit field mapping for type safety and clarity.
 * @param row - Database row from workflow_definitions table
 * @returns Mapped WorkflowDefinition object with validated types
 */
function mapDefinition(row: DbDefinitionRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    inputs: row.inputs ?? undefined,
    steps: row.steps,
    defaultExecutionTargetId: row.defaultExecutionTargetId ?? undefined,
    triggers: row.triggers ?? undefined,
    scope: fromScopeColumns(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canvasLayout: row.canvasLayout ?? undefined,
  };
}

/**
 * Maps WorkflowDefinitionInput to database values.
 * @param workflow - Workflow definition input from API
 * @returns Database values for insert/update
 */
function toDefinitionDbValues(workflow: WorkflowDefinitionInput): Partial<InsertWorkflowDefinition> {
  const scopeColumns = toScopeColumns(workflow.scope);
  const values: Partial<InsertWorkflowDefinition> = {
    id: workflow.id,
    name: workflow.name,
    steps: workflow.steps,
    ...scopeColumns,
  };

  // Preserve optional fields on update when caller omits them from payload.
  // Only set these columns if the caller explicitly provided them (hasOwnProperty check),
  // so an upsert that omits them does not overwrite the previously stored value with null.
  if (Object.prototype.hasOwnProperty.call(workflow, 'description')) {
    values.description = workflow.description ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(workflow, 'inputs')) {
    values.inputs = workflow.inputs ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(workflow, 'defaultExecutionTargetId')) {
    values.defaultExecutionTargetId = workflow.defaultExecutionTargetId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(workflow, 'triggers')) {
    values.triggers = workflow.triggers ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(workflow, 'canvasLayout')) {
    values.canvasLayout = (workflow.canvasLayout as Record<string, JsonValue> | undefined) ?? null;
  }

  return values;
}

const registerDefinitionCrud = createDrizzleCrudHandlers({
  table: workflowDefinitions,
  subjects: {
    get: WorkflowStorageSubjects.get,
    set: WorkflowStorageSubjects.set,
    delete: WorkflowStorageSubjects.delete,
  },
  idField: 'id',
  singularKey: 'workflow',
  mapper: mapDefinition,
  toDbValues: toDefinitionDbValues,
  lifecycle: {
    created: WorkflowSubjects.definition.created,
    updated: WorkflowSubjects.definition.updated,
    deleted: WorkflowSubjects.definition.deleted,
  },
});

const registerDefinitionList = createDrizzleListHandler({
  table: workflowDefinitions,
  subject: WorkflowStorageSubjects.list,
  pluralKey: 'workflows',
  mapper: mapDefinition,
  buildPredicates: (payload: WorkflowListQuery, table) => {
    if (!payload.scope) return [];
    return buildScopePredicates(table, payload.scope);
  },
});

// ─────────────────────────────────────────────────────────────
// Execution Handlers
// ─────────────────────────────────────────────────────────────

/**
 * Normalise step states loaded from the database.
 *
 * Older rows may not have the `kind` discriminant that was introduced when
 * `StepState` was widened into a discriminated union. Any state entry that
 * lacks `kind` is assumed to be an executable step and receives
 * `kind: 'executable'` so the rest of the runtime can narrowly access
 * executable-only fields without defensive checks on every access path.
 * @param raw - Raw step state map read from the JSON column
 * @returns Normalised step state map with `kind` present on every entry
 */
function normaliseStepStates(raw: Record<string, StepState>): Record<string, StepState> {
  const normalised: Record<string, StepState> = {};
  for (const [id, state] of Object.entries(raw)) {
    // JSON stored before the `kind` discriminant was introduced will not have the field.
    // Inspect the raw JSON object without tripping the discriminated-union type checker.
    const stateObj = state as Record<string, unknown>;
    if ('kind' in stateObj) {
      normalised[id] = state;
    } else {
      // Legacy row: treat as executable, which covers all pre-union step states.
      normalised[id] = { ...(stateObj as Omit<ExecutableStepState, 'kind'>), kind: 'executable' };
    }
  }
  return normalised;
}

/**
 * Maps database row to WorkflowExecution API type.
 * @param row - Database row from workflow_executions table
 * @param stepStates - Optional pre-loaded step states; falls back to row.steps when absent
 * @returns Mapped WorkflowExecution object with validated types
 */
function mapExecution(row: DbExecutionRow, stepStates?: Record<string, StepState>): WorkflowExecution {
  return {
    id: row.id,
    workflowId: row.workflowId,
    coordinatorSessionId: row.coordinatorSessionId ?? undefined,
    status: row.status,
    inputs: row.inputs,
    // Normalise step states: older rows may lack the `kind` discriminant.
    steps: normaliseStepStates({ ...row.steps, ...(stepStates ?? {}) }),
    currentStepId: row.currentStepId ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    triggerPayload: row.triggerPayload ?? undefined,
    scope: fromScopeColumns(row),
  };
}

/**
 * Load per-step state rows for a set of executions.
 * @param db - Drizzle database instance
 * @param executionIds - Execution IDs to load
 * @returns Map keyed by execution ID; absent when no per-step rows exist
 */
async function loadStepStatesByExecution(
  db: MakaioDatabase,
  executionIds: string[],
): Promise<Map<string, Record<string, StepState>>> {
  if (executionIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(workflowExecutionSteps)
    .where(inArray(workflowExecutionSteps.executionId, executionIds));

  const statesByExecution = new Map<string, Record<string, StepState>>();
  for (const row of rows) {
    const states = statesByExecution.get(row.executionId) ?? {};
    states[row.stepId] = row.state;
    statesByExecution.set(row.executionId, states);
  }
  return statesByExecution;
}

/**
 * Maps WorkflowExecution to canonical database values.
 * @param execution - Workflow execution from API
 * @returns Database values for insert/update
 */
function toExecutionDbValues(execution: WorkflowExecution): InsertWorkflowExecution {
  const scopeColumns = toScopeColumns(execution.scope);
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    coordinatorSessionId: execution.coordinatorSessionId ?? null,
    status: execution.status,
    inputs: execution.inputs as Record<string, JsonValue>,
    // Cast required: Drizzle's $type<Record<string, StepState>>() creates a
    // nominally distinct type even though the structure is identical to
    // WorkflowExecution['steps'] at runtime.
    steps: execution.steps as Record<string, StepState>,
    currentStepId: execution.currentStepId ?? null,
    error: execution.error ?? null,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt ?? null,
    triggerPayload: (execution.triggerPayload as Record<string, JsonValue> | undefined) ?? null,
    ...scopeColumns,
  };
}

/**
 * Maps a step-state patch to normalized execution-step rows.
 * @param executionId - Execution identifier
 * @param steps - Step states keyed by step ID
 * @returns Insert rows for `workflow_execution_steps`
 */
function toExecutionStepRows(executionId: string, steps: Record<string, StepState>): InsertWorkflowExecutionStep[] {
  return Object.entries(steps).map(([stepId, state]) => ({
    executionId,
    stepId,
    state,
  }));
}

/**
 * Upsert a set of normalized execution-step rows.
 * @param db - Drizzle database instance
 * @param executionId - Execution identifier
 * @param steps - Step states keyed by step ID
 */
async function upsertExecutionStepStates(
  db: StorageExecutor,
  executionId: string,
  steps: Record<string, StepState>,
): Promise<void> {
  const rows = toExecutionStepRows(executionId, steps);
  if (rows.length === 0) return;

  await db
    .insert(workflowExecutionSteps)
    .values(rows)
    .onConflictDoUpdate({
      target: [workflowExecutionSteps.executionId, workflowExecutionSteps.stepId],
      set: {
        state: sql`excluded.state`,
      },
    });
}

/**
 * Replace all normalized step rows for an execution from a full snapshot.
 * @param db - Drizzle database instance
 * @param executionId - Execution identifier
 * @param steps - Complete step-state map
 */
async function replaceExecutionStepStates(
  db: StorageExecutor,
  executionId: string,
  steps: Record<string, StepState>,
): Promise<void> {
  await db.delete(workflowExecutionSteps).where(eq(workflowExecutionSteps.executionId, executionId));
  await upsertExecutionStepStates(db, executionId, steps);
}

/**
 * Apply partial execution metadata updates and step-state upserts.
 * @param db - Drizzle database instance.
 * @param executionId - Target execution identifier.
 * @param status - Optional new execution status.
 * @param currentStepId - Optional current step ID (nullable to clear).
 * @param error - Optional error message (nullable to clear).
 * @param completedAt - Optional completion timestamp (nullable to clear).
 * @param stepUpdates - Optional map of step states to upsert.
 * @returns True when the execution was found and updated.
 */
async function applyExecutionUpdate(
  db: MakaioDatabase,
  executionId: string,
  status: InsertWorkflowExecution['status'] | undefined,
  currentStepId: string | null | undefined,
  error: string | null | undefined,
  completedAt: number | null | undefined,
  stepUpdates: Record<string, StepState> | undefined,
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
    if (currentStepId !== undefined) metadataValues.currentStepId = currentStepId;
    if (error !== undefined) metadataValues.error = error;
    if (completedAt !== undefined) metadataValues.completedAt = completedAt;

    await upsertExecutionStepStates(tx, executionId, stepUpdates ?? {});
    if (Object.keys(metadataValues).length > 0) {
      await tx.update(workflowExecutions).set(metadataValues).where(eq(workflowExecutions.id, executionId));
    }
    return true;
  });
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
    await replaceExecutionStepStates(tx, execution.id, execution.steps);
    await upsertWorkflowRunContext(tx, runContext);
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
    const stepStatesByExecution = await loadStepStatesByExecution(db, rows[0] ? [executionId] : []);
    const execution = rows[0] ? mapExecution(rows[0], stepStatesByExecution.get(executionId)) : null;
    ctx.setResult({ execution });
  });

  const unsubSetExecution = bus.on(WorkflowStorageSubjects.setExecution, async (ctx) => {
    // Cast: the bus infers a structurally identical type from WorkflowExecutionSchema,
    // but TypeScript cannot unify two z.infer results for discriminated-union fields.
    const execution = ctx.payload.execution as WorkflowExecution;
    const dbValues = toExecutionDbValues(execution);
    await executeTransaction(db, async (tx) => {
      await tx.insert(workflowExecutions).values(dbValues).onConflictDoUpdate({
        target: workflowExecutions.id,
        set: dbValues,
      });
      await replaceExecutionStepStates(tx, execution.id, execution.steps);
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
    const { executionId, status, currentStepId, error, completedAt } = ctx.payload;
    // Cast: bus infers a structurally identical StepState type but TypeScript cannot
    // unify two z.infer results for discriminated-union fields.
    const stepUpdates = ctx.payload.stepUpdates as Record<string, StepState> | undefined;
    const success = await applyExecutionUpdate(db, executionId, status, currentStepId, error, completedAt, stepUpdates);
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

    const stepStatesByExecution = await loadStepStatesByExecution(
      db,
      rows.map((row) => row.id),
    );
    ctx.setResult({
      executions: rows.map((row) => mapExecution(row, stepStatesByExecution.get(row.id))),
    });
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
 * - Span CRUD: setSpan, listSpans
 * - Execution link CRUD: setExecutionLink, listExecutionLinks
 * - Run context CRUD: setRunContext, getRunContext
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
  const definitionCrudCleanup = registerDefinitionCrud(bus, db);
  const definitionListCleanup = registerDefinitionList(bus, db);
  const executionCleanup = registerExecutionHandlers(bus, db);
  const spanCleanup = registerSpanHandlers(bus, db);
  const runContextCleanup = registerRunContextHandlers(bus, db);

  return () => {
    definitionCrudCleanup();
    definitionListCleanup();
    executionCleanup();
    spanCleanup();
    runContextCleanup();
  };
}
