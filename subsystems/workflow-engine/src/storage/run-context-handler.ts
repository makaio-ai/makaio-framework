import { eq } from 'drizzle-orm';
import {
  executeTransaction,
  resolveSchema,
  type MakaioDatabase,
  type TransactionCallback,
} from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type {
  JsonPatchOperation,
  JsonValue,
  StoredWorkflowRunContext,
  WorkflowRunContext,
  WorkflowWorkerSource,
} from '@makaio/contracts';
import { JsonValueSchema } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './namespace.js';
import type { InsertWorkflowRunContext } from './schema.js';
import { workflowEngineSchema } from './schema.variants.js';
import { toScopeColumns, fromScopeColumns } from './scope-helpers.js';
import { decodeStoredJson, storedJsonText } from './stored-definition.js';
import { toWorkflowStateJsonColumnValue } from './state-json-column.js';

type WorkflowRunContextsTable = typeof workflowEngineSchema.sqlite.workflowRunContexts;

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

type DbRunContextRow = WorkflowRunContextsTable['$inferSelect'];
type RunContextStorageExecutor = MakaioDatabase | Parameters<TransactionCallback<void>>[0];

/** A run-context row with the active columns and the definition snapshot as stored text. */
type StoredRunContextRow = {
  [Key in keyof ReturnType<typeof runContextSelection>]: Key extends 'definitionSnapshot'
    ? string | null
    : DbRunContextRow[Key];
};

/**
 * Select the active run-context columns, reading the snapshot as uninterpreted text.
 * @param table - Dialect-resolved `workflow_run_contexts` table.
 * @returns Field map whose result type is {@link StoredRunContextRow}.
 */
function runContextSelection(table: WorkflowRunContextsTable) {
  return {
    executionId: table.executionId,
    workflowId: table.workflowId,
    coordinatorSessionId: table.coordinatorSessionId,
    sourceKind: table.sourceKind,
    sourcePath: table.sourcePath,
    sourceFilename: table.sourceFilename,
    sourceCode: table.sourceCode,
    definitionSnapshot: storedJsonText(table.definitionSnapshot),
    workerManifest: table.workerManifest,
    inputs: table.inputs,
    config: table.config,
    triggerPayload: table.triggerPayload,
    triggerMode: table.triggerMode,
    artifactRef: table.artifactRef,
    scopeType: table.scopeType,
    scopeKind: table.scopeKind,
    scopeId: table.scopeId,
    cancelSubject: table.cancelSubject,
    env: table.env,
    createdAt: table.createdAt,
    terminalAuthority: table.terminalAuthority,
    materializationSpec: table.materializationSpec,
  };
}

/**
 * Decode a stored run-context snapshot without interpreting it as a workflow definition.
 *
 * `null` (no snapshot persisted) decodes to `undefined`. When the stored text decodes as
 * JSON and satisfies {@link JsonValueSchema}, the decoded value is the result; otherwise the
 * stored text itself is kept as a string, so neither cancellation nor technical
 * failure handling ever fails on a snapshot that is no longer a valid definition.
 * @param text - Stored text of the `definition_snapshot` column, or null.
 * @returns The decoded snapshot value, the raw text, or `undefined` when nothing was stored.
 */
function decodeRunContextSnapshot(text: string | null): JsonValue | undefined {
  if (text === null) return undefined;
  const decoded = decodeStoredJson(text);
  if (decoded.ok) {
    const parsed = JsonValueSchema.safeParse(decoded.value);
    if (parsed.success) return parsed.data;
  }
  return text;
}

/**
 * Map a database row to a {@link StoredWorkflowRunContext}.
 * @param row - Row selected with `definitionSnapshot` as stored text (see {@link StoredRunContextRow}).
 * @returns Mapped run context, read without interpreting the snapshot.
 */
function mapRunContext(row: StoredRunContextRow): StoredWorkflowRunContext {
  return {
    executionId: row.executionId,
    workflowId: row.workflowId,
    coordinatorSessionId: row.coordinatorSessionId,
    source: fromSourceColumns(row),
    definitionSnapshot: decodeRunContextSnapshot(row.definitionSnapshot),
    workerManifest: row.workerManifest,
    inputs: row.inputs,
    config: (row.config as Record<string, unknown> | null) ?? {},
    triggerPayload: row.triggerPayload as Record<string, unknown>,
    triggerMode: row.triggerMode,
    ...(row.artifactRef !== null ? { artifactRef: row.artifactRef } : {}),
    scope: fromScopeColumns(row),
    cancelSubject: row.cancelSubject,
    env: row.env,
    createdAt: row.createdAt,
    ...(row.terminalAuthority !== null ? { terminalAuthority: row.terminalAuthority } : {}),
    ...(row.materializationSpec !== null ? { materializationSpec: row.materializationSpec } : {}),
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
    inputs: runContext.inputs,
    config: (runContext.config ?? {}) as Record<string, JsonValue>,
    triggerPayload: runContext.triggerPayload as Record<string, JsonValue>,
    triggerMode: runContext.triggerMode ?? 'immediate',
    artifactRef: runContext.artifactRef ?? null,
    ...scopeColumns,
    cancelSubject: runContext.cancelSubject,
    env: runContext.env,
    createdAt: runContext.createdAt,
    terminalAuthority: runContext.terminalAuthority ?? null,
    materializationSpec: runContext.materializationSpec ?? null,
  };
}

/**
 * Upsert a workflow run-context snapshot.
 * @param db - Database or transaction executor.
 * @param runContext - Run context to persist.
 * @param workflowRunContexts - Dialect-resolved table object. Callers must
 *   resolve this from a real branded handle via `resolveSchema` because
 *   transaction objects carry no dialect brand.
 */
export async function upsertWorkflowRunContext(
  db: RunContextStorageExecutor,
  runContext: WorkflowRunContext,
  workflowRunContexts: WorkflowRunContextsTable,
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
  const { workflowRunContexts, workflowExecutionState, workflowExecutionStateEvents } = resolveSchema(
    db,
    workflowEngineSchema,
  );

  const unsubSet = bus.on(WorkflowStorageSubjects.setRunContext, async (ctx) => {
    const runContext = ctx.payload.runContext as WorkflowRunContext;
    const initialState = ctx.payload.initialState as JsonValue | undefined;
    await executeTransaction(db, async (tx) => {
      await upsertWorkflowRunContext(tx, runContext, workflowRunContexts);
      if (initialState === undefined) return;
      const now = Date.now();
      const initialColumnValue = toWorkflowStateJsonColumnValue(db, initialState);
      await tx
        .insert(workflowExecutionState)
        .values({ executionId: runContext.executionId, sequence: 0, value: initialColumnValue, updatedAt: now })
        .onConflictDoNothing();
      await tx
        .insert(workflowExecutionStateEvents)
        .values({
          executionId: runContext.executionId,
          sequence: 0,
          patch: [] as JsonPatchOperation[],
          value: initialColumnValue,
          createdAt: now,
        })
        .onConflictDoNothing();
    });
    ctx.setResult({ executionId: runContext.executionId });
  });

  const unsubGet = bus.on(WorkflowStorageSubjects.getRunContext, async (ctx) => {
    const { executionId } = ctx.payload;
    const rows = await db
      .select(runContextSelection(workflowRunContexts))
      .from(workflowRunContexts)
      .where(eq(workflowRunContexts.executionId, executionId));
    const runContext = rows[0] ? mapRunContext(rows[0]) : null;
    ctx.setResult({ runContext });
  });

  return () => {
    unsubSet();
    unsubGet();
  };
}
