import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CronTriggerEvaluator } from '../cron-trigger-evaluator.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDb, createWorkflowDefinition, type TestDbContext } from './shared.js';

describe('CronTriggerEvaluator', () => {
  let dbContext: TestDbContext;
  let evaluator: CronTriggerEvaluator;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
    evaluator = new CronTriggerEvaluator(MakaioBus);
  });

  afterEach(() => {
    evaluator.destroy();
    dbContext.cleanup();
  });

  it('skips invalid cron trigger definitions instead of failing init', async () => {
    const invalidWorkflow = createWorkflowDefinition({
      id: 'workflow-invalid-chrono',
      projectId: 'project-1',
      triggers: [
        {
          type: 'cron',
          schedule: '* * * * *',
          timezone: 'Invalid/Timezone',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, {
      workflow: invalidWorkflow,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(evaluator.init()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping invalid cron trigger'), expect.anything());
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('workflow-invalid-chrono'), expect.anything());
    } finally {
      warnSpy.mockRestore();
    }
  });
});
