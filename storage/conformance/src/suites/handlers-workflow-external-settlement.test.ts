/**
 * Dual-dialect conformance for durable external settlement identity and usage.
 *
 * The same cases run against file-backed SQLite and live PostgreSQL: replay
 * after a fresh database handle, concurrent identity selection, usage
 * aggregation ordering, and adoption of migrated terminal rows.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createBusContext, createBusInstance } from '@makaio/bus-core';
import { WorkflowNamespace, WorkflowSubjects } from '@makaio/contracts';
import {
  registerDrizzleWorkflowStorage,
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
} from '@makaio/subsystem-workflow-engine';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { SiblingClient, StorageDatabaseContext } from '../harness/config.js';
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
 * @param usage - Optional terminal frame usage telemetry.
 */
function buildFramedSettlement(
  executionId: string,
  usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCost: number },
) {
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
      ...usage,
    },
  };
}

/**
 * Return the sole PostgreSQL backend PID used by a poolMax=1 sibling.
 * @param client - Single-connection sibling client.
 * @returns PostgreSQL backend process identifier.
 */
async function getBackendPid(client: SiblingClient): Promise<number> {
  const rows = await client.executor.all<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return rows[0]!.pid;
}

/**
 * Wait until PostgreSQL reports that a specific backend is blocked on a lock.
 * @param ctx - Conformance database context used for lock inspection.
 * @param pid - Backend process identifier to inspect.
 * @param operation - Human-readable operation for timeout diagnostics.
 */
async function waitForBackendLock(ctx: StorageDatabaseContext, pid: number, operation: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const rows = await ctx.executor.all<{ waiting: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid = ${pid} AND wait_event_type = 'Lock'
      ) AS waiting
    `);
    if (rows[0]?.waiting === true) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${operation} to block on the summary row`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describeStorageConformance('workflow external settlement identity', (config) => {
  const getCtx = useSuiteDatabaseContext(config);
  const describePg = config.dialect === 'postgres' ? describe : describe.skip;

  it('serializes identical concurrent registrations before inserting secondary WorkLog rows', async () => {
    const executionId = `wfx-ext-register-concurrent-${crypto.randomUUID()}`;
    const registration = buildRegistration(executionId);
    // SQLite serializes transactions on one supported handle. PostgreSQL uses
    // independent handles so the execution primary key exercises the same
    // synchronization used across process-equivalent pools.
    const sibling = config.dialect === 'postgres' ? await getCtx().createSiblingClient() : undefined;
    const first = createWorkflowStorageBus(getCtx().db);
    const second = createWorkflowStorageBus(sibling?.db ?? getCtx().db);
    try {
      await expect(
        Promise.all([
          first.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration),
          second.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration),
        ]),
      ).resolves.toEqual([
        { executionId, frameId: registration.frame.frameId },
        { executionId, frameId: registration.frame.frameId },
      ]);
      await expect(first.bus.request(WorkflowSubjects.worklog.get, { executionId })).resolves.toMatchObject({
        summary: { executionId, status: 'running', startedAt },
      });
      await expect(
        first.bus.request(WorkflowSubjects.worklog.frame.get, { frameId: registration.frame.frameId }),
      ).resolves.toMatchObject({
        frame: { executionId, status: 'running', startedAt },
      });
    } finally {
      first.cleanup();
      second.cleanup();
      await sibling?.close();
    }
  });

  it('replays registration beside advisory frames and settles its bound frame after advisory terminalization', async () => {
    const executionId = `wfx-ext-registration-binding-${crypto.randomUUID()}`;
    const registration = buildRegistration(executionId);
    const advisoryFrameId = `${executionId}:advisory`;
    const storage = createWorkflowStorageBus(getCtx().db);
    try {
      await storage.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
      await storage.bus.emit(WorkflowSubjects.frame.started, {
        executionId,
        frameId: advisoryFrameId,
        nodeId: 'advisory',
        nodeType: 'station',
        path: [advisoryFrameId],
        startedAt: startedAt + 25,
      });
      await expect(
        storage.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration),
      ).resolves.toEqual({ executionId, frameId: registration.frame.frameId });

      await storage.bus.emit(WorkflowSubjects.frame.completed, {
        executionId,
        frameId: registration.frame.frameId,
        nodeId: registration.frame.nodeId,
        duration: 100,
        completedAt: startedAt + 100,
      });
      await expect(
        storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, {
          executionId,
          status: 'failed',
          error: 'authoritative failure',
          completedAt,
        }),
      ).resolves.toEqual({ success: true });
      await expect(
        storage.bus.request(WorkflowSubjects.worklog.frame.get, { frameId: registration.frame.frameId }),
      ).resolves.toMatchObject({
        frame: {
          executionId,
          status: 'failed',
          completedAt,
          durationMs: completedAt - startedAt,
          error: 'authoritative failure',
        },
      });
    } finally {
      storage.cleanup();
    }
  });

  it('clears a pre-settlement aggregate when the authoritative terminal frame measures zero usage', async () => {
    const executionId = `wfx-ext-usage-settlement-${crypto.randomUUID()}`;
    const registration = {
      ...buildRegistration(executionId),
      frame: {
        ...buildRegistration(executionId).frame,
        inputTokens: 11,
        outputTokens: 7,
        estimatedCost: 0.18,
      },
    };
    const storage = createWorkflowStorageBus(getCtx().db);
    try {
      await storage.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
      await storage.bus.emit(WorkflowSubjects.frame.completed, {
        executionId,
        frameId: registration.frame.frameId,
        nodeId: registration.frame.nodeId,
        duration: completedAt - startedAt,
        completedAt,
      });
      await expect(storage.bus.request(WorkflowSubjects.worklog.get, { executionId })).resolves.toMatchObject({
        summary: { totalInputTokens: 11, totalOutputTokens: 7, totalEstimatedCost: 0.18 },
      });

      const settlement = buildFramedSettlement(executionId, {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
      });
      await expect(storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      await expect(storage.bus.request(WorkflowSubjects.worklog.get, { executionId })).resolves.toMatchObject({
        summary: {
          status: 'completed',
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalEstimatedCost: 0,
        },
      });
    } finally {
      storage.cleanup();
    }
  });

  it('allows delayed frame usage to reaggregate an already-terminal summary', async () => {
    const executionId = `wfx-ext-usage-late-${crypto.randomUUID()}`;
    const registration = buildRegistration(executionId);
    const settlement = buildFramedSettlement(executionId, {
      inputTokens: 31,
      outputTokens: 17,
      estimatedCost: 0.48,
    });
    const lateFrameId = `${executionId}:late-telemetry`;
    const storage = createWorkflowStorageBus(getCtx().db);
    try {
      await storage.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
      await storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlement);
      await storage.bus.emit(WorkflowSubjects.frame.started, {
        executionId,
        frameId: lateFrameId,
        nodeId: 'late-telemetry',
        nodeType: 'station',
        path: [lateFrameId],
        startedAt,
      });
      await getCtx().executor.run(sql`
        UPDATE worklog_frame_entries
        SET input_tokens = 5, output_tokens = 3, estimated_cost = 0.07
        WHERE frame_id = ${lateFrameId}
      `);
      await storage.bus.emit(WorkflowSubjects.frame.completed, {
        executionId,
        frameId: lateFrameId,
        nodeId: 'late-telemetry',
        duration: completedAt - startedAt,
        completedAt,
      });

      await expect(storage.bus.request(WorkflowSubjects.worklog.get, { executionId })).resolves.toMatchObject({
        summary: {
          status: 'completed',
          totalInputTokens: 36,
          totalOutputTokens: 20,
          totalEstimatedCost: 0.55,
        },
      });
    } finally {
      storage.cleanup();
    }
  });

  describePg('cross-handle usage serialization', () => {
    it.each([
      'settlement-first',
      'reaggregation-first',
    ] as const)('aggregates after acquiring the summary row (%s)', async (firstOperation) => {
      const ctx = getCtx();
      const executionId = `wfx-ext-usage-race-${firstOperation}-${crypto.randomUUID()}`;
      const baseRegistration = buildRegistration(executionId);
      const registration = {
        ...baseRegistration,
        frame: {
          ...baseRegistration.frame,
          inputTokens: 17,
          outputTokens: 9,
          estimatedCost: 0.26,
        },
      };
      const settlement = buildFramedSettlement(executionId, {
        inputTokens: 43,
        outputTokens: 21,
        estimatedCost: 0.64,
      });
      const triggerFrameId = `${executionId}:reaggregate`;
      const [settlementClient, reaggregationClient, holderClient] = await Promise.all([
        ctx.createSiblingClient({ poolMax: 1 }),
        ctx.createSiblingClient({ poolMax: 1 }),
        ctx.createSiblingClient({ poolMax: 1 }),
      ]);
      const setup = createWorkflowStorageBus(ctx.db);
      const settlementStorage = createWorkflowStorageBus(settlementClient.db);
      const reaggregationStorage = createWorkflowStorageBus(reaggregationClient.db);
      let releaseHolder = (): void => {};
      let holderPromise: Promise<void> | undefined;
      let settlementPromise: Promise<unknown> | undefined;
      let reaggregationPromise: Promise<unknown> | undefined;

      try {
        await setup.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
        await setup.bus.emit(WorkflowSubjects.frame.completed, {
          executionId,
          frameId: registration.frame.frameId,
          nodeId: registration.frame.nodeId,
          duration: completedAt - startedAt,
          completedAt,
        });
        await setup.bus.emit(WorkflowSubjects.frame.started, {
          executionId,
          frameId: triggerFrameId,
          nodeId: 'reaggregate',
          nodeType: 'station',
          path: [triggerFrameId],
          startedAt,
        });

        const [settlementPid, reaggregationPid] = await Promise.all([
          getBackendPid(settlementClient),
          getBackendPid(reaggregationClient),
        ]);
        let signalHolder!: () => void;
        const holderAcquired = new Promise<void>((resolve) => {
          signalHolder = resolve;
        });
        const holderRelease = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
        holderPromise = holderClient.executor.withSession(async (session) => {
          await session.run(sql.raw('BEGIN'));
          await session.run(sql`
              UPDATE worklog_summaries
              SET total_input_tokens = total_input_tokens
              WHERE execution_id = ${executionId}
            `);
          signalHolder();
          await holderRelease;
          await session.run(sql.raw('COMMIT'));
        });
        await Promise.race([holderAcquired, holderPromise]);

        const startSettlement = (): Promise<unknown> =>
          settlementStorage.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlement);
        const startReaggregation = (): Promise<unknown> =>
          reaggregationStorage.bus.emit(WorkflowSubjects.frame.completed, {
            executionId,
            frameId: triggerFrameId,
            nodeId: 'reaggregate',
            duration: completedAt - startedAt,
            completedAt,
          });

        if (firstOperation === 'settlement-first') {
          settlementPromise = startSettlement();
          await waitForBackendLock(ctx, settlementPid, 'external settlement');
          reaggregationPromise = startReaggregation();
          await waitForBackendLock(ctx, reaggregationPid, 'delayed reaggregation');
        } else {
          reaggregationPromise = startReaggregation();
          await waitForBackendLock(ctx, reaggregationPid, 'delayed reaggregation');
          settlementPromise = startSettlement();
          await waitForBackendLock(ctx, settlementPid, 'external settlement');
        }

        releaseHolder();
        await Promise.all([holderPromise, settlementPromise, reaggregationPromise]);

        await expect(setup.bus.request(WorkflowSubjects.worklog.get, { executionId })).resolves.toMatchObject({
          summary: {
            status: 'completed',
            totalInputTokens: 43,
            totalOutputTokens: 21,
            totalEstimatedCost: 0.64,
          },
        });
      } finally {
        releaseHolder();
        await Promise.allSettled(
          [holderPromise, settlementPromise, reaggregationPromise].filter(
            (promise): promise is Promise<unknown> => promise !== undefined,
          ),
        );
        setup.cleanup();
        settlementStorage.cleanup();
        reaggregationStorage.cleanup();
        await Promise.all([settlementClient.close(), reaggregationClient.close(), holderClient.close()]);
      }
    });
  });

  it('replays a framed settlement through a fresh database handle after handler restart', async () => {
    const executionId = `wfx-ext-restart-${crypto.randomUUID()}`;
    const registration = buildRegistration(executionId);
    const settlement = buildFramedSettlement(executionId);
    const first = createWorkflowStorageBus(getCtx().db);
    try {
      await first.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
      await first.bus.emit(WorkflowSubjects.frame.started, {
        executionId,
        frameId: `${executionId}:advisory`,
        nodeId: 'advisory',
        nodeType: 'station',
        path: [`${executionId}:advisory`],
        startedAt,
      });
      await expect(first.bus.request(WorkflowStorageSubjects.settleExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      await first.bus.emit(WorkflowSubjects.frame.completed, {
        executionId,
        frameId: `${executionId}:advisory`,
        nodeId: 'advisory',
        duration: completedAt - startedAt,
        completedAt,
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

  it('preserves atomic registration fields against mismatched advisory starts', async () => {
    const executionId = `wfx-ext-start-isolation-${crypto.randomUUID()}`;
    const registration = buildRegistration(executionId);
    const storage = createWorkflowStorageBus(getCtx().db);
    try {
      await storage.bus.request(WorkflowStorageSubjects.setExternalExecutionStart, registration);
      await storage.bus.emit(WorkflowSubjects.execution.started, {
        executionId,
        workflowId: 'mismatched-advisory-workflow',
        startedAt: startedAt - 100,
      });
      await storage.bus.emit(WorkflowSubjects.frame.started, {
        executionId,
        frameId: registration.frame.frameId,
        nodeId: 'mismatched-advisory-node',
        nodeType: 'delegate-role',
        path: ['mismatched'],
        startedAt: startedAt - 100,
      });

      await expect(storage.bus.request(WorkflowSubjects.worklog.get, { executionId })).resolves.toMatchObject({
        summary: {
          workflowId: registration.execution.workflowId,
          status: 'running',
          startedAt: registration.execution.startedAt,
        },
      });
      await expect(
        storage.bus.request(WorkflowSubjects.worklog.frame.get, { frameId: registration.frame.frameId }),
      ).resolves.toMatchObject({
        frame: {
          nodeId: registration.frame.nodeId,
          nodeType: registration.frame.nodeType,
          path: registration.frame.path,
          status: 'running',
          startedAt: registration.frame.startedAt,
        },
      });
      await expect(
        storage.bus.request(WorkflowStorageSubjects.settleExternalExecution, buildFramedSettlement(executionId)),
      ).resolves.toEqual({ success: true });
    } finally {
      storage.cleanup();
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
