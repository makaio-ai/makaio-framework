import { eq, and, getTableColumns, sql } from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type {
  JsonValue,
  RejectedWorkflowDefinition,
  WorkflowDefinition,
  WorkflowDefinitionList,
} from '@makaio/contracts';
import { WorkflowDefinitionSchema, WorkflowError, WorkflowErrorCode } from '@makaio/contracts';
import {
  executeTransaction,
  resolveSchema,
  serializeDatabaseOperation,
  type MakaioDatabase,
} from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects, type WorkflowListQuery } from './namespace.js';
import type { InsertWorkflowDefinition } from './schema.js';
import { workflowEngineSchema } from './schema.variants.js';
import { buildScopePredicates, toScopeColumns } from './scope-helpers.js';
import {
  describeWorkflowDefinitionIssues,
  readStoredDefinition,
  storedDefinitionSelection,
  type WorkflowDefinitionsTable,
} from './stored-definition.js';

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
    extensions: workflow.extensions ?? null,
    source: workflow.source ?? null,
    executableSource: workflow.executableSource ?? null,
    requirements: workflow.requirements ?? null,
    successFinalizerId: workflow.successFinalizerId ?? null,
    createdAt: now,
    updatedAt: now,
    ...scopeColumns,
  };
  return values;
}

/**
 * Selects the lifecycle subject announcing a persisted definition write.
 * @param kind - Whether the write inserted a new row or updated an existing one
 * @returns The `definition.created` or `definition.updated` subject
 */
function definitionEventSubject(
  kind: 'created' | 'updated',
): typeof WorkflowSubjects.definition.created | typeof WorkflowSubjects.definition.updated {
  return kind === 'created' ? WorkflowSubjects.definition.created : WorkflowSubjects.definition.updated;
}

/**
 * Builds the `SET` clause for updating an existing `workflow_definitions` row.
 *
 * Per-column rule: `name`, `root`, `updatedAt`, `state`, `extensions`, `executableSource`, `requirements`,
 * `successFinalizerId` and the scope columns always take the incoming value; `description`, `inputSchema`,
 * `configSchema`, `outputSchema`, `artifact`, `triggers` and `source` keep the stored value when the
 * incoming value is null; `createdAt` is always preserved. This is the only place the "missing value keeps the
 * stored value" rule lives — the re-check in {@link writeDefinition} never reimplements it.
 * @param values - Incoming column values from {@link toDefinitionDbValues}
 * @param columns - Table columns, used to reference the stored values
 * @param now - Current epoch milliseconds for `updatedAt`
 * @param scope - Scope of the workflow being written
 * @returns Update source for the `workflow_definitions` table
 */
function toDefinitionUpdateSet(
  values: InsertWorkflowDefinition,
  columns: WorkflowDefinitionsTable['_']['columns'],
  now: number,
  scope: WorkflowDefinition['scope'],
): SQLiteUpdateSetSource<WorkflowDefinitionsTable> {
  return {
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
    extensions: values.extensions,
    source: values.source !== null ? values.source : sql`${columns.source}`,
    executableSource: values.executableSource,
    requirements: values.requirements,
    successFinalizerId: values.successFinalizerId,
    ...toScopeColumns(scope),
  };
}

/**
 * Reads one stored workflow definition, checked against the schema.
 * @param db - Database handle to query on.
 * @param table - Resolved `workflow_definitions` table.
 * @param columns - Table columns, used for the stored-text selection.
 * @param id - Identifier of the row to read.
 * @returns The checked definition, or `undefined` when no row exists for `id`.
 * @throws WorkflowError With code `DEFINITION_INVALID` when the stored row does not satisfy
 * {@link WorkflowDefinitionSchema}.
 */
async function readDefinition(
  db: MakaioDatabase,
  table: WorkflowDefinitionsTable,
  columns: WorkflowDefinitionsTable['_']['columns'],
  id: string,
): Promise<WorkflowDefinition | undefined> {
  const [row] = await db.select(storedDefinitionSelection(columns)).from(table).where(eq(table.id, id)).limit(1);
  if (!row) return undefined;
  const checked = readStoredDefinition(row);
  if ('rejected' in checked) {
    throw new WorkflowError(
      WorkflowErrorCode.DEFINITION_INVALID,
      `Stored workflow definition '${checked.rejected.id}' does not satisfy WorkflowDefinitionSchema: ${checked.rejected.reason}`,
    );
  }
  return checked.definition;
}

/**
 * Lists stored workflow definitions matching an optional scope filter.
 *
 * Readable rows are returned in `workflows`; unreadable rows are reported in `rejected` — this never
 * throws and never deletes a row.
 * @param db - Database handle to query on.
 * @param table - Resolved `workflow_definitions` table.
 * @param columns - Table columns, used for the stored-text selection.
 * @param query - List query, optionally scoped.
 * @returns The readable definitions and the rejected rows.
 */
async function listDefinitions(
  db: MakaioDatabase,
  table: WorkflowDefinitionsTable,
  columns: WorkflowDefinitionsTable['_']['columns'],
  query: WorkflowListQuery,
): Promise<WorkflowDefinitionList> {
  const predicates = query.scope ? buildScopePredicates(table, query.scope) : [];
  const rows =
    predicates.length > 0
      ? await db
          .select(storedDefinitionSelection(columns))
          .from(table)
          .where(and(...predicates))
      : await db.select(storedDefinitionSelection(columns)).from(table);

  const workflows: WorkflowDefinition[] = [];
  const rejected: RejectedWorkflowDefinition[] = [];
  for (const row of rows) {
    const checked = readStoredDefinition(row);
    if ('rejected' in checked) {
      rejected.push(checked.rejected);
    } else {
      workflows.push(checked.definition);
    }
  }
  return { workflows, rejected };
}

/**
 * Writes a workflow definition (insert or update) and returns the checked event payload.
 *
 * Validates the incoming definition before any column mapping or serialization, then writes and
 * re-reads the resulting row inside one {@link executeTransaction} (steps 1-3): a row that fails the re-check rolls
 * the insert or update back, so nothing is persisted. The caller sends the lifecycle event only after this
 * transaction has committed, with the checked definition.
 * @param db - Database handle.
 * @param table - Resolved `workflow_definitions` table.
 * @param columns - Table columns.
 * @param workflow - Incoming workflow definition.
 * @param now - Current epoch milliseconds for timestamp columns.
 * @returns The write kind and the checked definition, or `undefined` when neither an insert nor an update touched
 * a row.
 * @throws WorkflowError With code `DEFINITION_INVALID` when the incoming definition, or the definition rebuilt from
 * the resulting stored row, does not satisfy {@link WorkflowDefinitionSchema}.
 */
async function writeDefinition(
  db: MakaioDatabase,
  table: WorkflowDefinitionsTable,
  columns: WorkflowDefinitionsTable['_']['columns'],
  workflow: WorkflowDefinition,
  now: number,
): Promise<{ readonly kind: 'created' | 'updated'; readonly definition: WorkflowDefinition } | undefined> {
  const incomingCheck = WorkflowDefinitionSchema.safeParse(workflow);
  if (!incomingCheck.success) {
    throw new WorkflowError(
      WorkflowErrorCode.DEFINITION_INVALID,
      `Workflow definition '${workflow.id}' does not satisfy WorkflowDefinitionSchema: ${describeWorkflowDefinitionIssues(incomingCheck.error)}`,
    );
  }

  const values = toDefinitionDbValues(workflow, now);

  return executeTransaction(db, async (tx) => {
    const insertedRows = await tx
      .insert(table)
      .values(values)
      .onConflictDoNothing({ target: table.id })
      .returning({ id: table.id });

    const written: { readonly kind: 'created' | 'updated'; readonly id: string } | undefined =
      insertedRows.length > 0
        ? { kind: 'created', id: insertedRows[0]!.id }
        : await (async () => {
            const [updatedRow] = await tx
              .update(table)
              .set(toDefinitionUpdateSet(values, columns, now, workflow.scope))
              .where(eq(table.id, workflow.id))
              .returning({ id: table.id });
            return updatedRow ? { kind: 'updated' as const, id: updatedRow.id } : undefined;
          })();
    if (!written) return undefined;

    const [row] = await tx
      .select(storedDefinitionSelection(columns))
      .from(table)
      .where(eq(table.id, written.id))
      .limit(1);
    const checked = readStoredDefinition(row!);
    if ('rejected' in checked) {
      throw new WorkflowError(
        WorkflowErrorCode.DEFINITION_INVALID,
        `Workflow definition '${workflow.id}' cannot be stored: the resulting definition does not satisfy WorkflowDefinitionSchema: ${checked.rejected.reason}`,
      );
    }
    return { kind: written.kind, definition: checked.definition };
  });
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
    const workflow = await readDefinition(db, workflowDefinitions, columns, ctx.payload.id);
    ctx.setResult({ workflow: workflow ?? null });
  });

  const unsubSet = bus.on(WorkflowStorageSubjects.set, async (ctx) => {
    const workflow = ctx.payload.workflow as WorkflowDefinition;
    const now = Date.now();
    const event = await writeDefinition(db, workflowDefinitions, columns, workflow, now);
    if (event) {
      await bus.emit(ctx.call, definitionEventSubject(event.kind), event.definition);
    }
    ctx.setResult({ id: workflow.id });
  });

  const unsubDelete = bus.on(WorkflowStorageSubjects.delete, async (ctx) => {
    const deletedRows = await serializeDatabaseOperation(db, () =>
      db
        .delete(workflowDefinitions)
        .where(eq(workflowDefinitions.id, ctx.payload.id))
        .returning({ id: workflowDefinitions.id }),
    );
    const deleted = deletedRows.length > 0;
    if (deleted) {
      await bus.emit(ctx.call, WorkflowSubjects.definition.deleted, { id: ctx.payload.id });
    }
    ctx.setResult({ deleted });
  });

  const unsubList = bus.on(WorkflowStorageSubjects.list, async (ctx) => {
    const payload = ctx.payload as WorkflowListQuery;
    const result = await listDefinitions(db, workflowDefinitions, columns, payload);
    ctx.setResult(result);
  });

  return () => {
    unsubGet();
    unsubSet();
    unsubDelete();
    unsubList();
  };
}
