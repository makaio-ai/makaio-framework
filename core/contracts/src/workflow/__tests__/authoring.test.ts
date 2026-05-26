import { expect, it, describe } from 'vitest';
import { createBusNamespace } from '@makaio/core';
import type { ExtractSubjectResponse } from '@makaio/core';
import { z } from 'zod';
import {
  BusEventWorkflowTrigger,
  BusRequestStep,
  BusRequestStepFromBlock,
  CronWorkflowTrigger,
  ManualWorkflowTrigger,
  defineWorkflow,
} from '../authoring.js';
import {
  BusRequestWorkflowStepSchema,
  FunctionWorkflowStepSchema,
  PersistedWorkflowDefinitionInputSchema,
  WorkflowStepSchema,
} from '../schemas.js';
import type { WorkflowStepBlock } from '../blocks.js';

const GitNamespace = createBusNamespace('git', {
  checkout: z.object({
    isNewWorktree: z.boolean(),
    mainWorktree: z.string(),
    worktreePath: z.string(),
  }),
});

const GitHubAppTestNamespace = createBusNamespace('github:app', {
  'issue.create': {
    request: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      issueNumber: z.number().optional(),
    }),
    response: z.object({
      number: z.number(),
      htmlUrl: z.string(),
    }),
  },
});

const StatusTestNamespace = createBusNamespace('status:test', {
  'issue.update': {
    request: z.object({
      status: z.enum(['open', 'closed']),
    }),
    response: z.object({
      ok: z.boolean(),
    }),
  },
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

  it('WorkflowStepSchema accepts bus-request steps', () => {
    const result = WorkflowStepSchema.safeParse({
      type: 'bus-request',
      id: 'create-issue',
      subject: 'github:app.issue.create',
      payload: { owner: 'makaio-ai', repo: 'makaio', title: 'Plan' },
      timeoutMs: 10_000,
    });
    expect(result.success).toBe(true);
  });

  it('BusRequestWorkflowStepSchema rejects non-JSON payload values', () => {
    const result = BusRequestWorkflowStepSchema.safeParse({
      type: 'bus-request',
      id: 'bad-payload',
      subject: 'github:app.issue.create',
      payload: { invalid: () => undefined },
    });
    expect(result.success).toBe(false);
  });

  it('accepts bus-request steps for persisted workflow definitions', () => {
    const result = PersistedWorkflowDefinitionInputSchema.safeParse({
      id: 'stored-flow',
      name: 'Stored Flow',
      scope: { type: 'global' },
      steps: [
        {
          type: 'bus-request',
          id: 'create-issue',
          subject: 'github:app.issue.create',
          payload: { owner: '{{ inputs.owner }}', repo: '{{ inputs.repo }}', title: 'Plan' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('serializes typed bus request steps into the workflow definition', () => {
    const workflow = defineWorkflow('bus-request-flow');
    const created = workflow.addBusRequestStep(
      'create-issue',
      BusRequestStep({
        subject: GitHubAppTestNamespace.subjects.issue.create,
        payload: {
          owner: '{{ inputs.owner }}',
          repo: '{{ inputs.repo }}',
          title: 'Plan: {{ trigger.title }}',
          issueNumber: '{{ inputs.issueNumber }}',
        },
      }),
      { needs: [] },
    );

    expect(created.id).toBe('create-issue');
    expect(workflow.runtimeSteps.has('create-issue')).toBe(false);
    expect(workflow.definition.steps[0]).toMatchObject({
      type: 'bus-request',
      id: 'create-issue',
      subject: 'github:app.issue.create',
    });
  });

  it('detects duplicate IDs across function and schema-authored steps', () => {
    const workflow = defineWorkflow('dup-schema-flow');
    workflow.addBusRequestStep(
      'create-issue',
      BusRequestStep({
        subject: GitHubAppTestNamespace.subjects.issue.create,
        payload: { owner: 'a', repo: 'b', title: 'c' },
      }),
      { needs: [] },
    );

    expect(() => workflow.addStep('create-issue', () => null, { needs: [] })).toThrow(
      'Duplicate step ID: create-issue',
    );
  });

  it('carries bus request response type through StepRef needs', () => {
    const workflow = defineWorkflow('typed-bus-flow');
    const created = workflow.addBusRequestStep(
      'create-issue',
      BusRequestStep({
        subject: GitHubAppTestNamespace.subjects.issue.create,
        payload: { owner: 'a', repo: 'b', title: 'c' },
      }),
      { needs: [] },
    );

    workflow.addStep(
      'use-issue',
      (ctx) => {
        const previous = ctx.previousSteps['create-issue'];
        if (previous.status !== 'completed') return { issue: 0 };
        const number: ExtractSubjectResponse<typeof GitHubAppTestNamespace.subjects.issue.create>['number'] =
          previous.output.number;
        return { issue: number };
      },
      { needs: [created] },
    );

    expect(workflow.definition.steps.map((step) => step.id)).toEqual(['create-issue', 'use-issue']);
  });

  it('preserves literal unions while allowing whole-value template placeholders in typed bus requests', () => {
    BusRequestStep({
      subject: StatusTestNamespace.subjects.issue.update,
      payload: { status: 'open' },
    });

    BusRequestStep({
      subject: StatusTestNamespace.subjects.issue.update,
      payload: { status: '{{ inputs.status }}' },
    });

    BusRequestStep({
      subject: StatusTestNamespace.subjects.issue.update,
      payload: {
        // @ts-expect-error status only accepts declared literals or template placeholders.
        status: 'opened',
      },
    });

    expect(true).toBe(true);
  });

  it('compiles a bus-request workflow block run mapping into a concrete step', () => {
    const block: WorkflowStepBlock = {
      metadata: {
        name: 'github.create-issue',
        label: 'Create GitHub Issue',
        description: 'Creates an issue.',
      },
      configSchema: z.object({ owner: z.string(), repo: z.string() }),
      inputSchema: z.object({ title: z.string() }),
      outputSchema: z.object({ number: z.number(), htmlUrl: z.string() }),
      runs: {
        type: 'bus-request',
        subject: 'github:app.issue.create',
        payload: {
          owner: '{{ config.owner }}',
          repo: '{{ config.repo }}',
          title: '{{ input.title }}',
        },
      },
    };

    expect(
      BusRequestStepFromBlock(block, {
        config: { owner: 'makaio-ai', repo: 'makaio' },
        input: { title: 'Plan' },
      }),
    ).toEqual({
      type: 'bus-request',
      id: '',
      subject: 'github:app.issue.create',
      payload: {
        owner: 'makaio-ai',
        repo: 'makaio',
        title: 'Plan',
      },
    });
  });

  it('omits missing whole-value optional payload fields when compiling bus-request workflow blocks', () => {
    const block: WorkflowStepBlock = {
      metadata: {
        name: 'github.create-issue',
        label: 'Create GitHub Issue',
        description: 'Creates an issue.',
      },
      configSchema: z.object({ owner: z.string(), repo: z.string() }),
      inputSchema: z.object({
        title: z.string(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({ number: z.number(), htmlUrl: z.string() }),
      runs: {
        type: 'bus-request',
        subject: 'github:app.issue.create',
        payload: {
          owner: '{{ config.owner }}',
          repo: '{{ config.repo }}',
          title: '{{ input.title }}',
          body: '{{ input.body }}',
          labels: '{{ input.labels }}',
          assignees: '{{ input.assignees }}',
        },
      },
    };

    expect(
      BusRequestStepFromBlock(block, {
        config: { owner: 'makaio-ai', repo: 'makaio' },
        input: { title: 'Plan' },
      }),
    ).toEqual({
      type: 'bus-request',
      id: '',
      subject: 'github:app.issue.create',
      payload: {
        owner: 'makaio-ai',
        repo: 'makaio',
        title: 'Plan',
      },
    });
  });

  it('rejects unsupported config and input template expressions when compiling bus-request workflow blocks', () => {
    const block: WorkflowStepBlock = {
      metadata: {
        name: 'github.create-issue',
        label: 'Create GitHub Issue',
        description: 'Creates an issue.',
      },
      configSchema: z.object({ owner: z.string(), repo: z.string() }),
      inputSchema: z.object({ title: z.string() }),
      outputSchema: z.object({ number: z.number(), htmlUrl: z.string() }),
      runs: {
        type: 'bus-request',
        subject: 'github:app.issue.create',
        payload: {
          owner: '{{ config.owner }}',
          repo: '{{ config.repo }}',
          title: '{{ input.title | upper }}',
        },
      },
    };

    expect(() =>
      BusRequestStepFromBlock(block, {
        config: { owner: 'makaio-ai', repo: 'makaio' },
        input: { title: 'Plan' },
      }),
    ).toThrow(/Unsupported workflow block template.*input\.title \| upper.*plain dot-path/s);
  });
});
