import { eq } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue, WorkflowFrameState } from '@makaio/contracts';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowExecutionFrames, type InsertWorkflowExecutionFrame } from './schema.js';

type DbFrameRow = typeof workflowExecutionFrames.$inferSelect;

/**
 * Maps a database row to the `WorkflowFrameState` API type.
 * @param row - Database row from `workflow_execution_frames`
 * @returns Mapped `WorkflowFrameState` with optional fields normalised
 */
function mapFrame(row: DbFrameRow): WorkflowFrameState {
  return {
    frameId: row.frameId,
    nodeId: row.nodeId,
    nodeType: row.nodeType,
    path: row.path,
    parentFrameId: row.parentFrameId ?? undefined,
    status: row.status,
    attempt: row.attempt,
    iteration: row.iteration ?? undefined,
    branchKey: row.branchKey ?? undefined,
    ...(row.outputPresent ? { output: row.output as JsonValue } : {}),
    error: row.error ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

/**
 * Maps a `WorkflowFrameState` and its parent `executionId` to database values.
 * @param executionId - Execution this frame belongs to
 * @param frame - Frame state to persist
 * @returns Column values for the `workflow_execution_frames` table
 */
function toFrameDbValues(executionId: string, frame: WorkflowFrameState): InsertWorkflowExecutionFrame {
  return {
    frameId: frame.frameId,
    executionId,
    nodeId: frame.nodeId,
    nodeType: frame.nodeType,
    path: frame.path,
    parentFrameId: frame.parentFrameId ?? null,
    status: frame.status,
    attempt: frame.attempt,
    iteration: frame.iteration ?? null,
    branchKey: frame.branchKey ?? null,
    output: frame.output === undefined ? null : frame.output,
    outputPresent: frame.output !== undefined,
    error: frame.error ?? null,
    startedAt: frame.startedAt ?? null,
    completedAt: frame.completedAt ?? null,
  };
}

/**
 * Registers all execution frame bus handlers (setFrame, getFrame, listFrames).
 *
 * The `setFrame` handler upserts a frame row identified by `frameId`. The
 * `executionId` must be supplied in the payload so that both frame creation
 * (initial insert) and state transitions (updates) use the same subject.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerFrameHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubSetFrame = bus.on(WorkflowStorageSubjects.setFrame, async (ctx) => {
    const { executionId, frame } = ctx.payload as { executionId: string; frame: WorkflowFrameState };
    const dbValues = toFrameDbValues(executionId, frame);
    await db.insert(workflowExecutionFrames).values(dbValues).onConflictDoUpdate({
      target: workflowExecutionFrames.frameId,
      set: dbValues,
    });
    ctx.setResult({ frameId: frame.frameId });
  });

  const unsubGetFrame = bus.on(WorkflowStorageSubjects.getFrame, async (ctx) => {
    const rows = await db
      .select()
      .from(workflowExecutionFrames)
      .where(eq(workflowExecutionFrames.frameId, ctx.payload.frameId))
      .limit(1);
    ctx.setResult({ frame: rows[0] ? mapFrame(rows[0]) : null });
  });

  const unsubListFrames = bus.on(WorkflowStorageSubjects.listFrames, async (ctx) => {
    const rows = await db
      .select()
      .from(workflowExecutionFrames)
      .where(eq(workflowExecutionFrames.executionId, ctx.payload.executionId));
    ctx.setResult({ frames: rows.map(mapFrame) });
  });

  return () => {
    unsubSetFrame();
    unsubGetFrame();
    unsubListFrames();
  };
}
