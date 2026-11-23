import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { WorkflowSubjects } from '../namespace.js';
import {
  getWorklogFrameEntry,
  getWorklogSummary,
  listWorklogSummaries,
  aggregateWorklogStats,
  insertWorklogArtifactWrite,
  buildArtifactWriteId,
} from './worklog-storage.js';
import { resolveArtifactWriteMetadata } from './worklog-artifact-metadata.js';
import { safeProject, emitWorklogChanged } from './worklog-projection-helpers.js';
import { registerExecutionProjections } from './worklog-execution-projections.js';
import { registerFrameProjections } from './worklog-frame-projections.js';

/**
 * Register the artifact update subscription.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance.
 * @returns Cleanup function for the subscription.
 */
function registerArtifactProjection(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(WorkflowSubjects.artifact.updated, async (ctx) => {
    const { executionId, frameId, artifactRef, revision } = ctx.payload;
    await safeProject(`artifact.updated[${executionId}:${frameId}]`, async () => {
      const metadata = await resolveArtifactWriteMetadata(ctx.call, bus, db, frameId, artifactRef, revision);
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
      await emitWorklogChanged(ctx.call, bus, executionId);
    });
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
 * Subscribed events cover execution, frame, and artifact-write projections.
 * @param bus - Message bus to subscribe on.
 * @param db - Drizzle database instance for WorkLog tables.
 * @returns Cleanup function that unsubscribes all registered handlers.
 */
export function registerWorklogProjection(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const cleanups: Array<() => void> = [
    ...registerExecutionProjections(bus, db),
    ...registerFrameProjections(bus, db),
    registerArtifactProjection(bus, db),
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
