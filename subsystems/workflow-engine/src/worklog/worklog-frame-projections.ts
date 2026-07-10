import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import {
  insertRunningWorklogFrameIfAbsent,
  upsertAdvisoryWorklogFrameEntry,
  getWorklogFrameEntryRow,
  reaggregateTokenTotals,
  type SelectWorklogFrameEntry,
} from './worklog-storage.js';
import { safeProject, emitWorklogChanged } from './worklog-projection-helpers.js';

// ─────────────────────────────────────────────────────────────
// Frame metadata resolution helper
// ─────────────────────────────────────────────────────────────

/**
 * Fields from the `frame.started` row that terminal-event projections must
 * preserve rather than overwrite with placeholder values.
 */
interface FrameStartedMetadata {
  nodeId: string;
  nodeType: SelectWorklogFrameEntry['nodeType'];
  path: string[];
  attempt: number;
  iteration: number | null;
  branchKey: string | null;
  startedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
}

const TERMINAL_FRAME_STATUSES = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/**
 * Return whether a WorkLog frame status is terminal.
 * @param status - WorkLog frame status.
 * @returns Whether the status is terminal.
 */
function isTerminalFrameStatus(status: string): boolean {
  return TERMINAL_FRAME_STATUSES.has(status);
}

/**
 * Resolve frame metadata from the existing row written by `frame.started`.
 *
 * Terminal projections (`frame.completed`, `frame.failed`) call this to
 * obtain the immutable fields that must be preserved across the upsert.
 * Safe defaults are used when the `frame.started` row is absent (missed event).
 * @param existing - Row from the worklog frame entries table, or `null`.
 * @param fallbackNodeId - `nodeId` from the terminal event payload.
 * @param fallbackStartedAt - Derived `startedAt` from event duration, or null.
 * @returns Resolved metadata fields ready to merge into the upsert payload.
 */
function resolveFrameStartedMetadata(
  existing: SelectWorklogFrameEntry | null,
  fallbackNodeId: string,
  fallbackStartedAt: number | null,
): FrameStartedMetadata {
  if (existing !== null) {
    return {
      nodeId: existing.nodeId,
      nodeType: existing.nodeType,
      path: existing.path,
      attempt: existing.attempt,
      iteration: existing.iteration,
      branchKey: existing.branchKey,
      startedAt: existing.startedAt,
      inputTokens: existing.inputTokens,
      outputTokens: existing.outputTokens,
      estimatedCost: existing.estimatedCost,
    };
  }
  return {
    nodeId: fallbackNodeId,
    nodeType: 'station',
    path: [],
    attempt: 0,
    iteration: null,
    branchKey: null,
    startedAt: fallbackStartedAt,
    inputTokens: null,
    outputTokens: null,
    estimatedCost: null,
  };
}

// ─────────────────────────────────────────────────────────────
// Frame terminal event projections
// ─────────────────────────────────────────────────────────────

/**
 * Write the `frame.completed` worklog frame entry row.
 *
 * Reads the existing frame entry written by `frame.started` and updates only
 * the terminal fields (`status`, `completedAt`, `durationMs`), preserving
 * `nodeType`, `nodeId`, and `path`. Falls back to safe defaults when the
 * `frame.started` event was missed.
 * @param bus - Message bus to emit changed event on.
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier.
 * @param frameId - Frame identifier.
 * @param nodeId - Node identifier from the event payload (fallback only).
 * @param duration - Wall-clock frame duration in milliseconds.
 * @param completedAt - Runtime-recorded terminal timestamp in Unix milliseconds.
 */
async function projectFrameCompleted(
  bus: IMakaioBus,
  db: MakaioDatabase,
  executionId: string,
  frameId: string,
  nodeId: string,
  duration: number | undefined,
  completedAt: number | undefined,
): Promise<void> {
  const resolvedCompletedAt = completedAt ?? Date.now();
  const existing = await getWorklogFrameEntryRow(db, frameId);
  if (existing !== null && isTerminalFrameStatus(existing.status)) return;
  const fallbackStartedAt = duration !== undefined ? resolvedCompletedAt - duration : null;
  const meta = resolveFrameStartedMetadata(existing, nodeId, fallbackStartedAt);
  await upsertAdvisoryWorklogFrameEntry(db, {
    frameId,
    executionId,
    ...meta,
    status: 'completed',
    completedAt: resolvedCompletedAt,
    durationMs: duration ?? null,
    error: null,
  });
  await reaggregateTokenTotals(db, executionId);
  await emitWorklogChanged(bus, executionId);
}

/**
 * Write the `frame.failed` worklog frame entry row.
 *
 * Reads the existing frame entry written by `frame.started` and updates only
 * the terminal fields (`status`, `completedAt`, `durationMs`, `error`),
 * preserving `nodeType`, `nodeId`, and `path`. Falls back to safe defaults
 * when the `frame.started` event was missed.
 * @param bus - Message bus to emit changed event on.
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier.
 * @param frameId - Frame identifier.
 * @param nodeId - Node identifier from the event payload (fallback only).
 * @param error - Human-readable failure reason.
 * @param duration - Wall-clock frame duration in milliseconds.
 * @param completedAt - Runtime-recorded terminal timestamp in Unix milliseconds.
 */
async function projectFrameFailed(
  bus: IMakaioBus,
  db: MakaioDatabase,
  executionId: string,
  frameId: string,
  nodeId: string,
  error: string,
  duration: number | undefined,
  completedAt: number | undefined,
): Promise<void> {
  const resolvedCompletedAt = completedAt ?? Date.now();
  const existing = await getWorklogFrameEntryRow(db, frameId);
  if (existing !== null && isTerminalFrameStatus(existing.status)) return;
  const fallbackStartedAt = duration !== undefined ? resolvedCompletedAt - duration : null;
  const meta = resolveFrameStartedMetadata(existing, nodeId, fallbackStartedAt);
  await upsertAdvisoryWorklogFrameEntry(db, {
    frameId,
    executionId,
    ...meta,
    status: 'failed',
    completedAt: resolvedCompletedAt,
    durationMs: duration ?? null,
    error,
  });
  await emitWorklogChanged(bus, executionId);
}

/**
 * Register frame lifecycle event subscriptions (started, completed, failed).
 *
 * Terminal events (`frame.completed`, `frame.failed`) read the existing frame
 * row written by `frame.started` and update only the terminal fields (`status`,
 * `completedAt`, `durationMs`, `output` or `error`). This preserves `nodeType`,
 * `nodeId`, and `path` that were written when the frame started, rather than
 * overwriting them with placeholder values.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Array of cleanup functions for the registered subscriptions.
 */
export function registerFrameProjections(bus: IMakaioBus, db: MakaioDatabase): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.frame.started, async (ctx) => {
      const { executionId, frameId, nodeId, nodeType, path, startedAt } = ctx.payload;
      await safeProject(`frame.started[${frameId}]`, async () => {
        await insertRunningWorklogFrameIfAbsent(db, {
          frameId,
          executionId,
          nodeId,
          nodeType,
          path,
          status: 'running',
          attempt: 0,
          iteration: null,
          branchKey: null,
          startedAt: startedAt ?? Date.now(),
          completedAt: null,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          estimatedCost: null,
          error: null,
        });
        await emitWorklogChanged(bus, executionId);
      });
    }),
    bus.on(WorkflowSubjects.frame.completed, async (ctx) => {
      const { executionId, frameId, nodeId, duration, completedAt } = ctx.payload;
      await safeProject(`frame.completed[${frameId}]`, () =>
        projectFrameCompleted(bus, db, executionId, frameId, nodeId, duration, completedAt),
      );
    }),
    bus.on(WorkflowSubjects.frame.failed, async (ctx) => {
      const { executionId, frameId, nodeId, error, duration, completedAt } = ctx.payload;
      await safeProject(`frame.failed[${frameId}]`, () =>
        projectFrameFailed(bus, db, executionId, frameId, nodeId, error, duration, completedAt),
      );
    }),
  ];
}
