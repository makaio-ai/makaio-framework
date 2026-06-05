import { eq } from 'drizzle-orm';
import type { MakaioDatabase, TransactionCallback } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue, WorkflowRunContext, WorkflowWorkerSource } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowRunContexts, type InsertWorkflowRunContext } from './schema.js';
import { toScopeColumns, fromScopeColumns } from './scope-helpers.js';

// ─────────────────────────────────────────────────────────────
// Source column helpers
// ─────────────────────────────────────────────────────────────

/**
 * Decompose a {@link WorkflowWorkerSource} discriminated union into the flat
 * columns stored in `workflow_run_contexts`.
 * @param source - Workflow source descriptor to flatten.
 * @returns Flat column values for `sourceKind`, `sourcePath`, `sourceFilename`, `sourceCode`.
 */
function toSourceColumns(
  source: WorkflowWorkerSource,
): Pick<InsertWorkflowRunContext, 'sourceKind' | 'sourcePath' | 'sourceFilename' | 'sourceCode'> {
  switch (source.kind) {
    case 'path':
      return { sourceKind: 'path', sourcePath: source.path, sourceFilename: null, sourceCode: null };
    case 'source':
      return { sourceKind: 'source', sourcePath: null, sourceFilename: source.filename, sourceCode: source.source };
    case 'definition':
      return { sourceKind: 'definition', sourcePath: null, sourceFilename: null, sourceCode: null };
  }
}

/**
 * Reconstruct a {@link WorkflowWorkerSource} from flat row columns.
 * @param row - Row fragment with source columns.
 * @returns Reconstructed source discriminated union.
 * @throws Error when required columns are missing for the declared kind.
 */
function fromSourceColumns(
  row: Pick<InsertWorkflowRunContext, 'sourceKind' | 'sourcePath' | 'sourceFilename' | 'sourceCode' | 'workflowId'>,
): WorkflowWorkerSource {
  switch (row.sourceKind) {
    case 'path':
      if (!row.sourcePath) throw new Error('Invalid run context row: sourcePath required for kind=path');
      return { kind: 'path', path: row.sourcePath };
    case 'source':
      if (!row.sourceFilename) throw new Error('Invalid run context row: sourceFilename required for kind=source');
      return { kind: 'source', filename: row.sourceFilename, source: row.sourceCode ?? '' };
    case 'definition':
      return { kind: 'definition', workflowId: row.workflowId };
    default:
      throw new Error(`Unknown run context source kind: ${String(row.sourceKind)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Row mappers
// ─────────────────────────────────────────────────────────────

type DbRunContextRow = typeof workflowRunContexts.$inferSelect;
type RunContextStorageExecutor = MakaioDatabase | Parameters<TransactionCallback<void>>[0];

/**
 * Map a database row to a {@link WorkflowRunContext}.
 * @param row - Database row from `workflow_run_contexts`.
 * @returns Mapped run context.
 */
function mapRunContext(row: DbRunContextRow): WorkflowRunContext {
  return {
    executionId: row.executionId,
    workflowId: row.workflowId,
    coordinatorSessionId: row.coordinatorSessionId,
    source: fromSourceColumns(row),
    definitionSnapshot: row.definitionSnapshot ?? undefined,
    workerManifest: row.workerManifest,
    inputs: row.inputs as Record<string, unknown>,
    triggerPayload: row.triggerPayload as Record<string, unknown>,
    scope: fromScopeColumns(row),
    cancelSubject: row.cancelSubject,
    context: row.context,
    env: row.env,
    createdAt: row.createdAt,
  };
}

/**
 * Map a {@link WorkflowRunContext} to a Drizzle insert row.
 * @param runContext - Run context to persist.
 * @returns Insert values for `workflow_run_contexts`.
 */
function toRunContextDbValues(runContext: WorkflowRunContext): InsertWorkflowRunContext {
  const sourceColumns = toSourceColumns(runContext.source);
  const scopeColumns = toScopeColumns(runContext.scope);
  return {
    executionId: runContext.executionId,
    workflowId: runContext.workflowId,
    coordinatorSessionId: runContext.coordinatorSessionId,
    ...sourceColumns,
    definitionSnapshot: runContext.definitionSnapshot ?? null,
    workerManifest: runContext.workerManifest,
    inputs: runContext.inputs as Record<string, JsonValue>,
    triggerPayload: runContext.triggerPayload as Record<string, JsonValue>,
    ...scopeColumns,
    cancelSubject: runContext.cancelSubject,
    context: runContext.context,
    env: runContext.env,
    createdAt: runContext.createdAt,
  };
}

/**
 * Upsert a workflow run-context snapshot.
 * @param db - Database or transaction executor.
 * @param runContext - Run context to persist.
 */
export async function upsertWorkflowRunContext(
  db: RunContextStorageExecutor,
  runContext: WorkflowRunContext,
): Promise<void> {
  const dbValues = toRunContextDbValues(runContext);
  await db
    .insert(workflowRunContexts)
    .values(dbValues)
    .onConflictDoUpdate({ target: workflowRunContexts.executionId, set: dbValues });
}

// ─────────────────────────────────────────────────────────────
// Handler registration
// ─────────────────────────────────────────────────────────────

/**
 * Register storage handlers for `setRunContext` and `getRunContext` subjects.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerRunContextHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubSet = bus.on(WorkflowStorageSubjects.setRunContext, async (ctx) => {
    const runContext = ctx.payload.runContext as WorkflowRunContext;
    await upsertWorkflowRunContext(db, runContext);
    ctx.setResult({ executionId: runContext.executionId });
  });

  const unsubGet = bus.on(WorkflowStorageSubjects.getRunContext, async (ctx) => {
    const { executionId } = ctx.payload;
    const rows = await db.select().from(workflowRunContexts).where(eq(workflowRunContexts.executionId, executionId));
    const runContext = rows[0] ? mapRunContext(rows[0]) : null;
    ctx.setResult({ runContext });
  });

  return () => {
    unsubSet();
    unsubGet();
  };
}
