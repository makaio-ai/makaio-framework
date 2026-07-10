import { eq } from 'drizzle-orm';
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

const TERMINAL_FRAME_STATUSES = new Set(['completed', 'failed', 'skipped', 'cancelled']);

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
 * Reject a terminal replay whose frame metadata differs from the durable settlement.
 * @param tx - Active storage transaction.
 * @param worklogFrameEntries - Dialect-resolved WorkLog frame table.
 * @param settlement - Replayed settlement request.
 */
export async function assertMatchingTerminalFrame(
  tx: WorkflowStorageTransaction,
  worklogFrameEntries: WorklogFrameEntriesTable,
  settlement: ExternalSettlement,
): Promise<void> {
  if (settlement.frame === undefined) {
    const executionFrames = await tx
      .select()
      .from(worklogFrameEntries)
      .where(eq(worklogFrameEntries.executionId, settlement.executionId));
    if (executionFrames.some((frame) => TERMINAL_FRAME_STATUSES.has(frame.status))) {
      throw new Error(
        `settleExternalExecution: frame presence conflicts with the existing terminal settlement for execution "${settlement.executionId}"`,
      );
    }
    return;
  }
  const existing = await loadSettlementFrame(
    tx,
    worklogFrameEntries,
    settlement as ExternalSettlement & { frame: TerminalWorklogFrame },
  );
  if (existing === undefined) {
    throw new Error(
      `settleExternalExecution: frame presence conflicts with the existing terminal settlement for execution "${settlement.executionId}"`,
    );
  }
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
