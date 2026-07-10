import { and, eq, isNull } from 'drizzle-orm';
import type { WorkLogFrameEntry } from '@makaio/contracts';
import { executeTransaction } from '@makaio/storage-drizzle';
import type {
  InsertWorklogFrameEntry,
  InsertWorklogSummary,
  SelectWorkflowExecution,
  SelectWorklogFrameEntry,
  SelectWorklogSummary,
} from './schema.js';
import { workflowEngineSchema } from './schema.variants.js';
import { jsonValuesEqual, toFrameDbValues } from './external-execution-values.js';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

/** Exact terminal WorkLog frame accepted by the external lifecycle storage seam. */
export type TerminalWorklogFrame = WorkLogFrameEntry & {
  status: TerminalStatus;
  startedAt: number;
  completedAt: number;
  durationMs: number;
};

/** Authoritative settlement values passed from the public handler to storage. */
export interface ExternalSettlement {
  readonly executionId: string;
  readonly status: TerminalStatus;
  readonly error?: string;
  readonly reason?: string;
  readonly completedAt?: number;
  readonly frame?: TerminalWorklogFrame;
}

export type WorkflowStorageTransaction = Parameters<Parameters<typeof executeTransaction>[1]>[0];
export type WorklogFrameEntriesTable = typeof workflowEngineSchema.sqlite.worklogFrameEntries;
export type WorkflowExecutionsTable = typeof workflowEngineSchema.sqlite.workflowExecutions;

/**
 * Build the canonical durable identity of an external settlement.
 *
 * Usage totals are intentionally absent: projections may enrich those values
 * after settlement, while lifecycle and frame identity must remain immutable.
 * @param settlement - Requested terminal settlement.
 * @param completedAt - Transactionally resolved completion timestamp.
 * @returns Stable JSON fingerprint suitable for exact durable comparison.
 */
export function buildExternalSettlementFingerprint(settlement: ExternalSettlement, completedAt: number): string {
  const frame = settlement.frame;
  if (frame !== undefined) {
    const expectedError = settlement.status === 'failed' ? (settlement.error ?? null) : null;
    if (frame.executionId !== settlement.executionId) {
      throw new Error('settleExternalExecution requires frame.executionId to match executionId');
    }
    if (frame.status !== settlement.status) {
      throw new Error('settleExternalExecution requires frame.status to match status');
    }
    if (frame.completedAt !== completedAt) {
      throw new Error('settleExternalExecution requires frame.completedAt to match completedAt');
    }
    if (frame.durationMs !== completedAt - frame.startedAt) {
      throw new Error('settleExternalExecution requires frame.durationMs to match its timestamps');
    }
    if ((frame.error ?? null) !== expectedError) {
      throw new Error('settleExternalExecution requires frame.error to match terminal error metadata');
    }
  }
  return JSON.stringify({
    version: 1,
    status: settlement.status,
    completedAt,
    error: settlement.status === 'failed' ? (settlement.error ?? null) : null,
    reason: settlement.status === 'cancelled' ? (settlement.reason ?? null) : null,
    frame:
      frame === undefined
        ? null
        : {
            executionId: frame.executionId,
            frameId: frame.frameId,
            nodeId: frame.nodeId,
            nodeType: frame.nodeType,
            path: frame.path,
            status: frame.status,
            attempt: frame.attempt,
            iteration: frame.iteration ?? null,
            branchKey: frame.branchKey ?? null,
            startedAt: frame.startedAt,
            completedAt: frame.completedAt,
            durationMs: frame.durationMs,
            error: frame.status === 'failed' ? (frame.error ?? null) : null,
          },
  });
}

/**
 * Assert that a replay has the durable identity chosen by the first settlement.
 * @param existing - Persisted canonical settlement fingerprint.
 * @param expected - Canonical fingerprint derived from the replay request.
 * @param executionId - Execution identifier for the conflict message.
 */
export function assertMatchingSettlementFingerprint(existing: string, expected: string, executionId: string): void {
  if (existing !== expected) {
    throw new Error(
      `settleExternalExecution: execution "${executionId}" conflicts with an existing terminal settlement fingerprint`,
    );
  }
}

/**
 * Validate a durable settlement fingerprint or adopt one for a migrated legacy row.
 *
 * Rows created by the pre-fingerprint API are interpreted as frame-less. The
 * conditional update includes the complete terminal identity so adoption
 * cannot race with a metadata change or another replay.
 * @param tx - Active storage transaction.
 * @param workflowExecutions - Dialect-resolved workflow execution table.
 * @param execution - Durable terminal execution row.
 * @param settlement - Replayed terminal settlement.
 * @param completedAt - Resolved terminal timestamp.
 */
export async function assertOrAdoptSettlementFingerprint(
  tx: WorkflowStorageTransaction,
  workflowExecutions: WorkflowExecutionsTable,
  execution: SelectWorkflowExecution,
  settlement: ExternalSettlement,
  completedAt: number,
): Promise<void> {
  const expectedFingerprint = buildExternalSettlementFingerprint(settlement, completedAt);
  if (execution.externalSettlementFingerprint !== null) {
    assertMatchingSettlementFingerprint(
      execution.externalSettlementFingerprint,
      expectedFingerprint,
      settlement.executionId,
    );
    return;
  }
  if (settlement.frame !== undefined) {
    throw new Error(
      `settleExternalExecution: frame presence conflicts with the legacy frame-less settlement for execution "${settlement.executionId}"`,
    );
  }

  const expectedError = settlement.status === 'failed' ? (settlement.error ?? null) : null;
  const expectedReason = settlement.status === 'cancelled' ? (settlement.reason ?? null) : null;
  const adopted = await tx
    .update(workflowExecutions)
    .set({ externalSettlementFingerprint: expectedFingerprint })
    .where(
      and(
        eq(workflowExecutions.id, settlement.executionId),
        isNull(workflowExecutions.externalSettlementFingerprint),
        eq(workflowExecutions.status, settlement.status),
        eq(workflowExecutions.completedAt, completedAt),
        expectedError === null ? isNull(workflowExecutions.error) : eq(workflowExecutions.error, expectedError),
        expectedReason === null ? isNull(workflowExecutions.reason) : eq(workflowExecutions.reason, expectedReason),
      ),
    )
    .returning({ fingerprint: workflowExecutions.externalSettlementFingerprint });
  if (adopted.length > 0) return;

  const [current] = await tx
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, settlement.executionId))
    .limit(1);
  if (current === undefined) {
    throw new Error(`settleExternalExecution: execution "${settlement.executionId}" disappeared`);
  }
  assertMatchingSettlement(current, settlement, completedAt);
  if (current.externalSettlementFingerprint === null) {
    throw new Error(
      `settleExternalExecution: failed to adopt terminal settlement fingerprint for execution "${settlement.executionId}"`,
    );
  }
  assertMatchingSettlementFingerprint(
    current.externalSettlementFingerprint,
    expectedFingerprint,
    settlement.executionId,
  );
}

/**
 * Assert that settlement does not mutate immutable frame identity metadata.
 * @param existing - Durable WorkLog frame row.
 * @param expected - Terminal frame supplied by the settlement.
 */
export function assertMatchingFrameIdentity(existing: SelectWorklogFrameEntry, expected: TerminalWorklogFrame): void {
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
export function assertMatchingSettlement(
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
 * @param worklogFrameEntries - Dialect-resolved WorkLog frame table.
 * @param settlement - Settlement carrying exact frame metadata.
 * @returns Existing matching frame, or `undefined` when none is stored.
 */
export async function loadSettlementFrame(
  tx: WorkflowStorageTransaction,
  worklogFrameEntries: WorklogFrameEntriesTable,
  settlement: ExternalSettlement & { frame: TerminalWorklogFrame },
): Promise<SelectWorklogFrameEntry | undefined> {
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
 * Build the authoritative terminal WorkLog summary values.
 * @param execution - Durable execution row.
 * @param existing - Existing WorkLog summary, when present.
 * @param settlement - Requested terminal settlement.
 * @param completedAt - Resolved terminal timestamp.
 * @returns WorkLog summary database values.
 */
export function buildTerminalSummaryValues(
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
export function buildTerminalFrameValues(
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
