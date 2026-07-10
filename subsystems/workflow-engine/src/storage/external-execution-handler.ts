import { and, eq } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import { EXTERNAL_EXECUTION_ID_PREFIX, type WorkLogFrameEntry, type WorkflowExecution } from '@makaio/contracts';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type {
  InsertWorklogFrameEntry,
  InsertWorklogSummary,
  SelectWorkflowExecution,
  SelectWorklogFrameEntry,
  SelectWorklogSummary,
} from './schema.js';
import { WorkflowStorageSubjects } from './namespace.js';
import { workflowEngineSchema } from './schema.variants.js';
import { jsonValuesEqual, toFrameDbValues, type ExecutionDbValueMapper } from './external-execution-values.js';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';
type RunningWorklogFrame = WorkLogFrameEntry & { status: 'running'; startedAt: number };
type TerminalWorklogFrame = WorkLogFrameEntry & {
  status: TerminalStatus;
  startedAt: number;
  completedAt: number;
  durationMs: number;
};

interface ExternalSettlement {
  readonly executionId: string;
  readonly status: TerminalStatus;
  readonly error?: string;
  readonly reason?: string;
  readonly completedAt?: number;
  readonly frame?: TerminalWorklogFrame;
}

/**
 * Assert that an existing row represents an identical external registration.
 * @param existing - Durable execution row.
 * @param expected - Execution row derived from the replayed request.
 */
function assertMatchingRegistration(existing: SelectWorkflowExecution, expected: SelectWorkflowExecution): void {
  const matches =
    existing.id === expected.id &&
    existing.workflowId === expected.workflowId &&
    existing.coordinatorSessionId === expected.coordinatorSessionId &&
    existing.completedAt === expected.completedAt &&
    existing.error === expected.error &&
    existing.reason === expected.reason &&
    existing.startedAt === expected.startedAt &&
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
 * Assert that settlement does not mutate immutable frame identity metadata.
 * @param existing - Durable WorkLog frame row.
 * @param expected - Terminal frame supplied by the settlement.
 */
function assertMatchingFrameIdentity(existing: SelectWorklogFrameEntry, expected: TerminalWorklogFrame): void {
  if (
    existing.executionId !== expected.executionId ||
    existing.nodeId !== expected.nodeId ||
    existing.nodeType !== expected.nodeType ||
    !jsonValuesEqual(existing.path, expected.path) ||
    existing.attempt !== expected.attempt ||
    existing.iteration !== (expected.iteration ?? null) ||
    existing.branchKey !== (expected.branchKey ?? null) ||
    existing.startedAt !== expected.startedAt
  ) {
    throw new Error(`settleExternalExecution: frame "${expected.frameId}" conflicts with its registered metadata`);
  }
}

/**
 * Assert that a terminal execution row is an identical completion replay.
 * @param execution - Durable execution row.
 * @param settlement - Requested terminal settlement.
 * @param completedAt - Resolved terminal timestamp.
 */
function assertMatchingSettlement(
  execution: SelectWorkflowExecution,
  settlement: ExternalSettlement,
  completedAt: number,
): void {
  const expectedError = settlement.status === 'failed' ? (settlement.error ?? null) : null;
  const expectedReason = settlement.status === 'cancelled' ? (settlement.reason ?? null) : null;
  if (
    execution.status !== settlement.status ||
    execution.completedAt !== completedAt ||
    execution.error !== expectedError ||
    execution.reason !== expectedReason
  ) {
    if (execution.status !== settlement.status) {
      throw new Error(
        `settleExternalExecution: execution "${settlement.executionId}" cannot transition from status "${execution.status}"`,
      );
    }
    throw new Error(
      `settleExternalExecution: execution "${settlement.executionId}" conflicts with an existing terminal settlement`,
    );
  }
}

/**
 * Load the only frame compatible with an external settlement.
 * @param tx - Active storage transaction.
 * @param settlement - Settlement carrying exact frame metadata.
 * @returns Existing matching frame, or `undefined` when none is stored.
 */
async function loadSettlementFrame(
  tx: Parameters<Parameters<typeof executeTransaction>[1]>[0],
  settlement: ExternalSettlement & { frame: TerminalWorklogFrame },
): Promise<SelectWorklogFrameEntry | undefined> {
  const { worklogFrameEntries } = resolveSchema(tx, workflowEngineSchema);
  const executionFrames = await tx
    .select()
    .from(worklogFrameEntries)
    .where(eq(worklogFrameEntries.executionId, settlement.executionId));
  if (executionFrames.some((frame) => frame.frameId !== settlement.frame.frameId)) {
    throw new Error(
      `settleExternalExecution: frame "${settlement.frame.frameId}" conflicts with the registered frame identity`,
    );
  }
  const matchingFrame = executionFrames.find((frame) => frame.frameId === settlement.frame.frameId);
  if (matchingFrame !== undefined) return matchingFrame;
  const [collidingFrame] = await tx
    .select()
    .from(worklogFrameEntries)
    .where(eq(worklogFrameEntries.frameId, settlement.frame.frameId))
    .limit(1);
  if (collidingFrame !== undefined) {
    throw new Error(`settleExternalExecution: frame "${settlement.frame.frameId}" belongs to another execution`);
  }
  return undefined;
}

/**
 * Reject a terminal replay whose frame metadata differs from the durable settlement.
 * @param tx - Active storage transaction.
 * @param settlement - Replayed settlement request.
 */
async function assertMatchingTerminalFrame(
  tx: Parameters<Parameters<typeof executeTransaction>[1]>[0],
  settlement: ExternalSettlement,
): Promise<void> {
  if (settlement.frame === undefined) return;
  const existing = await loadSettlementFrame(tx, settlement as ExternalSettlement & { frame: TerminalWorklogFrame });
  if (existing === undefined) return;
  assertMatchingFrameIdentity(existing, settlement.frame);
  const expected = toFrameDbValues(settlement.frame);
  const matches =
    existing.executionId === expected.executionId &&
    existing.nodeId === expected.nodeId &&
    existing.nodeType === expected.nodeType &&
    jsonValuesEqual(existing.path, expected.path) &&
    existing.status === expected.status &&
    existing.attempt === expected.attempt &&
    existing.iteration === expected.iteration &&
    existing.branchKey === expected.branchKey &&
    existing.startedAt === expected.startedAt &&
    existing.completedAt === expected.completedAt &&
    existing.durationMs === expected.durationMs &&
    existing.error === expected.error;
  if (!matches) {
    throw new Error(
      `settleExternalExecution: frame "${settlement.frame.frameId}" conflicts with an existing terminal settlement`,
    );
  }
}

/**
 * Build the authoritative terminal WorkLog summary values.
 * @param execution - Durable execution row.
 * @param existing - Existing WorkLog summary, when present.
 * @param settlement - Requested terminal settlement.
 * @param completedAt - Resolved terminal timestamp.
 * @returns WorkLog summary database values.
 */
function buildTerminalSummaryValues(
  execution: SelectWorkflowExecution,
  existing: SelectWorklogSummary | undefined,
  settlement: ExternalSettlement,
  completedAt: number,
): InsertWorklogSummary {
  const recordedStartedAt = settlement.frame?.startedAt ?? existing?.startedAt ?? execution.startedAt;
  // Exact frame settlements are validated by contract. Frame-less legacy
  // calls use a zero-duration lower bound for inconsistent historical clocks.
  const startedAt = settlement.frame === undefined ? Math.min(recordedStartedAt, completedAt) : recordedStartedAt;
  if (completedAt < startedAt) {
    throw new Error('settleExternalExecution: completedAt must not precede the WorkLog start timestamp');
  }
  return {
    executionId: execution.id,
    workflowId: execution.workflowId,
    workflowName: existing?.workflowName ?? null,
    status: settlement.status,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    totalInputTokens: existing?.totalInputTokens ?? null,
    totalOutputTokens: existing?.totalOutputTokens ?? null,
    totalEstimatedCost: existing?.totalEstimatedCost ?? null,
    error: settlement.status === 'failed' ? (settlement.error ?? null) : null,
    failedNodeId: settlement.status === 'failed' ? (settlement.frame?.nodeId ?? null) : null,
  };
}

/**
 * Preserve usage measurements while applying authoritative terminal frame fields.
 * @param frame - Requested terminal frame.
 * @param existing - Existing projected frame, when present.
 * @returns WorkLog frame database values.
 */
function buildTerminalFrameValues(
  frame: TerminalWorklogFrame,
  existing: SelectWorklogFrameEntry | undefined,
): InsertWorklogFrameEntry {
  return toFrameDbValues({
    ...frame,
    inputTokens: frame.inputTokens ?? existing?.inputTokens ?? undefined,
    outputTokens: frame.outputTokens ?? existing?.outputTokens ?? undefined,
    estimatedCost: frame.estimatedCost ?? existing?.estimatedCost ?? undefined,
  });
}

/**
 * Write the authoritative terminal WorkLog summary and optional frame.
 * @param tx - Active storage transaction.
 * @param execution - Durable execution row.
 * @param settlement - Requested terminal settlement.
 * @param completedAt - Resolved terminal timestamp.
 */
async function writeTerminalWorklog(
  tx: Parameters<Parameters<typeof executeTransaction>[1]>[0],
  execution: SelectWorkflowExecution,
  settlement: ExternalSettlement,
  completedAt: number,
): Promise<void> {
  const { worklogSummaries, worklogFrameEntries } = resolveSchema(tx, workflowEngineSchema);
  const [existingSummary] = await tx
    .select()
    .from(worklogSummaries)
    .where(eq(worklogSummaries.executionId, execution.id))
    .limit(1);
  const summaryValues = buildTerminalSummaryValues(execution, existingSummary, settlement, completedAt);
  await tx.insert(worklogSummaries).values(summaryValues).onConflictDoUpdate({
    target: worklogSummaries.executionId,
    set: summaryValues,
  });

  if (settlement.frame !== undefined) {
    const existingFrame = await loadSettlementFrame(
      tx,
      settlement as ExternalSettlement & { frame: TerminalWorklogFrame },
    );
    if (existingFrame !== undefined) assertMatchingFrameIdentity(existingFrame, settlement.frame);
    const frameValues = buildTerminalFrameValues(settlement.frame, existingFrame);
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

  const { workflowExecutions } = resolveSchema(db, workflowEngineSchema);
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
    let terminalReplay = execution.status !== 'running';
    if (execution.status === 'running') {
      const updated = await tx
        .update(workflowExecutions)
        .set({
          status: settlement.status,
          completedAt,
          error: settlement.status === 'failed' ? (settlement.error ?? null) : null,
          reason: settlement.status === 'cancelled' ? (settlement.reason ?? null) : null,
        })
        .where(and(eq(workflowExecutions.id, settlement.executionId), eq(workflowExecutions.status, 'running')))
        .returning({ id: workflowExecutions.id });
      if (updated.length === 0) {
        terminalReplay = true;
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
      }
    } else {
      assertMatchingSettlement(execution, settlement, completedAt);
    }

    if (terminalReplay) await assertMatchingTerminalFrame(tx, settlement);
    await writeTerminalWorklog(tx, execution, settlement, completedAt);
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
    ctx.setResult({ executionId: execution.id, ...(frame !== undefined ? { frameId: frame.frameId } : {}) });
  });
  const unsubscribeSettlement = bus.on(WorkflowStorageSubjects.settleExternalExecution, async (ctx) => {
    const success = await settleExternalExecution(db, ctx.payload as ExternalSettlement);
    ctx.setResult({ success });
  });
  return () => {
    unsubscribeStart();
    unsubscribeSettlement();
  };
}
