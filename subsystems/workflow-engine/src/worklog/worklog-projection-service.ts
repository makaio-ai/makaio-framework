import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import {
  upsertWorklogGateEvent,
  getWorklogGateEvent,
  getWorklogFrameEntry,
  getWorklogSummary,
  listWorklogSummaries,
  aggregateWorklogStats,
  insertWorklogArtifactWrite,
  buildArtifactWriteId,
  buildGateEventId,
} from './worklog-storage.js';
import { resolveArtifactWriteMetadata } from './worklog-artifact-metadata.js';
import { safeProject, emitWorklogChanged } from './worklog-projection-helpers.js';
import { registerExecutionProjections } from './worklog-execution-projections.js';
import { registerFrameProjections } from './worklog-frame-projections.js';

const GATE_TERMINAL_STATUS_BY_SOURCE = { user: 'rejected', timeout: 'timed-out', cancelled: 'cancelled' } as const;

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
 * **RPC handlers** serve WorkLog execution and frame reads directly from the
 * WorkLog tables.
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
    bus.on(WorkflowSubjects.worklog.frame.get, async (ctx) => {
      const { frameId } = ctx.payload;
      const frame = await getWorklogFrameEntry(db, frameId);
      ctx.setResult({ frame });
    }),
    bus.on(WorkflowSubjects.worklog.list, async (ctx) => {
      const { workflowId, status, limit, offset } = ctx.payload;
      const result = await listWorklogSummaries(db, { workflowId, status, limit, offset });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.worklog.stats, async (ctx) => {
      const { workflowId, since, until } = ctx.payload;
      const stats = await aggregateWorklogStats(db, { workflowId, since, until });
      ctx.setResult({ stats });
    }),
  ];

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
