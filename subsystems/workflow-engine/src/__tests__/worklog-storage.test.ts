import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  getWorklogFrameEntry,
  getWorklogSummary,
  reaggregateTokenTotals,
  upsertAdvisoryWorklogSummary,
  upsertWorklogFrameEntry,
} from '../worklog/worklog-storage.js';
import { createTestDb, createWorkflowExecution, type TestDbContext } from './shared.js';

describe('WorkLog storage', () => {
  let dbContext: TestDbContext;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: createWorkflowExecution({ id: 'exec-worklog-storage', workflowId: 'wf-worklog-storage' }),
    });
  });

  afterEach(() => {
    dbContext.cleanup();
  });

  it('maps a stored frame row to the public WorkLog frame contract', async () => {
    await upsertWorklogFrameEntry(dbContext.db, {
      executionId: 'exec-worklog-storage',
      frameId: 'frame-storage',
      nodeId: 'parallel-review',
      nodeType: 'parallel',
      path: ['frame-storage'],
      status: 'completed',
      attempt: 0,
      iteration: null,
      branchKey: null,
      startedAt: 500,
      completedAt: 900,
      durationMs: 400,
      inputTokens: null,
      outputTokens: null,
      estimatedCost: null,
      error: null,
    });

    await expect(getWorklogFrameEntry(dbContext.db, 'frame-storage')).resolves.toEqual({
      executionId: 'exec-worklog-storage',
      frameId: 'frame-storage',
      nodeId: 'parallel-review',
      nodeType: 'parallel',
      path: ['frame-storage'],
      status: 'completed',
      attempt: 0,
      startedAt: 500,
      completedAt: 900,
      durationMs: 400,
    });
  });

  it('returns null when the frame row does not exist', async () => {
    await expect(getWorklogFrameEntry(dbContext.db, 'frame-missing')).resolves.toBeNull();
  });

  it('does not let a stale lifecycle upsert overwrite freshly aggregated usage', async () => {
    await MakaioBus.emit(WorkflowSubjects.execution.started, {
      executionId: 'exec-worklog-storage',
      workflowId: 'wf-worklog-storage',
      startedAt: 500,
    });
    const staleSummary = await getWorklogSummary(dbContext.db, 'exec-worklog-storage');
    if (staleSummary === null) throw new Error('expected execution.started to create the WorkLog summary');

    await upsertWorklogFrameEntry(dbContext.db, {
      executionId: 'exec-worklog-storage',
      frameId: 'frame-usage-authority',
      nodeId: 'review',
      nodeType: 'station',
      path: ['frame-usage-authority'],
      status: 'completed',
      attempt: 0,
      iteration: null,
      branchKey: null,
      startedAt: 500,
      completedAt: 900,
      durationMs: 400,
      inputTokens: 37,
      outputTokens: 19,
      estimatedCost: 0.56,
      error: null,
    });
    await reaggregateTokenTotals(dbContext.db, 'exec-worklog-storage');

    await upsertAdvisoryWorklogSummary(dbContext.db, {
      executionId: staleSummary.executionId,
      workflowId: staleSummary.workflowId,
      workflowName: staleSummary.workflowName ?? null,
      status: 'completed',
      startedAt: staleSummary.startedAt,
      completedAt: 900,
      durationMs: 400,
      totalInputTokens: staleSummary.totalInputTokens ?? null,
      totalOutputTokens: staleSummary.totalOutputTokens ?? null,
      totalEstimatedCost: staleSummary.totalEstimatedCost ?? null,
      error: null,
      failedNodeId: null,
    });

    await expect(getWorklogSummary(dbContext.db, 'exec-worklog-storage')).resolves.toMatchObject({
      status: 'completed',
      totalInputTokens: 37,
      totalOutputTokens: 19,
      totalEstimatedCost: 0.56,
    });
  });
});
