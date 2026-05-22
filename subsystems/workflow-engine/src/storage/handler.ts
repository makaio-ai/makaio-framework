import { eq, and } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { createDrizzleCrudHandlers, createDrizzleListHandler, buildScopePredicates } from '@makaio/storage-handlers';
import {
  WorkflowStorageSubjects,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
  type WorkflowExecution,
  type WorkflowListQuery,
} from './namespace.js';
import { workflowDefinitions, workflowExecutions, type InsertWorkflowExecution } from './schema.js';

type DbDefinitionRow = typeof workflowDefinitions.$inferSelect;
type DbExecutionRow = typeof workflowExecutions.$inferSelect;

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
    projectId: row.projectId,
    name: row.name,
    description: row.description ?? undefined,
    inputs: row.inputs ?? undefined,
    steps: row.steps,
    defaultExecutionTargetId: row.defaultExecutionTargetId ?? undefined,
    triggers: row.triggers ?? undefined,
    scope: row.scope,
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
function toDefinitionDbValues(workflow: WorkflowDefinitionInput): Partial<DbDefinitionRow> {
  const values: Partial<DbDefinitionRow> = {
    id: workflow.id,
    projectId: workflow.projectId,
    name: workflow.name,
    steps: workflow.steps,
    scope: workflow.scope,
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
    values.canvasLayout = workflow.canvasLayout ?? null;
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
  buildPredicates: (payload: WorkflowListQuery, table) => buildScopePredicates(table, payload.projectId),
});

// ─────────────────────────────────────────────────────────────
// Execution Handlers
// ─────────────────────────────────────────────────────────────

/**
 * Maps database row to WorkflowExecution API type.
 * @param row - Database row from workflow_executions table
 * @returns Mapped WorkflowExecution object with validated types
 */
function mapExecution(row: DbExecutionRow): WorkflowExecution {
  return {
    id: row.id,
    workflowId: row.workflowId,
    coordinatorSessionId: row.coordinatorSessionId ?? undefined,
    status: row.status,
    inputs: row.inputs,
    steps: row.steps,
    currentStepId: row.currentStepId ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    triggerPayload: row.triggerPayload ?? undefined,
  };
}

/**
 * Maps WorkflowExecution to canonical database values.
 * @param execution - Workflow execution from API
 * @returns Database values for insert/update
 */
function toExecutionDbValues(execution: WorkflowExecution): InsertWorkflowExecution {
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    coordinatorSessionId: execution.coordinatorSessionId ?? null,
    status: execution.status,
    inputs: execution.inputs,
    steps: execution.steps,
    currentStepId: execution.currentStepId ?? null,
    error: execution.error ?? null,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt ?? null,
    triggerPayload: execution.triggerPayload ?? null,
  };
}

/**
 * Build execution insert payload from the canonical DB mapping.
 * Keeps insert + conflict-update shapes derived from one source of truth.
 * @param execution - Workflow execution from API
 * @returns Insert payload for workflow_executions table
 */
function toExecutionInsertValues(execution: WorkflowExecution): InsertWorkflowExecution {
  return toExecutionDbValues(execution);
}

/**
 * Registers execution CRUD handlers.
 *
 * Custom implementation for executions since they need different upsert logic
 * than definitions (no automatic timestamps, different update patterns).
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @returns Cleanup function to unregister handlers
 */
function registerExecutionHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubGetExecution = bus.on(WorkflowStorageSubjects.getExecution, async (ctx) => {
    const { executionId } = ctx.payload;
    const rows = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
    const execution = rows[0] ? mapExecution(rows[0]) : null;
    ctx.setResult({ execution });
  });

  const unsubSetExecution = bus.on(WorkflowStorageSubjects.setExecution, async (ctx) => {
    const { execution } = ctx.payload;
    const dbValues = toExecutionDbValues(execution);
    const insertValues = toExecutionInsertValues(execution);

    // Upsert: insert or update on conflict
    await db.insert(workflowExecutions).values(insertValues).onConflictDoUpdate({
      target: workflowExecutions.id,
      set: dbValues,
    });

    ctx.setResult({ id: execution.id });
  });

  const unsubListExecutions = bus.on(WorkflowStorageSubjects.listExecutions, async (ctx) => {
    const { workflowId, status } = ctx.payload;

    const predicates = [
      ...(workflowId ? [eq(workflowExecutions.workflowId, workflowId)] : []),
      ...(status ? [eq(workflowExecutions.status, status)] : []),
    ];

    const query =
      predicates.length > 0
        ? db
            .select()
            .from(workflowExecutions)
            .where(and(...predicates))
        : db.select().from(workflowExecutions);

    const rows = await query;
    const executions = rows.map(mapExecution);

    ctx.setResult({ executions });
  });

  return () => {
    unsubGetExecution();
    unsubSetExecution();
    unsubListExecutions();
  };
}

/**
 * Registers all Drizzle-based workflow storage handlers with the bus.
 *
 * Handles:
 * - Definition CRUD: get, set, delete, list
 * - Execution CRUD: getExecution, setExecution, listExecutions
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

  return () => {
    definitionCrudCleanup();
    definitionListCleanup();
    executionCleanup();
  };
}
