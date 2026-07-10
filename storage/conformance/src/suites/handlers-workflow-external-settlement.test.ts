/**
 * Dual-dialect conformance for durable external settlement identity.
 *
 * The same cases run against file-backed SQLite and live PostgreSQL: replay
 * after a fresh database handle, concurrent identity selection, and adoption
 * of migrated terminal rows whose fingerprint column is null.
 */
import { expect, it } from 'vitest';
import { createBusContext, createBusInstance } from '@makaio/bus-core';
import { WorkflowNamespace, WorkflowSubjects } from '@makaio/contracts';
import {
  registerDrizzleWorkflowStorage,
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
} from '@makaio/subsystem-workflow-engine';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

const startedAt = 1_000;
const completedAt = 1_250;

/**
 * Create an isolated bus backed by one database handle.
 * @param db - Database handle used by the storage handlers.
 */
function createWorkflowStorageBus(db: MakaioDatabase) {
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  const cleanup = registerDrizzleWorkflowStorage(bus, db);
  return { bus, cleanup };
}

/**
 * Build an atomic external registration with one running frame.
 * @param executionId - External execution identifier.
 */
function buildRegistration(executionId: string) {
  const frameId = `${executionId}:station`;
  return {
    execution: {
      id: executionId,
      workflowId: 'conformance-external-workflow',
      status: 'running' as const,
      inputs: {},
      startedAt,
      scope: { type: 'global' as const },
    },
    frame: {
      executionId,
      frameId,
      nodeId: 'station',
      nodeType: 'station' as const,
      path: [frameId],
      status: 'running' as const,
      attempt: 0,
      startedAt,
    },
  };
}

/**
 * Build an exact framed settlement matching {@link buildRegistration}.
 * @param executionId - External execution identifier.
 */
function buildFramedSettlement(executionId: string) {
  const frameId = `${executionId}:station`;
  return {
    executionId,
    status: 'completed' as const,
    completedAt,
    frame: {
      executionId,
      frameId,
      nodeId: 'station',
      nodeType: 'station' as const,
      path: [frameId],
      status: 'completed' as const,
      attempt: 0,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    },
  };
}

describeStorageConformance('workflow external settlement identity', (config) => {
  const getCtx = useSuiteDatabaseContext(config);

  it('replays a framed settlement through a fresh database handle after handler restart', async () => {
    const executionId = `wfx-ext-restart-${crypto.randomUUID()}`;
    const registration = buildRegistration(executionId);
    const settlement = buildFramedSettlement(executionId);
    const first = createWorkflowStorageBus(getCtx().db);
    try {
      await first.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
      await expect(first.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
    } finally {
      first.cleanup();
    }

    const sibling = await getCtx().createSiblingClient();
    const restarted = createWorkflowStorageBus(sibling.db);
    try {
      await expect(restarted.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlement)).resolves.toEqual(
        { success: true },
      );
      await expect(
        restarted.bus.request(WorkflowSubjects.worklog.frame.get, { frameId: registration.frame.frameId }),
      ).resolves.toMatchObject({
        frame: { executionId, status: 'completed', completedAt, durationMs: completedAt - startedAt },
      });
    } finally {
      restarted.cleanup();
      await sibling.close();
    }
  });

  it('allows exactly one concurrent framed or frame-less settlement to choose the identity', async () => {
    const executionId = `wfx-ext-concurrent-${crypto.randomUUID()}`;
    const registration = buildRegistration(executionId);
    const framed = buildFramedSettlement(executionId);
    const frameLess = { executionId, status: 'completed' as const, completedAt };
    // SQLite's cross-connection deferred transactions can deadlock when both
    // readers upgrade to writers. Its supported concurrency seam is the
    // per-handle transaction queue; PostgreSQL uses independent handles here
    // to exercise the database CAS across process-equivalent pools.
    const sibling = config.dialect === 'postgres' ? await getCtx().createSiblingClient() : undefined;
    const first = createWorkflowStorageBus(getCtx().db);
    const second = createWorkflowStorageBus(sibling?.db ?? getCtx().db);
    try {
      await first.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
      const results = await Promise.allSettled([
        first.bus.request(WorkflowStorageSubjects.settleExternalExecution, framed),
        second.bus.request(WorkflowStorageSubjects.settleExternalExecution, frameLess),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const framedWon = results[0]?.status === 'fulfilled';
      const winner = framedWon ? framed : frameLess;
      const loser = framedWon ? frameLess : framed;
      await expect(first.bus.request(WorkflowStorageSubjects.settleExternalExecution, winner)).resolves.toEqual({
        success: true,
      });
      await expect(first.bus.request(WorkflowStorageSubjects.settleExternalExecution, loser)).rejects.toThrow(
        'settlement fingerprint',
      );
    } finally {
      first.cleanup();
      second.cleanup();
      await sibling?.close();
    }
  });

  it('adopts a frame-less fingerprint for a migrated terminal row without consulting advisory frames', async () => {
    const executionId = `wfx-ext-migrated-${crypto.randomUUID()}`;
    const storage = createWorkflowStorageBus(getCtx().db);
    try {
      await storage.bus.request(WorkflowStorageSubjects.setExecution, {
        execution: {
          id: executionId,
          workflowId: 'migrated-conformance-run',
          status: 'failed',
          inputs: {},
          error: 'legacy failure',
          startedAt,
          completedAt,
          scope: { type: 'global' },
        },
      });
      await storage.bus.emit(WorkflowSubjects.frame.failed, {
        executionId,
        frameId: `${executionId}:advisory`,
        nodeId: 'advisory',
        error: 'legacy failure',
        duration: completedAt - startedAt,
        completedAt,
      });

      const frameLess = { executionId, status: 'failed' as const, error: 'legacy failure', completedAt };
      await expect(storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, frameLess)).resolves.toEqual({
        success: true,
      });
      await expect(storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, frameLess)).resolves.toEqual({
        success: true,
      });
      await expect(
        storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, {
          ...buildFramedSettlement(executionId),
          status: 'failed',
          error: 'legacy failure',
          frame: {
            ...buildFramedSettlement(executionId).frame,
            status: 'failed',
            error: 'legacy failure',
          },
        }),
      ).rejects.toThrow('settlement fingerprint');
    } finally {
      storage.cleanup();
    }
  });
});
