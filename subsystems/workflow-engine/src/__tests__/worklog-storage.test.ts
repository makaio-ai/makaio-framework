import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { getWorklogFrameEntry, upsertWorklogFrameEntry } from '../worklog/worklog-storage.js';
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
      nodeId: 'implement',
      nodeType: 'station',
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
      nodeId: 'implement',
      nodeType: 'station',
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
});
