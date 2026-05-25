import { expect, it, describe } from 'vitest';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { BusEventWorkflowTrigger, CronWorkflowTrigger, ManualWorkflowTrigger, defineWorkflow } from '../authoring.js';
import { FunctionWorkflowStepSchema, PersistedWorkflowDefinitionInputSchema, WorkflowStepSchema } from '../schemas.js';

const GitNamespace = createBusNamespace('git', {
  checkout: z.object({
    isNewWorktree: z.boolean(),
    mainWorktree: z.string(),
    worktreePath: z.string(),
  }),
});

describe('workflow authoring helpers', () => {
  it('serializes typed bus event triggers to workflow trigger schema', () => {
    const trigger = BusEventWorkflowTrigger({
      subject: GitNamespace.subjects.checkout,
      filter: { isNewWorktree: true },
    });

    expect(trigger.type).toBe('bus-event');
    expect(trigger.subject).toBe('git.checkout');
  });

  it('keeps concrete step output types through StepRef needs', async () => {
    const workflow = defineWorkflow('typed-flow', {
      name: 'Typed Flow',
      triggers: [ManualWorkflowTrigger()],
    });

    const firstStep = workflow.addStep('step-1', () => ({ message: 'Hello World' }), { needs: [] });
    workflow.addStep(
      'step-2',
      (ctx) => {
        const previous = ctx.previousSteps['step-1'];
        if (previous.status !== 'completed') {
          throw new Error('step-1 should have completed');
        }
        const message: string = previous.output.message;
        return { length: message.length };
      },
      { needs: [firstStep] },
    );

    expect(workflow.definition.steps.map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('preserves null step output types through StepRef needs', () => {
    const workflow = defineWorkflow('typed-null-flow');

    const nullableStep = workflow.addStep('nullable-step', (): null => null, { needs: [] });
    workflow.addStep(
      'uses-null',
      (ctx) => {
        const previous = ctx.previousSteps['nullable-step'];
        if (previous.status !== 'completed') {
          return { value: 'skipped' };
        }
        const value: null = previous.output;
        return { value };
      },
      { needs: [nullableStep] },
    );

    expect(workflow.definition.steps.map((step) => step.id)).toEqual(['nullable-step', 'uses-null']);
  });

  it('recovers trigger payload typing when a trigger is added after defineWorkflow', () => {
    const workflow = defineWorkflow('late-trigger-flow').addTrigger(
      BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout }),
    );

    workflow.addStep(
      'uses-trigger',
      (ctx) => {
        const worktreePath: string = ctx.trigger.worktreePath;
        return { worktreePath };
      },
      { needs: [] },
    );

    expect(workflow.definition.triggers).toHaveLength(1);
  });

  it('creates cron trigger payload metadata', () => {
    expect(CronWorkflowTrigger({ schedule: '0 9 * * 1' }).type).toBe('cron');
  });

  it('accepts optional options — defaults name to id when options are omitted', () => {
    const workflow = defineWorkflow('my-flow');
    expect(workflow.definition.name).toBe('my-flow');
    expect(workflow.definition.triggers).toEqual([]);
  });

  it('throws on duplicate step IDs', () => {
    const workflow = defineWorkflow('dup-flow');
    workflow.addStep('step-a', () => null, { needs: [] });
    expect(() => workflow.addStep('step-a', () => null, { needs: [] })).toThrow('Duplicate step ID: step-a');
  });

  it('FunctionWorkflowStepSchema validates function step shape', () => {
    const valid = FunctionWorkflowStepSchema.safeParse({ type: 'function', id: 'my-step', runtime: true });
    expect(valid.success).toBe(true);

    const missingRuntime = FunctionWorkflowStepSchema.safeParse({ type: 'function', id: 'my-step' });
    expect(missingRuntime.success).toBe(false);
  });

  it('WorkflowStepSchema accepts function steps', () => {
    const result = WorkflowStepSchema.safeParse({ type: 'function', id: 'fn-step', runtime: true });
    expect(result.success).toBe(true);
  });

  it('rejects function steps for persisted workflow definitions', () => {
    const result = PersistedWorkflowDefinitionInputSchema.safeParse({
      id: 'stored-flow',
      name: 'Stored Flow',
      scope: { type: 'global' },
      steps: [{ type: 'function', id: 'fn-step', runtime: true }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects nested function steps for persisted workflow definitions', () => {
    const result = PersistedWorkflowDefinitionInputSchema.safeParse({
      id: 'stored-flow',
      name: 'Stored Flow',
      scope: { type: 'global' },
      steps: [
        {
          type: 'for-each',
          id: 'loop',
          collection: 'inputs.items',
          steps: [{ type: 'function', id: 'nested-fn-step', runtime: true }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects runtime-only values in persisted JSON workflow surfaces', () => {
    const result = PersistedWorkflowDefinitionInputSchema.safeParse({
      id: 'stored-flow',
      name: 'Stored Flow',
      scope: { type: 'global' },
      triggers: [{ type: 'extension', extensionType: 'demo:event', config: { invalid: () => undefined } }],
      steps: [
        {
          type: 'agent',
          id: 'agent-step',
          prompt: 'Run',
          outputSchema: { invalid: () => undefined },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('addStep serializes function steps into the definition', () => {
    const workflow = defineWorkflow('fn-flow');
    workflow.addStep('compute', () => ({ value: 42 }), { needs: [] });
    const step = workflow.definition.steps[0];
    expect(step).toMatchObject({ type: 'function', id: 'compute', runtime: true });
    expect(workflow.runtimeSteps.has('compute')).toBe(true);
  });
});
