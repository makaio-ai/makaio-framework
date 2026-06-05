import { and, eq } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue, WorkflowGateInstance } from '@makaio/contracts';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowGateInstances, type InsertWorkflowGateInstance } from './schema.js';

type DbGateRow = typeof workflowGateInstances.$inferSelect;

/**
 * Maps a database row to the `WorkflowGateInstance` API type.
 * @param row - Database row from `workflow_gate_instances`
 * @returns Mapped `WorkflowGateInstance` with optional fields normalised
 */
function mapGateInstance(row: DbGateRow): WorkflowGateInstance {
  return {
    executionId: row.executionId,
    nodeId: row.nodeId,
    frameId: row.frameId,
    schema: row.schema as WorkflowGateInstance['schema'],
    prompt: row.prompt ?? undefined,
    status: row.status,
    ...(row.resumeDataPresent ? { resumeData: row.resumeData as JsonValue } : {}),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}

/**
 * Maps a `WorkflowGateInstance` to database values for insert/update.
 * @param gate - Gate instance to persist
 * @returns Column values for the `workflow_gate_instances` table
 */
function toGateDbValues(gate: WorkflowGateInstance): InsertWorkflowGateInstance {
  return {
    id: `${gate.executionId}:${gate.nodeId}:${gate.frameId}`,
    executionId: gate.executionId,
    nodeId: gate.nodeId,
    frameId: gate.frameId,
    schema: gate.schema,
    prompt: gate.prompt ?? null,
    status: gate.status,
    resumeData: gate.resumeData === undefined ? null : gate.resumeData,
    resumeDataPresent: gate.resumeData !== undefined,
    createdAt: gate.createdAt,
    resolvedAt: gate.resolvedAt ?? null,
  };
}

/**
 * Registers all gate instance bus handlers (setGateInstance, getGateInstance, listGateInstances).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerGateInstanceHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubSetGate = bus.on(WorkflowStorageSubjects.setGateInstance, async (ctx) => {
    const gate = ctx.payload.gate as WorkflowGateInstance;
    const dbValues = toGateDbValues(gate);
    await db.insert(workflowGateInstances).values(dbValues).onConflictDoUpdate({
      target: workflowGateInstances.id,
      set: dbValues,
    });
    ctx.setResult({ id: dbValues.id });
  });

  const unsubGetGate = bus.on(WorkflowStorageSubjects.getGateInstance, async (ctx) => {
    const { executionId, nodeId, frameId } = ctx.payload;
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
    const rows = await db
      .select()
      .from(workflowGateInstances)
      .where(eq(workflowGateInstances.executionId, ctx.payload.executionId));
    ctx.setResult({ gates: rows.map(mapGateInstance) });
  });

  return () => {
    unsubSetGate();
    unsubGetGate();
    unsubListGates();
  };
}
