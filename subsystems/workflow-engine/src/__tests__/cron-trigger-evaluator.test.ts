import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CronTriggerEvaluator, resolveCronTimezone } from '../cron-trigger-evaluator.js';
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

  it('schedules cron workflows and stops them on destroy', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-cron-schedule',
      scope: { type: 'external', kind: 'project', id: 'project-1' },
      triggers: [{ type: 'cron', schedule: '* * * * *' }],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await evaluator.init();

    expect(evaluator.activeJobCount()).toBe(1);

    evaluator.destroy();

    expect(evaluator.activeJobCount()).toBe(0);
  });

  it('defaults omitted cron trigger timezones to UTC', () => {
    expect(resolveCronTimezone(undefined)).toBe('UTC');
  });

  it('skips global-scope workflows to prevent multi-machine fan-out', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-cron-global',
      scope: { type: 'global' },
      triggers: [{ type: 'cron', schedule: '* * * * *' }],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await evaluator.init();
    expect(evaluator.activeJobCount()).toBe(0);
  });

  it('skips invalid cron trigger definitions instead of failing init', async () => {
    const invalidWorkflow = createWorkflowDefinition({
      id: 'workflow-invalid-chrono',
      scope: { type: 'external', kind: 'project', id: 'project-1' },
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
