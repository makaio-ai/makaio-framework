import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import {
  upsertWorklogSummary,
  upsertRunningWorklogSummary,
  aggregateTokenTotals,
  getWorklogSummary,
} from './worklog-storage.js';
import { safeProject, emitWorklogChanged } from './worklog-projection-helpers.js';

const TERMINAL_WORKLOG_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Return whether a WorkLog execution status is terminal.
 * @param status - WorkLog execution status.
 * @returns Whether the status is terminal.
 */
function isTerminalWorklogStatus(status: string): boolean {
  return TERMINAL_WORKLOG_STATUSES.has(status);
}

/**
 * @param bus - Message bus to emit changed event on.
 * @param db - Drizzle database instance.
 * @param payload - Source execution start event payload.
 */
async function projectExecutionStarted(
  bus: IMakaioBus,
  db: MakaioDatabase,
  payload: { readonly executionId: string; readonly workflowId: string; readonly startedAt?: number },
): Promise<void> {
  await upsertRunningWorklogSummary(db, {
    executionId: payload.executionId,
    workflowId: payload.workflowId,
    workflowName: null,
    status: 'running',
    startedAt: payload.startedAt ?? Date.now(),
    completedAt: null,
    durationMs: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    totalEstimatedCost: null,
    error: null,
    failedNodeId: null,
  });
  await emitWorklogChanged(bus, payload.executionId);
}

/**
 * @param bus - Message bus to emit changed event on.
 * @param db - Drizzle database instance.
 * @param payload - Source execution completion event payload.
 */
async function projectExecutionCompleted(
  bus: IMakaioBus,
  db: MakaioDatabase,
  payload: { readonly executionId: string; readonly totalDuration: number; readonly completedAt?: number },
): Promise<void> {
  const completedAt = payload.completedAt ?? Date.now();
  const existing = await getWorklogSummary(db, payload.executionId);
  if (existing !== null && isTerminalWorklogStatus(existing.status)) return;
  await upsertWorklogSummary(db, {
    executionId: payload.executionId,
    workflowId: existing?.workflowId ?? payload.executionId,
    workflowName: existing?.workflowName ?? null,
    status: 'completed',
    startedAt: existing?.startedAt ?? completedAt - payload.totalDuration,
    completedAt,
    durationMs: payload.totalDuration,
    totalInputTokens: existing?.totalInputTokens ?? null,
    totalOutputTokens: existing?.totalOutputTokens ?? null,
    totalEstimatedCost: existing?.totalEstimatedCost ?? null,
    error: null,
    failedNodeId: null,
  });
  await emitWorklogChanged(bus, payload.executionId);
}

/**
 * @param bus - Message bus to emit changed event on.
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier.
 * @param status - Terminal status (`'failed'` or `'cancelled'`).
 * @param error - Error message for failed executions.
 * @param failedNodeId - Failed node ID for failed executions.
 * @param completedAt - Source execution completion timestamp.
 */
async function projectExecutionTerminated(
  bus: IMakaioBus,
  db: MakaioDatabase,
  executionId: string,
  status: 'failed' | 'cancelled',
  error: string | null,
  failedNodeId: string | null,
  completedAt: number,
): Promise<void> {
  const existing = await getWorklogSummary(db, executionId);
  if (existing !== null && isTerminalWorklogStatus(existing.status)) return;
  const startedAt = existing?.startedAt ?? completedAt;
  await upsertWorklogSummary(db, {
    executionId,
    workflowId: existing?.workflowId ?? executionId,
    workflowName: existing?.workflowName ?? null,
    status,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    totalInputTokens: existing?.totalInputTokens ?? null,
    totalOutputTokens: existing?.totalOutputTokens ?? null,
    totalEstimatedCost: existing?.totalEstimatedCost ?? null,
    error,
    failedNodeId,
  });
  await emitWorklogChanged(bus, executionId);
}

/**
 * Re-aggregate token totals into the worklog summary when a frame completes.
 * @param bus - Message bus to emit changed event on.
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier.
 */
export async function reaggregateTokenTotals(bus: IMakaioBus, db: MakaioDatabase, executionId: string): Promise<void> {
  const totals = await aggregateTokenTotals(db, executionId);
  if (totals.totalInputTokens > 0 || totals.totalOutputTokens > 0 || totals.totalEstimatedCost > 0) {
    const existing = await getWorklogSummary(db, executionId);
    if (existing) {
      await upsertWorklogSummary(db, {
        executionId,
        workflowId: existing.workflowId,
        workflowName: existing.workflowName ?? null,
        status: existing.status,
        startedAt: existing.startedAt,
        completedAt: existing.completedAt ?? null,
        durationMs: existing.durationMs ?? null,
        totalInputTokens: totals.totalInputTokens,
        totalOutputTokens: totals.totalOutputTokens,
        totalEstimatedCost: totals.totalEstimatedCost,
        error: existing.error ?? null,
        failedNodeId: existing.failedNodeId ?? null,
      });
    }
  }
}

/**
 * Register execution lifecycle event subscriptions (started, completed, failed, cancelled).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Array of cleanup functions for the registered subscriptions.
 */
export function registerExecutionProjections(bus: IMakaioBus, db: MakaioDatabase): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.execution.started, async (ctx) => {
      const { executionId } = ctx.payload;
      await safeProject(`execution.started[${executionId}]`, () => projectExecutionStarted(bus, db, ctx.payload));
    }),
    bus.on(WorkflowSubjects.execution.completed, async (ctx) => {
      const { executionId } = ctx.payload;
      await safeProject(`execution.completed[${executionId}]`, () => projectExecutionCompleted(bus, db, ctx.payload));
    }),
    bus.on(WorkflowSubjects.execution.failed, async (ctx) => {
      const { executionId, error, failedStepId } = ctx.payload;
      const completedAt = ctx.payload.completedAt ?? Date.now();
      await safeProject(`execution.failed[${executionId}]`, () =>
        projectExecutionTerminated(bus, db, executionId, 'failed', error, failedStepId ?? null, completedAt),
      );
    }),
    bus.on(WorkflowSubjects.execution.cancelled, async (ctx) => {
      const { executionId } = ctx.payload;
      const completedAt = ctx.payload.completedAt ?? Date.now();
      await safeProject(`execution.cancelled[${executionId}]`, () =>
        projectExecutionTerminated(bus, db, executionId, 'cancelled', null, null, completedAt),
      );
    }),
  ];
}
