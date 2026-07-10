import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBusContext, createBusInstance } from '@makaio/bus-core';
import { WorkflowNamespace } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { workflowExecutions } from '../storage/schema.js';
import { buildExternalSettlementFingerprint } from '../storage/external-execution-settlement.js';
import { registerWorkflowStorageDelegationHandlers } from '../workflow-executor-handlers.js';
import { createTestDbForBus } from './shared.js';

const startedAt = 1_000;
const completedAt = 1_250;

/** Create an isolated workflow bus with public and storage namespaces registered. */
function createWorkflowTestBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  return bus;
}

/**
 * Build an exact terminal frame for a given external execution.
 * @param executionId - External execution identifier.
 */
function buildCompletionFrame(executionId: string) {
  return {
    frameId: `${executionId}:review`,
    nodeId: 'review',
    nodeType: 'delegate-role' as const,
    path: ['review'],
    startedAt,
    durationMs: completedAt - startedAt,
  };
}

/**
 * Run a test with isolated workflow storage and public delegation handlers.
 * @param test - Test body receiving the isolated bus and database handle.
 */
async function withWorkflowHarness(
  test: (
    bus: ReturnType<typeof createBusInstance>,
    db: Awaited<ReturnType<typeof createTestDbForBus>>['db'],
  ) => Promise<void>,
): Promise<void> {
  const bus = createWorkflowTestBus();
  const dbContext = await createTestDbForBus(bus);
  const cleanups = registerWorkflowStorageDelegationHandlers(bus);
  try {
    await test(bus, dbContext.db);
  } finally {
    cleanups.forEach((cleanup) => cleanup());
    dbContext.cleanup();
  }
}

describe('external execution settlement fingerprint', () => {
  it('includes immutable frame identity while excluding mutable usage totals', () => {
    const executionId = 'wfx-ext-fingerprint-shape';
    const settlement = {
      executionId,
      status: 'failed' as const,
      error: 'review failed',
      completedAt,
      frame: {
        executionId,
        frameId: `${executionId}:review`,
        nodeId: 'review',
        nodeType: 'delegate-role' as const,
        path: ['review'],
        status: 'failed' as const,
        attempt: 0,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        error: 'review failed',
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: 0.25,
      },
    };
    const fingerprint = buildExternalSettlementFingerprint(settlement, completedAt);

    expect(
      buildExternalSettlementFingerprint(
        {
          ...settlement,
          frame: { ...settlement.frame, inputTokens: 200, outputTokens: 75, estimatedCost: 0.5 },
        },
        completedAt,
      ),
    ).toBe(fingerprint);
    expect(
      buildExternalSettlementFingerprint(
        { ...settlement, frame: { ...settlement.frame, path: ['different'] } },
        completedAt,
      ),
    ).not.toBe(fingerprint);
  });

  it('keeps frame-less replay independent of a later advisory terminal frame', async () => {
    await withWorkflowHarness(async (bus, db) => {
      const executionId = 'wfx-ext-fingerprint-frame-less';
      const settlement = { executionId, status: 'completed' as const, completedAt };
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'frame-less-fingerprint',
        startedAt,
      });

      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });

      await bus.emit(WorkflowSubjects.frame.completed, {
        executionId,
        frameId: `${executionId}:advisory`,
        nodeId: 'advisory',
        duration: completedAt - startedAt,
        completedAt,
      });

      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      const [execution] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
      expect(execution?.externalSettlementFingerprint).toContain('"frame":null');
      await expect(
        bus.request(WorkflowSubjects.worklog.frame.get, { frameId: `${executionId}:advisory` }),
      ).resolves.toMatchObject({ frame: { status: 'completed' } });
    });
  });

  it('preserves the settlement fingerprint across generic execution upserts', async () => {
    await withWorkflowHarness(async (bus, db) => {
      const executionId = 'wfx-ext-fingerprint-generic-upsert';
      const settlement = { executionId, status: 'completed' as const, completedAt };
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'generic-upsert-fingerprint',
        startedAt,
      });
      await bus.request(WorkflowSubjects.completeExternalExecution, settlement);
      const [before] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
      expect(before?.externalSettlementFingerprint).not.toBeNull();

      await bus.request(WorkflowStorageSubjects.setExecution, {
        execution: {
          id: executionId,
          workflowId: 'generic-upsert-fingerprint',
          status: 'completed',
          inputs: {},
          startedAt,
          completedAt,
          scope: { type: 'global' },
        },
      });

      const [after] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
      expect(after?.externalSettlementFingerprint).toBe(before?.externalSettlementFingerprint);
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
    });
  });

  it('does not let mismatched advisory starts rewrite atomic registration fields', async () => {
    await withWorkflowHarness(async (bus) => {
      const executionId = 'wfx-ext-advisory-start-isolation';
      const frameId = `${executionId}:review`;
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'registered-workflow',
        startedAt,
        frame: {
          nodeId: 'review',
          nodeType: 'delegate-role',
          path: ['review'],
          startedAt,
        },
      });

      await bus.emit(WorkflowSubjects.execution.started, {
        executionId,
        workflowId: 'mismatched-advisory-workflow',
        startedAt: startedAt - 100,
      });
      await bus.emit(WorkflowSubjects.frame.started, {
        executionId,
        frameId,
        nodeId: 'mismatched-advisory-node',
        nodeType: 'station',
        path: ['mismatched'],
        startedAt: startedAt - 100,
      });

      await expect(bus.request(WorkflowSubjects.worklog.get, { executionId })).resolves.toMatchObject({
        summary: { workflowId: 'registered-workflow', status: 'running', startedAt },
      });
      await expect(bus.request(WorkflowSubjects.worklog.frame.get, { frameId })).resolves.toMatchObject({
        frame: {
          nodeId: 'review',
          nodeType: 'delegate-role',
          path: ['review'],
          status: 'running',
          startedAt,
        },
      });
      await expect(
        bus.request(WorkflowSubjects.completeExternalExecution, {
          executionId,
          status: 'completed',
          completedAt,
          frame: buildCompletionFrame(executionId),
        }),
      ).resolves.toEqual({ success: true });
    });
  });

  it('replays an authoritative frame despite extra advisory frames', async () => {
    await withWorkflowHarness(async (bus) => {
      const executionId = 'wfx-ext-extra-advisory-frame';
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'extra-advisory-frame',
        startedAt,
        frame: {
          nodeId: 'review',
          nodeType: 'delegate-role',
          path: ['review'],
          startedAt,
        },
      });
      await bus.emit(WorkflowSubjects.frame.started, {
        executionId,
        frameId: `${executionId}:advisory`,
        nodeId: 'advisory',
        nodeType: 'station',
        path: ['advisory'],
        startedAt,
      });
      const settlement = {
        executionId,
        status: 'completed' as const,
        completedAt,
        frame: buildCompletionFrame(executionId),
      };

      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      await bus.emit(WorkflowSubjects.frame.completed, {
        executionId,
        frameId: `${executionId}:advisory`,
        nodeId: 'advisory',
        duration: completedAt - startedAt,
        completedAt,
      });
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
    });
  });

  it('accepts the legacy advisory event sequence before authoritative settlement', async () => {
    await withWorkflowHarness(async (bus) => {
      const executionId = 'wfx-ext-fingerprint-legacy-events';
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'legacy-advisory-sequence',
        startedAt,
      });
      await bus.emit(WorkflowSubjects.execution.started, {
        executionId,
        workflowId: 'legacy-advisory-sequence',
        startedAt,
      });
      await bus.emit(WorkflowSubjects.frame.started, {
        executionId,
        frameId: `${executionId}:legacy`,
        nodeId: 'legacy',
        nodeType: 'station',
        path: ['legacy'],
        startedAt,
      });
      await bus.emit(WorkflowSubjects.frame.completed, {
        executionId,
        frameId: `${executionId}:legacy`,
        nodeId: 'legacy',
        duration: completedAt - startedAt,
        completedAt,
      });
      await bus.emit(WorkflowSubjects.execution.completed, {
        executionId,
        workflowId: 'legacy-advisory-sequence',
        totalDuration: completedAt - startedAt,
        completedAt,
      });

      const settlement = { executionId, status: 'completed' as const, completedAt };
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
    });
  });

  it('atomically adopts a frame-less fingerprint for migrated terminal rows', async () => {
    await withWorkflowHarness(async (bus, db) => {
      const executionId = 'wfx-ext-fingerprint-migrated';
      await bus.request(WorkflowStorageSubjects.setExecution, {
        execution: {
          id: executionId,
          workflowId: 'migrated-external-run',
          status: 'failed',
          inputs: {},
          error: 'legacy failure',
          startedAt,
          completedAt,
          scope: { type: 'global' },
        },
      });
      await bus.emit(WorkflowSubjects.frame.failed, {
        executionId,
        frameId: `${executionId}:advisory`,
        nodeId: 'advisory',
        error: 'legacy failure',
        duration: completedAt - startedAt,
        completedAt,
      });

      const settlement = {
        executionId,
        status: 'failed' as const,
        error: 'legacy failure',
      };
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      const [adopted] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
      expect(adopted?.externalSettlementFingerprint).toContain('"frame":null');
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, settlement)).resolves.toEqual({
        success: true,
      });
      await expect(
        bus.request(WorkflowSubjects.completeExternalExecution, {
          ...settlement,
          completedAt,
          frame: buildCompletionFrame(executionId),
        }),
      ).rejects.toThrow('settlement fingerprint');
    });
  });

  it('lets exactly one of concurrent framed and frame-less settlements choose the identity', async () => {
    await withWorkflowHarness(async (bus) => {
      const executionId = 'wfx-ext-fingerprint-concurrent';
      await bus.request(WorkflowSubjects.registerExternalExecution, {
        executionId,
        name: 'concurrent-settlement',
        startedAt,
        frame: {
          nodeId: 'review',
          nodeType: 'delegate-role',
          path: ['review'],
          startedAt,
        },
      });
      const frameLess = { executionId, status: 'completed' as const, completedAt };
      const framed = { ...frameLess, frame: buildCompletionFrame(executionId) };

      const results = await Promise.allSettled([
        bus.request(WorkflowSubjects.completeExternalExecution, framed),
        bus.request(WorkflowSubjects.completeExternalExecution, frameLess),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const framedWon = results[0]?.status === 'fulfilled';
      const winner = framedWon ? framed : frameLess;
      const loser = framedWon ? frameLess : framed;
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, winner)).resolves.toEqual({
        success: true,
      });
      await expect(bus.request(WorkflowSubjects.completeExternalExecution, loser)).rejects.toThrow(
        'settlement fingerprint',
      );
    });
  });
});
