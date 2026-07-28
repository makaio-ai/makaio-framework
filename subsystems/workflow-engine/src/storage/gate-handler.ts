import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  EXECUTION_LIST_DEFAULT_LIMIT,
  EXECUTION_LIST_MAX_LIMIT,
  EXECUTION_LIST_MIN_LIMIT,
  type JsonValue,
  type WorkflowGateInstance,
} from '@makaio/contracts';
import { resolveSchema, serializeDatabaseOperation, type MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowStorageSubjects } from './namespace.js';
import type { InsertWorkflowGateInstance } from './schema.js';
import { workflowEngineSchema } from './schema.variants.js';
import { isExecutionBoundAccessAllowed } from '../execution-bound-access.js';

type WorkflowGateInstancesTable = typeof workflowEngineSchema.sqlite.workflowGateInstances;
type DbGateRow = WorkflowGateInstancesTable['$inferSelect'];

/**
 * Build the stable primary key for a gate instance row.
 * @param gate - Gate instance identity fields.
 * @returns Storage row ID for the gate instance.
 */
function gateInstanceId(gate: Pick<WorkflowGateInstance, 'executionId' | 'nodeId' | 'frameId'>): string {
  return `${gate.executionId}:${gate.nodeId}:${gate.frameId}`;
}

/**
 * Maps a database row to the `WorkflowGateInstance` API type.
 * @param row - Database row from `workflow_gate_instances`
 * @returns Mapped `WorkflowGateInstance` with optional fields normalised
 */
export function mapGateInstance(row: DbGateRow): WorkflowGateInstance {
  return {
    executionId: row.executionId,
    nodeId: row.nodeId,
    frameId: row.frameId,
    schema: row.schema as WorkflowGateInstance['schema'],
    prompt: row.prompt ?? undefined,
    status: row.status,
    autoAction: row.autoAction,
    timeoutMs: row.timeoutMs ?? null,
    ...(row.resumeDataPresent ? { resumeData: row.resumeData as JsonValue } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}

/**
 * Maps a `WorkflowGateInstance` to database values for insert/update.
 * @param gate - Gate instance to persist
 * @returns Column values for the `workflow_gate_instances` table
 */
export function toGateDbValues(gate: WorkflowGateInstance): InsertWorkflowGateInstance {
  return {
    id: gateInstanceId(gate),
    executionId: gate.executionId,
    nodeId: gate.nodeId,
    frameId: gate.frameId,
    schema: gate.schema,
    prompt: gate.prompt ?? null,
    status: gate.status,
    autoAction: gate.autoAction,
    timeoutMs: gate.timeoutMs,
    resumeData: gate.resumeData === undefined ? null : gate.resumeData,
    reason: gate.reason ?? null,
    resumeDataPresent: gate.resumeData !== undefined,
    createdAt: gate.createdAt,
    resolvedAt: gate.resolvedAt ?? null,
  };
}

/**
 * Validates and resolves the list-gates request payload into safe query parameters.
 * @param executionId - Optional execution ID filter from request payload.
 * @param status - Optional status filter from request payload.
 * @param limit - Optional limit from request payload.
 * @param workflowGateInstances - Dialect-resolved table object, supplied by the
 *   caller after resolving from a branded handle via `resolveSchema`.
 * @returns Resolved limit and drizzle predicate expressions.
 */
function resolveListGatesParams(
  executionId: string | undefined,
  status: WorkflowGateInstance['status'] | undefined,
  limit: number | undefined,
  workflowGateInstances: WorkflowGateInstancesTable,
) {
  // Guard: schema refine runs in dev/test but is skipped in production.
  if (executionId === undefined && status === undefined) {
    throw new Error('Either executionId or status is required to list gate instances.');
  }
  const resolvedLimit = limit ?? EXECUTION_LIST_DEFAULT_LIMIT;
  if (
    !Number.isInteger(resolvedLimit) ||
    resolvedLimit < EXECUTION_LIST_MIN_LIMIT ||
    resolvedLimit > EXECUTION_LIST_MAX_LIMIT
  ) {
    throw new Error(
      `Gate instance list limit must be an integer between ${EXECUTION_LIST_MIN_LIMIT} and ${EXECUTION_LIST_MAX_LIMIT}.`,
    );
  }
  const predicates = [
    ...(executionId !== undefined ? [eq(workflowGateInstances.executionId, executionId)] : []),
    ...(status !== undefined ? [eq(workflowGateInstances.status, status)] : []),
  ];
  return { resolvedLimit, predicates };
}

/**
 * Registers all gate instance bus handlers.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerGateInstanceHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { workflowExecutions, workflowGateInstances } = resolveSchema(db, workflowEngineSchema);

  const unsubSetGate = bus.on(WorkflowStorageSubjects.setGateInstance, async (ctx) => {
    const gate = ctx.payload.gate as WorkflowGateInstance;
    if (!isExecutionBoundAccessAllowed(ctx, gate.executionId)) {
      throw new Error(`Unauthorized: caller is not permitted to write gates for execution: ${gate.executionId}`);
    }
    const dbValues = toGateDbValues(gate);
    await serializeDatabaseOperation(db, () =>
      db.insert(workflowGateInstances).values(dbValues).onConflictDoUpdate({
        target: workflowGateInstances.id,
        set: dbValues,
      }),
    );
    ctx.setResult({ id: dbValues.id });
  });

  const unsubResolveWaitingGate = bus.on(WorkflowStorageSubjects.resolveWaitingGateInstance, async (ctx) => {
    const gate = ctx.payload.gate as WorkflowGateInstance;
    const dbValues = toGateDbValues(gate);
    const resolvedRows = await serializeDatabaseOperation(db, () =>
      db
        .update(workflowGateInstances)
        .set(dbValues)
        .where(and(eq(workflowGateInstances.id, dbValues.id), eq(workflowGateInstances.status, 'waiting')))
        .returning({ id: workflowGateInstances.id }),
    );

    ctx.setResult({ accepted: resolvedRows.length === 1 });
  });

  const unsubGetGate = bus.on(WorkflowStorageSubjects.getGateInstance, async (ctx) => {
    const { executionId, nodeId, frameId } = ctx.payload;
    if (!isExecutionBoundAccessAllowed(ctx, executionId)) {
      throw new Error(`Unauthorized: caller is not permitted to read gates for execution: ${executionId}`);
    }
    const predicates = [eq(workflowGateInstances.executionId, executionId), eq(workflowGateInstances.nodeId, nodeId)];
    if (frameId !== undefined) {
      predicates.push(eq(workflowGateInstances.frameId, frameId));
    }
    const rows = await db
      .select()
      .from(workflowGateInstances)
      .where(and(...predicates))
      .limit(1);
    ctx.setResult({ gate: rows[0] ? mapGateInstance(rows[0]) : null });
  });

  const unsubListGates = bus.on(WorkflowStorageSubjects.listGateInstances, async (ctx) => {
    const { executionId, status, limit } = ctx.payload;
    const { resolvedLimit, predicates } = resolveListGatesParams(executionId, status, limit, workflowGateInstances);
    const rows = await db
      .select()
      .from(workflowGateInstances)
      .where(and(...predicates))
      .orderBy(desc(workflowGateInstances.createdAt), desc(workflowGateInstances.id))
      .limit(resolvedLimit);
    ctx.setResult({ gates: rows.map(mapGateInstance) });
  });

  const unsubListPausedGateTimeouts = bus.on(WorkflowStorageSubjects.listPausedGateTimeouts, async (ctx) => {
    const rows = await db
      .select({ gate: workflowGateInstances })
      .from(workflowGateInstances)
      .innerJoin(workflowExecutions, eq(workflowGateInstances.executionId, workflowExecutions.id))
      .where(
        and(
          eq(workflowGateInstances.status, 'waiting'),
          eq(workflowExecutions.status, 'paused'),
          isNotNull(workflowGateInstances.timeoutMs),
        ),
      );
    ctx.setResult({ gates: rows.map((row) => mapGateInstance(row.gate)) });
  });

  return () => {
    unsubSetGate();
    unsubResolveWaitingGate();
    unsubGetGate();
    unsubListGates();
    unsubListPausedGateTimeouts();
  };
}
