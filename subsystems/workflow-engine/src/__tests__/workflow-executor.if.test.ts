import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('WorkflowExecutor — if conditional step execution', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
  });

  async function runWorkflowAndWait(workflowId: string): Promise<{
    executionId: string;
    completedSteps: string[];
    completedExecutions: string[];
  }> {
    const completedSteps: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.completed, (ctx) => {
        completedSteps.push(ctx.payload.stepId);
      }),
    );

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId, inputs: {} });
    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    return { executionId, completedSteps, completedExecutions };
  }

  it('runs step unconditionally when no if field is set', async () => {
    const workflow = createWorkflowDefinition({
      id: 'wf-if-no-condition',
      steps: [{ id: 'step1', type: 'agent' as const, prompt: 'Do work', adapter: 'claude-code' }],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId, completedSteps } = await runWorkflowAndWait(workflow.id);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['step1']?.status).toBe('completed');
    expect(completedSteps).toEqual(['step1']);
  });

  it('skips step when if evaluates to false, emits step.skipped event', async () => {
    const workflow = createWorkflowDefinition({
      id: 'wf-if-false',
      steps: [
        { id: 'step1', type: 'agent' as const, prompt: 'Should be skipped', if: 'false', adapter: 'claude-code' },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const skippedEvents: Array<{ stepId: string; condition: string | undefined }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.skipped, (ctx) => {
        skippedEvents.push({ stepId: ctx.payload.stepId, condition: ctx.payload.condition });
      }),
    );

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['step1']?.status).toBe('skipped');
    expect(execution?.steps['step1']?.completedAt).toEqual(expect.any(Number));

    expect(skippedEvents).toEqual([{ stepId: 'step1', condition: 'false' }]);
  });

  it('runs step when if evaluates to true', async () => {
    const workflow = createWorkflowDefinition({
      id: 'wf-if-true',
      steps: [{ id: 'step1', type: 'agent' as const, prompt: 'Should run', if: 'true', adapter: 'claude-code' }],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId, completedSteps } = await runWorkflowAndWait(workflow.id);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['step1']?.status).toBe('completed');
    expect(completedSteps).toEqual(['step1']);
  });

  it('skips step based on predecessor status: if: "steps.validate.status == \'completed\'"', async () => {
    // validate runs and completes → deploy should run
    const workflow = createWorkflowDefinition({
      id: 'wf-if-predecessor-completed',
      steps: [
        { id: 'validate', type: 'agent' as const, prompt: 'Validate', adapter: 'claude-code' },
        {
          id: 'deploy',
          type: 'agent' as const,
          prompt: 'Deploy',
          needs: ['validate'],
          if: "steps.validate.status == 'completed'",
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId, completedSteps } = await runWorkflowAndWait(workflow.id);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['validate']?.status).toBe('completed');
    expect(execution?.steps['deploy']?.status).toBe('completed');
    expect(completedSteps).toContain('validate');
    expect(completedSteps).toContain('deploy');
  });

  it('skips entire for-each when if evaluates to false, downstream runs', async () => {
    const workflow = createWorkflowDefinition({
      id: 'wf-foreach-if-false',
      steps: [
        {
          id: 'loop',
          type: 'for-each' as const,
          collection: 'trigger.items',
          if: 'false',
          steps: [{ id: 'process', type: 'agent' as const, prompt: 'Process', adapter: 'claude-code' }],
        },
        {
          id: 'downstream',
          type: 'agent' as const,
          prompt: 'Always run',
          needs: ['loop'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId, completedSteps } = await runWorkflowAndWait(workflow.id);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    // No expanded loop steps should exist in execution state
    expect(execution?.steps['loop.0.process']).toBeUndefined();
    // downstream should have completed with no for-each dependencies blocking it
    expect(execution?.steps['downstream']?.status).toBe('completed');
    expect(completedSteps).toEqual(['downstream']);
  });

  it('downstream step runs after dependency is skipped', async () => {
    // optional-step has if: false (skipped); downstream depends on optional-step
    const workflow = createWorkflowDefinition({
      id: 'wf-if-downstream-after-skip',
      steps: [
        {
          id: 'optional-step',
          type: 'agent' as const,
          prompt: 'Optional',
          if: 'false',
          adapter: 'claude-code',
        },
        {
          id: 'downstream',
          type: 'agent' as const,
          prompt: 'Always run',
          needs: ['optional-step'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const skippedSteps: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.skipped, (ctx) => {
        skippedSteps.push(ctx.payload.stepId);
      }),
    );

    const { executionId, completedSteps } = await runWorkflowAndWait(workflow.id);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['optional-step']?.status).toBe('skipped');
    expect(execution?.steps['downstream']?.status).toBe('completed');
    expect(skippedSteps).toEqual(['optional-step']);
    expect(completedSteps).toEqual(['downstream']);
  });
});
