import { eq, and } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext, SpanRecord, ExecutionLink } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { createDrizzleCrudHandlers, createDrizzleListHandler, buildScopePredicates } from '@makaio/storage-handlers';
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
  workflowStepSpans,
  workflowExecutionLinks,
  type InsertWorkflowExecution,
} from './schema.js';

type DbDefinitionRow = typeof workflowDefinitions.$inferSelect;
type DbExecutionRow = typeof workflowExecutions.$inferSelect;
type DbSpanRow = typeof workflowStepSpans.$inferSelect;
type DbExecutionLinkRow = typeof workflowExecutionLinks.$inferSelect;

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
    await db.insert(workflowExecutions).values(dbValues).onConflictDoUpdate({
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

// ─────────────────────────────────────────────────────────────
// Span and Execution Link Mappers
// ─────────────────────────────────────────────────────────────

/**
 * Map nullable DB columns to optional API fields.
 * @param row - Database row
 * @returns Mapped span record
 */
function mapSpan(row: DbSpanRow): SpanRecord {
  return {
    executionId: row.executionId,
    stepId: row.stepId,
    stepType: row.stepType,
    status: row.status,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    estimatedCost: row.estimatedCost ?? undefined,
    toolCallCount: row.toolCallCount ?? undefined,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
  };
}

/**
 * Map nullable DB columns to optional API fields.
 * @param row - Database row
 * @returns Mapped execution link
 */
function mapExecutionLink(row: DbExecutionLinkRow): ExecutionLink {
  return {
    sourceExecutionId: row.sourceExecutionId,
    targetExecutionId: row.targetExecutionId,
    linkType: row.linkType,
    metadata: row.metadata ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Span and Execution Link Handlers
// ─────────────────────────────────────────────────────────────

/**
 * Registers span and execution link handlers.
 *
 * Handles:
 * - Span CRUD: setSpan, listSpans
 * - Execution link CRUD: setExecutionLink, listExecutionLinks
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @returns Cleanup function to unregister handlers
 */
function registerSpanHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubSetSpan = bus.on(WorkflowStorageSubjects.setSpan, async (ctx) => {
    const { span } = ctx.payload;
    await db
      .insert(workflowStepSpans)
      .values(span)
      .onConflictDoUpdate({
        target: [workflowStepSpans.executionId, workflowStepSpans.stepId],
        set: span,
      });
    ctx.setResult({ id: `${span.executionId}:${span.stepId}` });
  });

  const unsubListSpans = bus.on(WorkflowStorageSubjects.listSpans, async (ctx) => {
    const rows = await db
      .select()
      .from(workflowStepSpans)
      .where(eq(workflowStepSpans.executionId, ctx.payload.executionId));
    ctx.setResult({ spans: rows.map(mapSpan) });
  });

  const unsubSetExecutionLink = bus.on(WorkflowStorageSubjects.setExecutionLink, async (ctx) => {
    const { link } = ctx.payload;
    await db
      .insert(workflowExecutionLinks)
      .values(link)
      .onConflictDoUpdate({
        target: [workflowExecutionLinks.sourceExecutionId, workflowExecutionLinks.targetExecutionId],
        set: link,
      });
    ctx.setResult({ id: `${link.sourceExecutionId}:${link.targetExecutionId}` });
  });

  const unsubListExecutionLinks = bus.on(WorkflowStorageSubjects.listExecutionLinks, async (ctx) => {
    const { sourceExecutionId, targetExecutionId } = ctx.payload;
    if (sourceExecutionId === undefined && targetExecutionId === undefined) {
      throw new Error('Either sourceExecutionId or targetExecutionId is required to list execution links.');
    }

    const predicates = [
      ...(sourceExecutionId !== undefined ? [eq(workflowExecutionLinks.sourceExecutionId, sourceExecutionId)] : []),
      ...(targetExecutionId !== undefined ? [eq(workflowExecutionLinks.targetExecutionId, targetExecutionId)] : []),
    ];
    const query = db
      .select()
      .from(workflowExecutionLinks)
      .where(and(...predicates));
    ctx.setResult({ links: (await query).map(mapExecutionLink) });
  });

  return () => {
    unsubSetSpan();
    unsubListSpans();
    unsubSetExecutionLink();
    unsubListExecutionLinks();
  };
}

/**
 * Registers all Drizzle-based workflow storage handlers with the bus.
 *
 * Handles:
 * - Definition CRUD: get, set, delete, list
 * - Execution CRUD: getExecution, setExecution, listExecutions
 * - Span CRUD: setSpan, listSpans
 * - Execution link CRUD: setExecutionLink, listExecutionLinks
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

  return () => {
    definitionCrudCleanup();
    definitionListCleanup();
    executionCleanup();
    spanCleanup();
  };
}
