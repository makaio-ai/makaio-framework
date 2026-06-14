import { eq, and, getTableColumns, sql } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue, WorkflowDefinition } from '@makaio/contracts';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects, type WorkflowListQuery } from './namespace.js';
import type { InsertWorkflowDefinition } from './schema.js';
import { workflowEngineSchema } from './schema.variants.js';
import { buildScopePredicates, toScopeColumns, fromScopeColumns } from './scope-helpers.js';

type WorkflowDefinitionsTable = typeof workflowEngineSchema.sqlite.workflowDefinitions;
type DbDefinitionRow = WorkflowDefinitionsTable['$inferSelect'];

/**
 * Maps a database row to the `WorkflowDefinition` API type.
 * @param row - Database row from `workflow_definitions`
 * @returns Mapped `WorkflowDefinition` with optional fields normalised
 */
function mapDefinition(row: DbDefinitionRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    root: row.root,
    inputSchema: (row.inputSchema as WorkflowDefinition['inputSchema']) ?? undefined,
    configSchema: (row.configSchema as WorkflowDefinition['configSchema']) ?? undefined,
    outputSchema: (row.outputSchema as WorkflowDefinition['outputSchema']) ?? undefined,
    state: (row.state as WorkflowDefinition['state']) ?? undefined,
    artifact: row.artifact ?? undefined,
    triggers: row.triggers ?? undefined,
    scope: fromScopeColumns(row),
    canvasLayout: (row.canvasLayout as WorkflowDefinition['canvasLayout']) ?? undefined,
    source: (row.source as WorkflowDefinition['source']) ?? undefined,
    executionHints: (row.executionHints as WorkflowDefinition['executionHints']) ?? undefined,
  };
}

/**
 * Maps a `WorkflowDefinition` to database column values for insert/update.
 * @param workflow - Workflow definition to persist
 * @param now - Current epoch milliseconds for timestamp columns
 * @returns Column values for the `workflow_definitions` table
 */
function toDefinitionDbValues(workflow: WorkflowDefinition, now: number): InsertWorkflowDefinition {
  const scopeColumns = toScopeColumns(workflow.scope);
  const values: InsertWorkflowDefinition = {
    id: workflow.id,
    name: workflow.name ?? workflow.id,
    root: workflow.root,
    description: workflow.description ?? null,
    inputSchema: (workflow.inputSchema as Record<string, JsonValue> | undefined) ?? null,
    configSchema: (workflow.configSchema as Record<string, JsonValue> | undefined) ?? null,
    outputSchema: (workflow.outputSchema as Record<string, JsonValue> | undefined) ?? null,
    state: workflow.state ?? null,
    artifact: workflow.artifact ?? null,
    triggers: workflow.triggers ?? null,
    canvasLayout: (workflow.canvasLayout as Record<string, JsonValue> | undefined) ?? null,
    source: workflow.source ?? null,
    executionHints: workflow.executionHints ?? null,
    createdAt: now,
    updatedAt: now,
    ...scopeColumns,
  };
  return values;
}

/**
 * Registers all workflow definition bus handlers (get, set, delete, list).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerDefinitionHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { workflowDefinitions } = resolveSchema(db, workflowEngineSchema);
  const columns = getTableColumns(workflowDefinitions);

  const unsubGet = bus.on(WorkflowStorageSubjects.get, async (ctx) => {
    const rows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, ctx.payload.id)).limit(1);
    ctx.setResult({ workflow: rows[0] ? mapDefinition(rows[0]) : null });
  });

  const unsubSet = bus.on(WorkflowStorageSubjects.set, async (ctx) => {
    const workflow = ctx.payload.workflow as WorkflowDefinition;
    const now = Date.now();
    const values = toDefinitionDbValues(workflow, now);

    // Attempt insert; on PK conflict check if this is a create or update.
    const insertedRows = await db
      .insert(workflowDefinitions)
      .values(values)
      .onConflictDoNothing({ target: workflowDefinitions.id })
      .returning();

    if (insertedRows.length > 0) {
      await bus.emit(WorkflowSubjects.definition.created, mapDefinition(insertedRows[0]));
      ctx.setResult({ id: workflow.id });
      return;
    }

    // Build the update set: always-present fields are overwritten. Most
    // optional metadata fields preserve existing values when omitted; `state`
    // is a full contract and must clear when omitted from the replacement
    // definition.
    const [updatedRow] = await db
      .update(workflowDefinitions)
      .set({
        name: values.name,
        root: values.root,
        updatedAt: now,
        // Preserve the original createdAt — do not overwrite with `now`.
        createdAt: sql`COALESCE(${columns.createdAt}, ${now})`,
        // Optional fields: keep existing DB value when incoming value is null.
        description: values.description !== null ? values.description : sql`${columns.description}`,
        inputSchema: values.inputSchema !== null ? values.inputSchema : sql`${columns.inputSchema}`,
        configSchema: values.configSchema !== null ? values.configSchema : sql`${columns.configSchema}`,
        outputSchema: values.outputSchema !== null ? values.outputSchema : sql`${columns.outputSchema}`,
        state: values.state,
        artifact: values.artifact !== null ? values.artifact : sql`${columns.artifact}`,
        triggers: values.triggers !== null ? values.triggers : sql`${columns.triggers}`,
        canvasLayout: values.canvasLayout !== null ? values.canvasLayout : sql`${columns.canvasLayout}`,
        source: values.source !== null ? values.source : sql`${columns.source}`,
        executionHints: values.executionHints !== null ? values.executionHints : sql`${columns.executionHints}`,
        ...toScopeColumns(workflow.scope),
      })
      .where(eq(workflowDefinitions.id, workflow.id))
      .returning();

    if (updatedRow) {
      await bus.emit(WorkflowSubjects.definition.updated, mapDefinition(updatedRow));
    }
    ctx.setResult({ id: workflow.id });
  });

  const unsubDelete = bus.on(WorkflowStorageSubjects.delete, async (ctx) => {
    const deletedRows = await db
      .delete(workflowDefinitions)
      .where(eq(workflowDefinitions.id, ctx.payload.id))
      .returning();
    const deleted = deletedRows.length > 0;
    if (deleted) {
      await bus.emit(WorkflowSubjects.definition.deleted, { id: ctx.payload.id });
    }
    ctx.setResult({ deleted });
  });

  const unsubList = bus.on(WorkflowStorageSubjects.list, async (ctx) => {
    const payload = ctx.payload as WorkflowListQuery;
    const predicates = payload.scope ? buildScopePredicates(workflowDefinitions, payload.scope) : [];

    const rows =
      predicates.length > 0
        ? await db
            .select()
            .from(workflowDefinitions)
            .where(and(...predicates))
        : await db.select().from(workflowDefinitions);

    ctx.setResult({ workflows: rows.map(mapDefinition) });
  });

  return () => {
    unsubGet();
    unsubSet();
    unsubDelete();
    unsubList();
  };
}
