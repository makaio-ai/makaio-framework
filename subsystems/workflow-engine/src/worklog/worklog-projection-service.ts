import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import {
  upsertWorklogSummary,
  upsertWorklogFrameEntry,
  getWorklogFrameEntry,
  insertWorklogArtifactWrite,
  upsertWorklogGateEvent,
  getWorklogGateEvent,
  getWorklogSummary,
  listWorklogSummaries,
  aggregateTokenTotals,
  buildArtifactWriteId,
  buildGateEventId,
  type SelectWorklogFrameEntry,
} from './worklog-storage.js';
import { resolveArtifactWriteMetadata } from './worklog-artifact-metadata.js';

const GATE_TERMINAL_STATUS_BY_SOURCE = { user: 'rejected', timeout: 'timed-out', cancelled: 'cancelled' } as const;

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
  await upsertWorklogSummary(db, {
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
 * Register execution lifecycle event subscriptions (started, completed, failed, cancelled).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Array of cleanup functions for the registered subscriptions.
 */
function registerExecutionProjections(bus: IMakaioBus, db: MakaioDatabase): Array<() => void> {
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

/**
 * Re-aggregate token totals into the worklog summary when a frame completes.
 * @param bus - Message bus to emit changed event on.
 * @param db - Drizzle database instance.
 * @param executionId - Execution identifier.
 */
async function reaggregateTokenTotals(bus: IMakaioBus, db: MakaioDatabase, executionId: string): Promise<void> {
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
  const existing = await getWorklogFrameEntry(db, frameId);
  const fallbackStartedAt = duration !== undefined ? resolvedCompletedAt - duration : null;
  const meta = resolveFrameStartedMetadata(existing, nodeId, fallbackStartedAt);
  await upsertWorklogFrameEntry(db, {
    frameId,
    executionId,
    ...meta,
    status: 'completed',
    completedAt: resolvedCompletedAt,
    durationMs: duration ?? null,
    error: null,
  });
  await reaggregateTokenTotals(bus, db, executionId);
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
  const existing = await getWorklogFrameEntry(db, frameId);
  const fallbackStartedAt = duration !== undefined ? resolvedCompletedAt - duration : null;
  const meta = resolveFrameStartedMetadata(existing, nodeId, fallbackStartedAt);
  await upsertWorklogFrameEntry(db, {
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
function registerFrameProjections(bus: IMakaioBus, db: MakaioDatabase): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.frame.started, async (ctx) => {
      const { executionId, frameId, nodeId, nodeType, path, startedAt } = ctx.payload;
      await safeProject(`frame.started[${frameId}]`, async () => {
        await upsertWorklogFrameEntry(db, {
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

/**
 * Register gate and artifact event subscriptions (suspended, resumed, artifact.updated).
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Array of cleanup functions for the registered subscriptions.
 */
function registerGateAndArtifactProjections(bus: IMakaioBus, db: MakaioDatabase): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.gate.suspended, async (ctx) => {
      const { executionId, frameId, nodeId, prompt } = ctx.payload;
      await safeProject(`gate.suspended[${frameId}]`, async () => {
        await upsertWorklogGateEvent(db, {
          id: buildGateEventId(executionId, nodeId, frameId),
          executionId,
          nodeId,
          frameId,
          status: 'waiting',
          prompt: prompt ?? null,
          openedAt: Date.now(),
          resolvedAt: null,
          resumeData: null,
        });
        await emitWorklogChanged(bus, executionId);
      });
    }),
    bus.on(WorkflowSubjects.gate.resumed, async (ctx) => {
      const { executionId, frameId, nodeId, resumeData } = ctx.payload;
      await safeProject(`gate.resumed[${frameId}]`, async () => {
        const id = buildGateEventId(executionId, nodeId, frameId);
        const existing = await getWorklogGateEvent(db, id);
        const resolvedAt = Date.now();
        // Patch the existing waiting row to resumed without replacing the
        // suspension metadata that tells the dashboard what was approved.
        // If the row doesn't exist (missed suspended event), create it with a
        // best-effort openedAt.
        await upsertWorklogGateEvent(db, {
          id,
          executionId,
          nodeId,
          frameId,
          status: 'resumed',
          prompt: existing?.prompt ?? null,
          openedAt: existing?.openedAt ?? resolvedAt,
          resolvedAt,
          resumeData,
        });
        await emitWorklogChanged(bus, executionId);
      });
    }),
    bus.on(WorkflowSubjects.gate.resolved, async (ctx) => projectGateResolvedEvent(ctx.payload, bus, db)),
    bus.on(WorkflowSubjects.artifact.updated, async (ctx) => {
      const { executionId, frameId, artifactRef, revision } = ctx.payload;
      await safeProject(`artifact.updated[${executionId}:${frameId}]`, async () => {
        const metadata = await resolveArtifactWriteMetadata(bus, db, frameId, artifactRef, revision);
        if (metadata === null) {
          // The workflow artifact event names the frame and artifact revision,
          // but the WorkLog row also needs nodeId, schemaVersion, and scope.
          // Those come from the frame projection and artifact resolve RPC; when
          // either lookup is unavailable, skipping the denormalized row is safer
          // than storing fabricated binding metadata.
          return;
        }
        const writtenAt = Date.now();
        await insertWorklogArtifactWrite(db, {
          id: buildArtifactWriteId(executionId, frameId, artifactRef.kind, artifactRef.id, writtenAt),
          executionId,
          frameId,
          nodeId: metadata.nodeId,
          artifact: metadata.artifact,
          revision: revision ?? null,
          writtenAt,
        });
        await emitWorklogChanged(bus, executionId);
      });
    }),
  ];
}

/**
 * Project terminal gate resolution metadata.
 *
 * User approvals are already fully represented by `gate.resumed`. User
 * rejections also emit `gate.resumed` for typed workflow resume data, then this
 * event flips the WorkLog status from `resumed` to `rejected` while preserving
 * suspension metadata and resume data. Cancellation directly marks the waiting
 * gate cancelled because there is no approval action or resume data.
 * @param payload - Gate resolution lifecycle payload.
 * @param bus - Message bus used for worklog change events.
 * @param db - Drizzle database instance for WorkLog tables.
 */
async function projectGateResolvedEvent(
  payload: (typeof WorkflowSubjects.gate.resolved)['$meta']['payload'],
  bus: IMakaioBus,
  db: MakaioDatabase,
): Promise<void> {
  const { executionId, frameId, stepId, source } = payload;
  if (source === 'user' && payload.action === 'approve') return;
  await safeProject(`gate.resolved[${frameId}]`, async () => {
    const id = buildGateEventId(executionId, stepId, frameId);
    const existing = await getWorklogGateEvent(db, id);
    const resolvedAt = Date.now();
    await upsertWorklogGateEvent(db, {
      id,
      executionId,
      nodeId: stepId,
      frameId,
      status:
        source !== 'cancelled' && payload.action === 'approve' ? 'resumed' : GATE_TERMINAL_STATUS_BY_SOURCE[source],
      prompt: existing?.prompt ?? null,
      openedAt: existing?.openedAt ?? resolvedAt,
      resolvedAt,
      resumeData: existing?.resumeData ?? null,
    });
    await emitWorklogChanged(bus, executionId);
  });
}

/**
 * Register all WorkLog projection subscriptions and RPC handlers.
 *
 * **Projection** subscribes to workflow and artifact bus events and writes
 * denormalized WorkLog rows so the UI can query execution history without
 * accessing runtime execution state.
 *
 * **Resilience contract:** every event handler is wrapped so that projection
 * write failures are logged but never propagate to callers — the runtime must
 * not be blocked by a failing WorkLog write.
 *
 * **RPC handlers** serve `workflow.worklog.get` and `workflow.worklog.list`
 * requests directly from the WorkLog tables.
 *
 * Subscribed events cover execution, frame, gate, and artifact-write projections.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance for WorkLog tables.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerWorklogProjection(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const cleanups: Array<() => void> = [
    ...registerExecutionProjections(bus, db),
    ...registerFrameProjections(bus, db),
    ...registerGateAndArtifactProjections(bus, db),
    bus.on(WorkflowSubjects.worklog.get, async (ctx) => {
      const { executionId } = ctx.payload;
      const summary = await getWorklogSummary(db, executionId);
      ctx.setResult({ summary });
    }),
    bus.on(WorkflowSubjects.worklog.list, async (ctx) => {
      const { workflowId, status, limit, offset } = ctx.payload;
      const result = await listWorklogSummaries(db, { workflowId, status, limit, offset });
      ctx.setResult(result);
    }),
  ];

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

/**
 * Wrap a projection write in a try-catch so failures are logged but never
 * propagate to the event dispatch layer.
 *
 * WorkLog is a PROJECTION — runtime execution must never be blocked by a
 * failing WorkLog write. This wrapper enforces that invariant at every
 * call-site without requiring every handler to repeat the try-catch.
 * @param label - Human-readable label for log messages.
 * @param fn - Async projection function to execute.
 */
async function safeProject(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[WorklogProjection] Write failed (${label}):`, error);
  }
}

/**
 * Emit `workflow.worklog.changed` for the given execution.
 *
 * Observers (e.g., the GUI) subscribe to this event to invalidate cached
 * WorkLog data after each projection update.
 *
 * Emit failures are swallowed because `worklog.changed` is advisory — a missed
 * notification only causes a temporary stale cache, not data loss.
 * @param bus - Message bus to emit on.
 * @param executionId - Execution whose WorkLog record changed.
 */
async function emitWorklogChanged(bus: IMakaioBus, executionId: string): Promise<void> {
  try {
    await bus.emit(WorkflowSubjects.worklog.changed, { executionId });
  } catch (error) {
    console.error(`[WorklogProjection] worklog.changed emit failed for ${executionId}:`, error);
  }
}
