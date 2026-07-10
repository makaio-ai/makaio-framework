import { and, eq, isNull } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  EXTERNAL_EXECUTION_ID_PREFIX,
  WorkflowStepTypeSchema,
  type WorkLogFrameEntry,
  type WorkflowExecution,
} from '@makaio/contracts';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type {
  InsertWorklogSummary,
  InsertWorkflowExecution,
  SelectWorkflowExecution,
  SelectWorklogFrameEntry,
  SelectWorklogSummary,
} from './schema.js';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowEngineSchema } from './schema.variants.js';
import { jsonValuesEqual, toFrameDbValues, type ExecutionDbValueMapper } from './external-execution-values.js';
import {
  assertMatchingFrameIdentity,
  assertMatchingSettlement,
  assertOrAdoptSettlementFingerprint,
  buildExternalSettlementFingerprint,
  buildTerminalFrameValues,
  buildTerminalSummaryValues,
  loadSettlementFrame,
  type ExternalSettlement,
  type TerminalWorklogFrame,
  type WorkflowStorageTransaction,
} from './external-execution-settlement.js';
import { emitWorklogChanged } from '../worklog/worklog-projection-helpers.js';

type RunningWorklogFrame = WorkLogFrameEntry & { status: 'running'; startedAt: number };
type TerminalWorklogTables = Pick<typeof workflowEngineSchema.sqlite, 'worklogSummaries' | 'worklogFrameEntries'>;

interface ResolvedTerminalWorklogFrame {
  readonly frame: TerminalWorklogFrame;
  readonly existing: SelectWorklogFrameEntry | undefined;
}

/**
 * Assert that an existing row represents an identical external registration.
 * @param existing - Durable execution row.
 * @param expected - Execution row derived from the replayed request.
 */
function assertMatchingRegistration(existing: SelectWorkflowExecution, expected: InsertWorkflowExecution): void {
  const matches =
    existing.id === expected.id &&
    existing.workflowId === expected.workflowId &&
    existing.coordinatorSessionId === expected.coordinatorSessionId &&
    existing.completedAt === expected.completedAt &&
    existing.error === expected.error &&
    existing.reason === expected.reason &&
    existing.startedAt === expected.startedAt &&
    existing.externalSettlementFingerprint === (expected.externalSettlementFingerprint ?? null) &&
    existing.scopeType === expected.scopeType &&
    existing.scopeKind === expected.scopeKind &&
    existing.scopeId === expected.scopeId &&
    existing.artifactKind === expected.artifactKind &&
    existing.artifactId === expected.artifactId &&
    jsonValuesEqual(existing.inputs, expected.inputs) &&
    jsonValuesEqual(existing.triggerPayload, expected.triggerPayload);
  if (!matches) {
    throw new Error(`setExternalExecutionStart: registration conflicts for execution "${expected.id}"`);
  }
  if (existing.status !== 'running') {
    throw new Error(
      `setExternalExecutionStart: execution "${expected.id}" cannot be registered from status "${existing.status}"`,
    );
  }
}

/**
 * Assert that an initial WorkLog summary retains the registration identity.
 * @param existing - Durable WorkLog summary.
 * @param expected - Summary derived from the replayed request.
 */
function assertMatchingStartSummary(existing: SelectWorklogSummary, expected: InsertWorklogSummary): void {
  if (
    existing.workflowId !== expected.workflowId ||
    existing.startedAt !== expected.startedAt ||
    existing.executionId !== expected.executionId ||
    existing.status !== 'running' ||
    existing.completedAt !== null ||
    existing.durationMs !== null ||
    existing.error !== null ||
    existing.failedNodeId !== null
  ) {
    throw new Error(`setExternalExecutionStart: WorkLog summary conflicts for execution "${expected.executionId}"`);
  }
}

/**
 * Assert that an initial WorkLog frame retains the registration identity.
 * @param existing - Durable WorkLog frame row.
 * @param expected - Frame derived from the replayed request.
 */
function assertMatchingStartFrame(existing: SelectWorklogFrameEntry, expected: RunningWorklogFrame): void {
  if (
    existing.executionId !== expected.executionId ||
    existing.nodeId !== expected.nodeId ||
    existing.nodeType !== expected.nodeType ||
    !jsonValuesEqual(existing.path, expected.path) ||
    existing.attempt !== expected.attempt ||
    existing.iteration !== (expected.iteration ?? null) ||
    existing.branchKey !== (expected.branchKey ?? null) ||
    existing.startedAt !== expected.startedAt ||
    existing.status !== 'running' ||
    existing.completedAt !== null ||
    existing.durationMs !== null ||
    existing.error !== null
  ) {
    throw new Error(`setExternalExecutionStart: WorkLog frame conflicts for frame "${expected.frameId}"`);
  }
}

/**
 * Persist an external execution and its initial WorkLog projection atomically.
 * @param db - Database handle.
 * @param execution - Running external execution.
 * @param frame - Optional running WorkLog frame.
 * @param mapExecution - Public-to-storage execution mapper.
 */
async function setExternalExecutionStart(
  db: MakaioDatabase,
  execution: WorkflowExecution & { status: 'running' },
  frame: RunningWorklogFrame | undefined,
  mapExecution: ExecutionDbValueMapper,
): Promise<void> {
  if (!execution.id.startsWith(EXTERNAL_EXECUTION_ID_PREFIX)) {
    throw new Error(`setExternalExecutionStart: execution "${execution.id}" is not an external execution ID`);
  }
  if (frame !== undefined && frame.executionId !== execution.id) {
    throw new Error('setExternalExecutionStart requires frame.executionId to match execution.id');
  }

  const { workflowExecutions, worklogSummaries, worklogFrameEntries } = resolveSchema(db, workflowEngineSchema);
  const executionValues = mapExecution(execution);
  const summaryValues: InsertWorklogSummary = {
    executionId: execution.id,
    workflowId: execution.workflowId,
    workflowName: null,
    status: 'running',
    startedAt: execution.startedAt,
    completedAt: null,
    durationMs: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    totalEstimatedCost: null,
    error: null,
    failedNodeId: null,
  };

  await executeTransaction(db, async (tx) => {
    const inserted = await tx
      .insert(workflowExecutions)
      .values(executionValues)
      .onConflictDoNothing()
      .returning({ id: workflowExecutions.id });
    const replayed = inserted.length === 0;
    if (replayed) {
      const [existing] = await tx
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, execution.id))
        .limit(1);
      if (existing === undefined) throw new Error(`setExternalExecutionStart: execution "${execution.id}" disappeared`);
      assertMatchingRegistration(existing, executionValues);
    }

    // The execution primary-key insert is the registration synchronization
    // point. A concurrent PostgreSQL transaction cannot observe `replayed`
    // until the winner has committed all secondary WorkLog rows; per-handle
    // transactions provide the equivalent serialization for SQLite.

    const [existingSummary] = await tx
      .select()
      .from(worklogSummaries)
      .where(eq(worklogSummaries.executionId, execution.id))
      .limit(1);
    if (existingSummary === undefined) {
      await tx.insert(worklogSummaries).values(summaryValues);
    } else {
      assertMatchingStartSummary(existingSummary, summaryValues);
    }

    const existingExecutionFrames = replayed
      ? await tx.select().from(worklogFrameEntries).where(eq(worklogFrameEntries.executionId, execution.id))
      : [];
    if (frame === undefined && existingExecutionFrames.length > 0) {
      throw new Error(`setExternalExecutionStart: frame metadata conflicts for execution "${execution.id}"`);
    }
    if (frame !== undefined) {
      if (replayed && existingExecutionFrames.length === 0) {
        throw new Error(`setExternalExecutionStart: frame metadata conflicts for execution "${execution.id}"`);
      }
      if (existingExecutionFrames.some((entry) => entry.frameId !== frame.frameId)) {
        throw new Error(`setExternalExecutionStart: frame metadata conflicts for execution "${execution.id}"`);
      }
      const [existingFrame] = await tx
        .select()
        .from(worklogFrameEntries)
        .where(eq(worklogFrameEntries.frameId, frame.frameId))
        .limit(1);
      if (existingFrame === undefined) {
        await tx.insert(worklogFrameEntries).values(toFrameDbValues(frame));
      } else {
        assertMatchingStartFrame(existingFrame, frame);
      }
    }
  });
}

/**
 * Resolve the terminal WorkLog frame for an external settlement.
 *
 * A caller may omit terminal frame metadata after atomically registering one
 * running frame. In that case the sole running row is authoritative enough to
 * finish without making its metadata part of the settlement fingerprint.
 * Multiple running rows are ambiguous and require an exact framed settlement.
 * @param tx - Active storage transaction.
 * @param worklogFrameEntries - Dialect-resolved WorkLog frame table.
 * @param execution - Durable external execution row.
 * @param settlement - Requested terminal settlement.
 * @param completedAt - Resolved terminal timestamp.
 * @returns Exact terminal frame values and their existing row, when one is resolvable.
 */
async function resolveTerminalWorklogFrame(
  tx: WorkflowStorageTransaction,
  worklogFrameEntries: TerminalWorklogTables['worklogFrameEntries'],
  execution: SelectWorkflowExecution,
  settlement: ExternalSettlement,
  completedAt: number,
): Promise<ResolvedTerminalWorklogFrame | undefined> {
  if (settlement.frame !== undefined) {
    const existing = await loadSettlementFrame(
      tx,
      worklogFrameEntries,
      settlement as ExternalSettlement & { frame: TerminalWorklogFrame },
    );
    if (existing !== undefined) assertMatchingFrameIdentity(existing, settlement.frame);
    return { frame: settlement.frame, existing };
  }

  const runningFrames = (
    await tx.select().from(worklogFrameEntries).where(eq(worklogFrameEntries.executionId, execution.id))
  ).filter((frame) => frame.status === 'running');
  if (runningFrames.length > 1) {
    throw new Error(
      `settleExternalExecution: frame-less settlement for execution "${execution.id}" is ambiguous across multiple running frames`,
    );
  }
  const [existing] = runningFrames;
  if (existing === undefined) return undefined;
  if (existing.startedAt === null) {
    throw new Error(`settleExternalExecution: running frame "${existing.frameId}" has no start timestamp`);
  }
  if (completedAt < existing.startedAt) {
    throw new Error('settleExternalExecution: completedAt must not precede the registered frame start timestamp');
  }
  const nodeType = WorkflowStepTypeSchema.parse(existing.nodeType);

  const frame: TerminalWorklogFrame = {
    executionId: existing.executionId,
    frameId: existing.frameId,
    nodeId: existing.nodeId,
    nodeType,
    path: existing.path,
    status: settlement.status,
    attempt: existing.attempt,
    ...(existing.iteration !== null ? { iteration: existing.iteration } : {}),
    ...(existing.branchKey !== null ? { branchKey: existing.branchKey } : {}),
    startedAt: existing.startedAt,
    completedAt,
    durationMs: completedAt - existing.startedAt,
    ...(settlement.status === 'failed' && settlement.error !== undefined ? { error: settlement.error } : {}),
  };
  return { frame, existing };
}

/**
 * Write the authoritative terminal WorkLog summary and optional frame.
 * @param tx - Active storage transaction.
 * @param tables - Dialect-resolved WorkLog tables from the branded root handle.
 * @param execution - Durable execution row.
 * @param settlement - Requested terminal settlement.
 * @param completedAt - Resolved terminal timestamp.
 */
async function writeTerminalWorklog(
  tx: WorkflowStorageTransaction,
  tables: TerminalWorklogTables,
  execution: SelectWorkflowExecution,
  settlement: ExternalSettlement,
  completedAt: number,
): Promise<void> {
  const { worklogSummaries, worklogFrameEntries } = tables;
  const resolvedFrame = await resolveTerminalWorklogFrame(tx, worklogFrameEntries, execution, settlement, completedAt);
  const worklogSettlement = resolvedFrame === undefined ? settlement : { ...settlement, frame: resolvedFrame.frame };
  const [existingSummary] = await tx
    .select()
    .from(worklogSummaries)
    .where(eq(worklogSummaries.executionId, execution.id))
    .limit(1);
  const summaryValues = buildTerminalSummaryValues(execution, existingSummary, worklogSettlement, completedAt);
  await tx.insert(worklogSummaries).values(summaryValues).onConflictDoUpdate({
    target: worklogSummaries.executionId,
    set: summaryValues,
  });

  if (resolvedFrame !== undefined) {
    const frameValues = buildTerminalFrameValues(resolvedFrame.frame, resolvedFrame.existing);
    await tx.insert(worklogFrameEntries).values(frameValues).onConflictDoUpdate({
      target: worklogFrameEntries.frameId,
      set: frameValues,
    });
  }
}

/**
 * Settle an external execution and its WorkLog rows in one idempotent transaction.
 * @param db - Database handle.
 * @param settlement - Requested terminal settlement.
 * @returns Whether the settlement is durably acknowledged.
 */
async function settleExternalExecution(db: MakaioDatabase, settlement: ExternalSettlement): Promise<boolean> {
  if (!settlement.executionId.startsWith(EXTERNAL_EXECUTION_ID_PREFIX)) {
    throw new Error(
      `settleExternalExecution: execution "${settlement.executionId}" is engine-owned and must use the engine finalizer`,
    );
  }
  if (settlement.frame !== undefined && settlement.frame.executionId !== settlement.executionId) {
    throw new Error('settleExternalExecution requires frame.executionId to match executionId');
  }

  // Resolve the dialect-correct tables from the branded root handle. Drizzle
  // transaction objects do not carry Makaio's dialect brand, so resolving from
  // `tx` would silently select the SQLite variants for PostgreSQL transactions.
  const { workflowExecutions, worklogSummaries, worklogFrameEntries } = resolveSchema(db, workflowEngineSchema);
  return executeTransaction(db, async (tx) => {
    const [execution] = await tx
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, settlement.executionId))
      .limit(1);
    if (execution === undefined) {
      throw new Error(`settleExternalExecution: execution "${settlement.executionId}" was not registered`);
    }

    let completedAt = settlement.completedAt ?? execution.completedAt ?? Date.now();
    if (execution.status === 'running') {
      const settlementFingerprint = buildExternalSettlementFingerprint(settlement, completedAt);
      const updated = await tx
        .update(workflowExecutions)
        .set({
          status: settlement.status,
          completedAt,
          error: settlement.status === 'failed' ? (settlement.error ?? null) : null,
          reason: settlement.status === 'cancelled' ? (settlement.reason ?? null) : null,
          externalSettlementFingerprint: settlementFingerprint,
        })
        .where(
          and(
            eq(workflowExecutions.id, settlement.executionId),
            eq(workflowExecutions.status, 'running'),
            isNull(workflowExecutions.externalSettlementFingerprint),
          ),
        )
        .returning({ id: workflowExecutions.id });
      if (updated.length === 0) {
        const [current] = await tx
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, settlement.executionId))
          .limit(1);
        if (current === undefined) {
          throw new Error(`settleExternalExecution: execution "${settlement.executionId}" disappeared`);
        }
        if (settlement.completedAt === undefined && current.completedAt !== null) {
          completedAt = current.completedAt;
        }
        assertMatchingSettlement(current, settlement, completedAt);
        await assertOrAdoptSettlementFingerprint(tx, workflowExecutions, current, settlement, completedAt);
      }
    } else {
      assertMatchingSettlement(execution, settlement, completedAt);
      await assertOrAdoptSettlementFingerprint(tx, workflowExecutions, execution, settlement, completedAt);
    }

    await writeTerminalWorklog(tx, { worklogSummaries, worklogFrameEntries }, execution, settlement, completedAt);
    return true;
  });
}

/**
 * Register atomic external-execution storage handlers.
 * @param bus - Message bus used for local storage subjects.
 * @param db - Database handle.
 * @param mapExecution - Public-to-storage execution mapper.
 * @returns Cleanup function for registered handlers.
 */
export function registerExternalExecutionStorageHandlers(
  bus: IMakaioBus,
  db: MakaioDatabase,
  mapExecution: ExecutionDbValueMapper,
): () => void {
  const unsubscribeStart = bus.on(WorkflowStorageSubjects.setExternalExecutionStart, async (ctx) => {
    const execution = ctx.payload.execution as WorkflowExecution & { status: 'running' };
    const frame = ctx.payload.frame as RunningWorklogFrame | undefined;
    await setExternalExecutionStart(db, execution, frame, mapExecution);
    // Emit exactly once after the transaction has committed. WorkLog change
    // events are advisory invalidations and intentionally include replays,
    // matching the existing lifecycle projection semantics.
    await emitWorklogChanged(bus, execution.id);
    ctx.setResult({ executionId: execution.id, ...(frame !== undefined ? { frameId: frame.frameId } : {}) });
  });
  const unsubscribeSettlement = bus.on(WorkflowStorageSubjects.settleExternalExecution, async (ctx) => {
    const success = await settleExternalExecution(db, ctx.payload as ExternalSettlement);
    await emitWorklogChanged(bus, ctx.payload.executionId);
    ctx.setResult({ success });
  });
  return () => {
    unsubscribeStart();
    unsubscribeSettlement();
  };
}
