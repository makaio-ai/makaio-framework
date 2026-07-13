import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { serializeDatabaseOperation } from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import {
  insertRunningWorklogSummaryIfAbsent,
  upsertAdvisoryWorklogSummary,
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
 * @param db - Drizzle database instance.
 * @param payload - Source execution start event payload.
 * @returns Whether the projection changed durable WorkLog state.
 */
async function projectExecutionStarted(
  db: MakaioDatabase,
  payload: { readonly executionId: string; readonly workflowId: string; readonly startedAt?: number },
): Promise<boolean> {
  await insertRunningWorklogSummaryIfAbsent(db, {
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
  return true;
}

/**
 * @param db - Drizzle database instance.
 * @param payload - Source execution completion event payload.
 * @returns Whether the projection changed durable WorkLog state.
 */
async function projectExecutionCompleted(
  db: MakaioDatabase,
  payload: { readonly executionId: string; readonly totalDuration: number; readonly completedAt?: number },
): Promise<boolean> {
  const completedAt = payload.completedAt ?? Date.now();
  const existing = await getWorklogSummary(db, payload.executionId);
  if (existing !== null && isTerminalWorklogStatus(existing.status)) return false;
  await upsertAdvisoryWorklogSummary(db, {
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
  return true;
}

/**
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier.
 * @param status - Terminal status (`'failed'` or `'cancelled'`).
 * @param error - Error message for failed executions.
 * @param failedNodeId - Failed node ID for failed executions.
 * @param completedAt - Source execution completion timestamp.
 * @returns Whether the projection changed durable WorkLog state.
 */
async function projectExecutionTerminated(
  db: MakaioDatabase,
  executionId: string,
  status: 'failed' | 'cancelled',
  error: string | null,
  failedNodeId: string | null,
  completedAt: number,
): Promise<boolean> {
  const existing = await getWorklogSummary(db, executionId);
  if (existing !== null && isTerminalWorklogStatus(existing.status)) return false;
  const startedAt = existing?.startedAt ?? completedAt;
  await upsertAdvisoryWorklogSummary(db, {
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
  return true;
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
      await safeProject(`execution.started[${executionId}]`, async () => {
        const changed = await serializeDatabaseOperation(db, () => projectExecutionStarted(db, ctx.payload));
        if (changed) await emitWorklogChanged(bus, executionId);
      });
    }),
    bus.on(WorkflowSubjects.execution.completed, async (ctx) => {
      const { executionId } = ctx.payload;
      await safeProject(`execution.completed[${executionId}]`, async () => {
        const changed = await serializeDatabaseOperation(db, () => projectExecutionCompleted(db, ctx.payload));
        if (changed) await emitWorklogChanged(bus, executionId);
      });
    }),
    bus.on(WorkflowSubjects.execution.failed, async (ctx) => {
      const { executionId, error, failedStepId } = ctx.payload;
      const completedAt = ctx.payload.completedAt ?? Date.now();
      await safeProject(`execution.failed[${executionId}]`, async () => {
        const changed = await serializeDatabaseOperation(db, () =>
          projectExecutionTerminated(db, executionId, 'failed', error, failedStepId ?? null, completedAt),
        );
        if (changed) await emitWorklogChanged(bus, executionId);
      });
    }),
    bus.on(WorkflowSubjects.execution.cancelled, async (ctx) => {
      const { executionId } = ctx.payload;
      const completedAt = ctx.payload.completedAt ?? Date.now();
      await safeProject(`execution.cancelled[${executionId}]`, async () => {
        const changed = await serializeDatabaseOperation(db, () =>
          projectExecutionTerminated(db, executionId, 'cancelled', null, null, completedAt),
        );
        if (changed) await emitWorklogChanged(bus, executionId);
      });
    }),
  ];
}
