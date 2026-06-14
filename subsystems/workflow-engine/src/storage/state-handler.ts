import { eq, and } from 'drizzle-orm';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonPatchOperation, JsonValue } from '@makaio/contracts';
import { createWorkflowStatePatch } from '../workflow-state-json-patch.js';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowEngineSchema } from './schema.variants.js';
import { toWorkflowStateJsonColumnValue } from './state-json-column.js';

/**
 * Initialize workflow state for an execution.
 *
 * Creates the initial state snapshot row with sequence 0 and appends a
 * corresponding entry to the mutation log. If a state row already exists
 * for the given execution, the insert is a no-op (idempotent) to prevent
 * a restart or re-init from overwriting live state.
 * @param db - Database instance.
 * @param executionId - Execution to initialize state for.
 * @param initialValue - Initial state value.
 */
export async function initializeWorkflowState(
  db: MakaioDatabase,
  executionId: string,
  initialValue: JsonValue,
): Promise<void> {
  const { workflowExecutionState, workflowExecutionStateEvents } = resolveSchema(db, workflowEngineSchema);
  const now = Date.now();
  const initialColumnValue = toWorkflowStateJsonColumnValue(db, initialValue);

  await executeTransaction(db, async (tx) => {
    await tx
      .insert(workflowExecutionState)
      .values({
        executionId,
        sequence: 0,
        value: initialColumnValue,
        updatedAt: now,
      })
      .onConflictDoNothing();

    await tx
      .insert(workflowExecutionStateEvents)
      .values({
        executionId,
        sequence: 0,
        patch: [] as JsonPatchOperation[],
        value: initialColumnValue,
        createdAt: now,
      })
      .onConflictDoNothing();
  });
}

/**
 * Get the current state snapshot for an execution.
 * @param db - Database instance.
 * @param executionId - Execution to get state for.
 * @returns Current state with sequence number, or null if no state exists.
 */
export async function getWorkflowState(
  db: MakaioDatabase,
  executionId: string,
): Promise<{ executionId: string; sequence: number; value: JsonValue } | null> {
  const { workflowExecutionState } = resolveSchema(db, workflowEngineSchema);

  const rows = await db
    .select()
    .from(workflowExecutionState)
    .where(eq(workflowExecutionState.executionId, executionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    executionId: row.executionId,
    sequence: row.sequence,
    value: row.value,
  };
}

/**
 * Apply a state mutation with optimistic concurrency control.
 *
 * Atomically updates the snapshot and appends a mutation log entry. The
 * persisted patch is derived from the stored current value and accepted next
 * value so the append-only event log always reflects the actual snapshot
 * transition.
 * Throws when the current sequence does not match `expectedSequence`.
 * @param db - Database instance
 * @param params - Patch parameters including executionId, expectedSequence, and nextValue
 * @returns The new state with updated sequence number.
 * @throws Error with message containing 'state sequence conflict' when expectedSequence doesn't match.
 * @throws Error when no state exists for the given execution.
 */
export async function patchWorkflowState(
  db: MakaioDatabase,
  params: {
    executionId: string;
    expectedSequence: number;
    nextValue: JsonValue;
  },
): Promise<{ executionId: string; sequence: number; patch: JsonPatchOperation[]; value: JsonValue }> {
  const { workflowExecutionState, workflowExecutionStateEvents } = resolveSchema(db, workflowEngineSchema);
  const now = Date.now();
  const nextColumnValue = toWorkflowStateJsonColumnValue(db, params.nextValue);

  return executeTransaction(db, async (tx) => {
    // 1. Read current sequence to compute the next value
    const rows = await tx
      .select()
      .from(workflowExecutionState)
      .where(eq(workflowExecutionState.executionId, params.executionId))
      .limit(1);

    const current = rows[0];
    if (!current) {
      throw new Error(`no workflow state for execution ${params.executionId}`);
    }
    if (params.expectedSequence === undefined) {
      throw new Error('expectedSequence is required to patch workflow state');
    }

    // 2. Increment sequence
    const nextSequence = current.sequence + 1;
    const persistedPatch = createWorkflowStatePatch(current.value, params.nextValue);

    // 3. Atomic compare-and-set: include the expected sequence in the
    //    UPDATE WHERE clause so the write fails atomically if another
    //    mutation sneaked in between our read and our write.
    const updateResult = await tx
      .update(workflowExecutionState)
      .set({
        sequence: nextSequence,
        value: nextColumnValue,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowExecutionState.executionId, params.executionId),
          eq(workflowExecutionState.sequence, params.expectedSequence),
        ),
      )
      .returning();

    if (updateResult.length === 0) {
      throw new Error(
        `state sequence conflict: expected ${String(params.expectedSequence)}, got ${String(current.sequence)}`,
      );
    }

    // 4. Insert into the mutation log
    await tx.insert(workflowExecutionStateEvents).values({
      executionId: params.executionId,
      sequence: nextSequence,
      patch: persistedPatch,
      value: nextColumnValue,
      createdAt: now,
    });

    return {
      executionId: params.executionId,
      sequence: nextSequence,
      patch: persistedPatch,
      value: params.nextValue,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// Handler registration
// ─────────────────────────────────────────────────────────────

/**
 * Register storage handlers for execution state subjects.
 *
 * Wires `initializeState`, `getState`, and `patchState` storage subjects
 * to the underlying database functions.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerStateHandlers(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubInitialize = bus.on(WorkflowStorageSubjects.initializeState, async (ctx) => {
    const { executionId, initialValue } = ctx.payload;
    await initializeWorkflowState(db, executionId, initialValue as JsonValue);
    ctx.setResult({});
  });

  const unsubGet = bus.on(WorkflowStorageSubjects.getState, async (ctx) => {
    const { executionId } = ctx.payload;
    const state = await getWorkflowState(db, executionId);
    ctx.setResult({ state });
  });

  const unsubPatch = bus.on(WorkflowStorageSubjects.patchState, async (ctx) => {
    const { executionId, expectedSequence, nextValue } = ctx.payload;
    const result = await patchWorkflowState(db, {
      executionId,
      expectedSequence,
      nextValue: nextValue as JsonValue,
    });
    ctx.setResult(result);
  });

  return () => {
    unsubInitialize();
    unsubGet();
    unsubPatch();
  };
}
