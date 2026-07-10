import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowNamespace } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace } from '../storage/namespace.js';
import { worklogFrameEntries, worklogSummaries } from '../storage/schema.js';
import { registerWorkflowStorageDelegationHandlers } from '../workflow-executor-handlers.js';
import { createTestDb, type TestDbContext } from './shared.js';

const registration = {
  executionId: 'wfx-ext-atomic-review-1',
  name: 'direct-review',
  startedAt: 1_000,
  scope: { type: 'external' as const, kind: 'workpiece', id: 'wp-1' },
  input: { repository: 'computeruniverse/ai-factory', workpieceId: 'wp-1' },
  frame: {
    nodeId: 'review',
    nodeType: 'delegate-role' as const,
    path: ['review'],
    startedAt: 1_000,
  },
};

const completion = {
  executionId: registration.executionId,
  status: 'completed' as const,
  completedAt: 1_250,
  frame: {
    frameId: `${registration.executionId}:review`,
    nodeId: 'review',
    nodeType: 'delegate-role' as const,
    path: ['review'],
    startedAt: 1_000,
    durationMs: 250,
  },
};

describe('atomic external execution WorkLog settlement', () => {
  let dbContext: TestDbContext;
  let delegationCleanups: Array<() => void>;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.registerNamespace(WorkflowNamespace);
    MakaioBus.registerNamespace(WorkflowStorageNamespace);
    dbContext = await createTestDb();
    delegationCleanups = registerWorkflowStorageDelegationHandlers(MakaioBus);
  });

  afterEach(() => {
    for (const cleanup of delegationCleanups) cleanup();
    dbContext.cleanup();
  });

  it('acknowledges registration only after execution, summary, and frame are durable', async () => {
    const result = await MakaioBus.request(WorkflowSubjects.registerExternalExecution, registration);

    expect(result).toEqual({
      executionId: registration.executionId,
      frameId: `${registration.executionId}:review`,
    });
    const summaries = await dbContext.db
      .select()
      .from(worklogSummaries)
      .where(eq(worklogSummaries.executionId, registration.executionId));
    const frames = await dbContext.db
      .select()
      .from(worklogFrameEntries)
      .where(eq(worklogFrameEntries.executionId, registration.executionId));
    expect(summaries).toEqual([
      expect.objectContaining({
        executionId: registration.executionId,
        workflowId: 'direct-review',
        status: 'running',
        startedAt: 1_000,
      }),
    ]);
    expect(frames).toEqual([
      expect.objectContaining({
        frameId: `${registration.executionId}:review`,
        nodeId: 'review',
        nodeType: 'delegate-role',
        path: ['review'],
        status: 'running',
        startedAt: 1_000,
      }),
    ]);
  });

  it('accepts an identical registration replay and rejects immutable conflicts', async () => {
    await MakaioBus.request(WorkflowSubjects.registerExternalExecution, registration);
    await expect(MakaioBus.request(WorkflowSubjects.registerExternalExecution, registration)).resolves.toEqual({
      executionId: registration.executionId,
      frameId: `${registration.executionId}:review`,
    });

    await expect(
      MakaioBus.request(WorkflowSubjects.registerExternalExecution, { ...registration, name: 'different-workflow' }),
    ).rejects.toThrow('registration conflicts');
    await expect(
      MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
        ...registration,
        frame: { ...registration.frame, nodeId: 'implement' },
      }),
    ).rejects.toThrow('frame metadata conflicts');
  });

  it('rolls back registration when a frame ID belongs to another execution', async () => {
    const sharedFrameId = 'external-shared-frame';
    await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      ...registration,
      frame: { ...registration.frame, frameId: sharedFrameId },
    });
    const conflictingExecutionId = 'wfx-ext-atomic-review-2';
    await expect(
      MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
        ...registration,
        executionId: conflictingExecutionId,
        frame: { ...registration.frame, frameId: sharedFrameId },
      }),
    ).rejects.toThrow('WorkLog frame conflicts');

    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, {
      executionId: conflictingExecutionId,
    });
    const { frame } = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, { frameId: sharedFrameId });
    expect(execution).toBeNull();
    expect(frame?.executionId).toBe(registration.executionId);
  });

  it('settles execution, summary, and frame atomically and accepts an identical replay', async () => {
    await MakaioBus.request(WorkflowSubjects.registerExternalExecution, registration);
    await expect(MakaioBus.request(WorkflowSubjects.completeExternalExecution, completion)).resolves.toEqual({
      success: true,
    });
    await expect(MakaioBus.request(WorkflowSubjects.completeExternalExecution, completion)).resolves.toEqual({
      success: true,
    });

    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, {
      executionId: registration.executionId,
    });
    const { frame } = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, {
      frameId: completion.frame.frameId,
    });
    const { summary } = await MakaioBus.request(WorkflowSubjects.worklog.get, {
      executionId: registration.executionId,
    });
    expect(execution).toMatchObject({ status: 'completed', completedAt: 1_250 });
    expect(summary).toMatchObject({
      workflowId: 'direct-review',
      status: 'completed',
      startedAt: 1_000,
      completedAt: 1_250,
      durationMs: 250,
    });
    expect(frame).toMatchObject({
      nodeId: 'review',
      nodeType: 'delegate-role',
      status: 'completed',
      startedAt: 1_000,
      completedAt: 1_250,
      durationMs: 250,
    });
  });

  it('keeps frame-less completion without a supplied timestamp idempotent', async () => {
    const executionId = 'wfx-ext-atomic-legacy-1';
    await MakaioBus.request(WorkflowSubjects.registerExternalExecution, {
      executionId,
      name: 'legacy-external-run',
      startedAt: 1_000,
    });
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, { executionId, status: 'completed' }),
    ).resolves.toEqual({ success: true });
    const first = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, { executionId, status: 'completed' }),
    ).resolves.toEqual({ success: true });
    const replay = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
    expect(replay.execution?.completedAt).toBe(first.execution?.completedAt);
  });

  it('rolls back conflicting terminal status or frame identity', async () => {
    await MakaioBus.request(WorkflowSubjects.registerExternalExecution, registration);
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        ...completion,
        frame: { ...completion.frame, nodeType: 'station' },
      }),
    ).rejects.toThrow('registered metadata');
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        ...completion,
        frame: { ...completion.frame, frameId: `${registration.executionId}:different` },
      }),
    ).rejects.toThrow('registered frame identity');
    const beforeSettlement = await MakaioBus.request(WorkflowSubjects.getExecution, {
      executionId: registration.executionId,
    });
    const summaryBeforeSettlement = await MakaioBus.request(WorkflowSubjects.worklog.get, {
      executionId: registration.executionId,
    });
    const frameBeforeSettlement = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, {
      frameId: completion.frame.frameId,
    });
    expect(beforeSettlement.execution?.status).toBe('running');
    expect(summaryBeforeSettlement.summary?.status).toBe('running');
    expect(frameBeforeSettlement.frame).toMatchObject({ nodeType: 'delegate-role', status: 'running' });

    await MakaioBus.request(WorkflowSubjects.completeExternalExecution, completion);
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        executionId: registration.executionId,
        status: 'failed',
        error: 'conflicting replay',
        completedAt: 1_250,
        frame: { ...completion.frame, nodeType: 'station' },
      }),
    ).rejects.toThrow('cannot transition from status "completed"');
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        ...completion,
        frame: { ...completion.frame, path: ['different'] },
      }),
    ).rejects.toThrow('registered metadata');
    await expect(
      MakaioBus.request(WorkflowSubjects.completeExternalExecution, {
        ...completion,
        completedAt: 1_251,
        frame: { ...completion.frame, durationMs: 251 },
      }),
    ).rejects.toThrow('existing terminal settlement');
  });

  it('does not let delayed advisory lifecycle events regress an acknowledged settlement', async () => {
    await MakaioBus.request(WorkflowSubjects.registerExternalExecution, registration);
    await MakaioBus.request(WorkflowSubjects.completeExternalExecution, completion);

    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId: registration.executionId,
      workflowId: 'stale-workflow',
      startedAt: 900,
    });
    await MakaioBus.emit(WorkflowSubjects.frame.started, {
      executionId: registration.executionId,
      frameId: completion.frame.frameId,
      nodeId: 'stale-node',
      nodeType: 'station',
      path: ['stale-node'],
      startedAt: 900,
    });
    await MakaioBus.emit(WorkflowSubjects.frame.failed, {
      executionId: registration.executionId,
      frameId: completion.frame.frameId,
      nodeId: 'stale-node',
      error: 'late failure',
      completedAt: 1_300,
    });
    await MakaioBus.emit(WorkflowSubjects.execution.failed, {
      executionId: registration.executionId,
      workflowId: 'stale-workflow',
      error: 'late failure',
      completedAt: 1_300,
    });
    await MakaioBus.emit(WorkflowSubjects.frame.completed, {
      executionId: registration.executionId,
      frameId: completion.frame.frameId,
      nodeId: 'review',
      duration: 400,
      completedAt: 1_400,
    });
    await MakaioBus.emit(WorkflowSubjects.execution.completed, {
      executionId: registration.executionId,
      workflowId: 'direct-review',
      totalDuration: 400,
      completedAt: 1_400,
    });

    const { summary } = await MakaioBus.request(WorkflowSubjects.worklog.get, {
      executionId: registration.executionId,
    });
    const { frame } = await MakaioBus.request(WorkflowSubjects.worklog.frame.get, {
      frameId: completion.frame.frameId,
    });
    expect(summary).toMatchObject({ workflowId: 'direct-review', status: 'completed', completedAt: 1_250 });
    expect(frame).toMatchObject({
      nodeId: 'review',
      nodeType: 'delegate-role',
      status: 'completed',
      completedAt: 1_250,
      durationMs: 250,
    });
  });
});
