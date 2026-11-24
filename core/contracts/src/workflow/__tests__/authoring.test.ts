import { expect, expectTypeOf, it, describe } from 'vitest';
import { createBusNamespace, getFullSubjectForSubjectDefinition } from '@makaio/core';
import { z } from 'zod';
import {
  AutomationWorkflowTrigger,
  BusEventWorkflowTrigger,
  CronWorkflowTrigger,
  defineWorkflow,
  codeStep,
  agentStep,
  iterate,
  iterateChain,
  loop,
} from '../authoring.js';
import {
  loop as rootLoop,
  LoopCheckOutputSchema as RootLoopCheckOutputSchema,
  WorkflowLoopNodeSchema as RootWorkflowLoopNodeSchema,
} from '../../index.js';
import type { WorkflowLoopNode, WorkflowParallelNode, WorkflowSequenceNode } from '../schemas.js';
import { WorkflowDefinitionSchema, WorkflowLoopNodeSchema } from '../schemas.js';
import { validateNoNestedLoops } from '../loop.js';
import { defineWorkflowBundle } from '../bundle.js';
import { defineAutomationTrigger } from '../../automation-trigger/definition.js';
import { payloadField } from '../authoring-triggers.js';
import type { ExtractTriggerPayload } from '../authoring-triggers.js';
import type { StepContext } from '../authoring-context.js';
import type {
  CodeStepLaunchInput,
  CodeStepLaunchResult,
  CodeStepRequestInput,
  CodeStepRequestResult,
} from '../code-step-context.js';

// @ts-expect-error Artifact writes use registered requests instead of an authoring context.
type _LegacyArtifactContext = import('../../index.js').ArtifactContext;
// @ts-expect-error State reads and writes use registered requests instead of an authoring context.
type _LegacyStateContext = import('../../index.js').WorkflowStateContext<unknown>;
// @ts-expect-error Code Step handlers receive StepContext instead of the host context.
type _LegacyWorkflowContext = import('../../index.js').WorkflowContext;

const GitNamespace = createBusNamespace('git', {
  checkout: z.object({
    isNewWorktree: z.boolean(),
    mainWorktree: z.string(),
    worktreePath: z.string(),
  }),
});

const ScalarNamespace = createBusNamespace('scalar', {
  changed: z.string(),
});

// ─────────────────────────────────────────────────────────────
// Trigger helpers
// ─────────────────────────────────────────────────────────────

describe('workflow trigger helpers', () => {
  it('serializes typed bus event triggers to an automation trigger binding', () => {
    const trigger = BusEventWorkflowTrigger({
      subject: GitNamespace.subjects.checkout,
      when: {
        $and: [
          payloadField<{ isNewWorktree: boolean }>('isNewWorktree', true),
          { $expr: "payload.mainWorktree == '/repos/makaio'" },
        ],
      },
    });

    expect(trigger).toEqual({
      kind: 'makaio.bus-event',
      params: { subject: getFullSubjectForSubjectDefinition(GitNamespace.subjects.checkout) },
      when: {
        $and: [
          { field: 'payload.isNewWorktree', operator: true },
          { $expr: "payload.mainWorktree == '/repos/makaio'" },
        ],
      },
    });
  });

  it('omits the when key when no condition is supplied', () => {
    expect(BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout })).toEqual({
      kind: 'makaio.bus-event',
      params: { subject: 'git.checkout' },
    });
  });

  it('does not add a when key to an automation trigger without a condition', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.plain',
      label: 'Plain',
      description: 'Emits nothing special.',
      categories: [],
      paramsSchema: z.object({}),
      eventSchema: z.object({ latencyMs: z.number() }),
      activate: async () => async () => undefined,
    });

    expect(AutomationWorkflowTrigger(definition, { params: {} })).not.toHaveProperty('when');
  });

  it('builds a payload field condition addressing payload.<path>', () => {
    type CheckoutPayload = { isNewWorktree: boolean; nested: { depth: number } };

    expect(payloadField<CheckoutPayload>('isNewWorktree', true)).toEqual({
      field: 'payload.isNewWorktree',
      operator: true,
    });
    expect(payloadField<CheckoutPayload>('nested.depth', { $exists: true })).toEqual({
      field: 'payload.nested.depth',
      operator: { $exists: true },
    });
  });

  it('rejects a payload path that is not part of the payload type at compile time', () => {
    // @ts-expect-error 'isNewWorktre' is not a path of the payload type
    const typo = payloadField<{ isNewWorktree: boolean }>('isNewWorktre', true);

    // The helper stays a pure string builder at runtime; the guard is the compile-time check.
    expect(typo.field).toBe('payload.isNewWorktre');
  });

  it('creates a cron trigger binding with a default timezone', () => {
    expect(CronWorkflowTrigger({ schedule: '0 9 * * 1' })).toEqual({
      kind: 'makaio.cron',
      params: { schedule: '0 9 * * 1', timezone: 'UTC' },
    });
  });

  it('honours an explicit cron timezone', () => {
    expect(CronWorkflowTrigger({ schedule: '0 9 * * 1', timezone: 'Europe/Berlin' }).params).toEqual({
      schedule: '0 9 * * 1',
      timezone: 'Europe/Berlin',
    });
  });

  it('rejects a cron binding that could never schedule', () => {
    // Authoring-time, not activation-time: an empty schedule or timezone would
    // otherwise persist a binding that fails only when a host activates it.
    expect(() => CronWorkflowTrigger({ schedule: '' })).toThrow();
    expect(() => CronWorkflowTrigger({ schedule: '0 9 * * 1', timezone: '' })).toThrow();
  });

  it('binds an arbitrary defined automation trigger and infers its event payload', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.pinged',
      label: 'Pinged',
      description: 'Emits a ping observation.',
      categories: ['demo'],
      paramsSchema: z.object({ endpoint: z.string(), retries: z.number().default(3) }),
      eventSchema: z.object({ latencyMs: z.number() }),
      activate: async () => async () => undefined,
    });

    const trigger = AutomationWorkflowTrigger(definition, {
      params: { endpoint: 'https://example.test' },
      when: payloadField<{ latencyMs: number }>('latencyMs', { $exists: true }),
    });

    expect(trigger).toEqual({
      kind: 'demo.pinged',
      params: { endpoint: 'https://example.test' },
      when: { field: 'payload.latencyMs', operator: { $exists: true } },
    });
    expectTypeOf<ExtractTriggerPayload<typeof trigger>>().toEqualTypeOf<{ latencyMs: number }>();
  });

  it('rejects params that violate the trigger parameter schema', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.pinged',
      label: 'Pinged',
      description: 'Emits a ping observation.',
      categories: [],
      paramsSchema: z.object({ endpoint: z.string().min(8) }),
      eventSchema: z.object({ latencyMs: z.number() }),
      activate: async () => async () => undefined,
    });

    expect(() => AutomationWorkflowTrigger(definition, { params: { endpoint: 'short' } })).toThrow();
  });

  it('persists detached schema input without applying transforms or defaults', () => {
    const definition = defineAutomationTrigger({
      kind: 'demo.normalized',
      label: 'Normalized',
      description: 'Normalizes activation parameters.',
      categories: [],
      paramsSchema: z.object({
        project: z.string().transform((value) => `${value}!`),
        retries: z.number().default(3),
      }),
      eventSchema: z.object({}),
      activate: async () => async () => undefined,
    });
    const params = { project: 'shop' };

    const trigger = AutomationWorkflowTrigger(definition, { params });
    params.project = 'changed';

    expect(trigger.params).toEqual({ project: 'shop' });
  });

  it('rejects scalar automation and bus-event payloads at the typed workflow authoring boundary', () => {
    const scalarDefinition = defineAutomationTrigger({
      kind: 'demo.scalar',
      label: 'Scalar',
      description: 'Generic scalar automation source.',
      categories: [],
      paramsSchema: z.object({}),
      eventSchema: z.string(),
      activate: async () => async () => undefined,
    });

    const assertRejectedAtCompileTime = (): void => {
      // @ts-expect-error Workflows require an object-root event schema.
      AutomationWorkflowTrigger(scalarDefinition, { params: {} });
      // @ts-expect-error A scalar bus subject cannot author a workflow binding.
      BusEventWorkflowTrigger({ subject: ScalarNamespace.subjects.changed });
    };

    expect(assertRejectedAtCompileTime).toBeTypeOf('function');
    expect(scalarDefinition.eventSchema.parse('event')).toBe('event');
  });
});

// ─────────────────────────────────────────────────────────────
// defineWorkflow — fluent primitive API
// ─────────────────────────────────────────────────────────────

describe('defineWorkflow', () => {
  it('produces a WorkflowDefinition with a root sequence', () => {
    const workflow = defineWorkflow('simple-flow', { name: 'Simple Flow' });
    expect(workflow.definition.id).toBe('simple-flow');
    expect(workflow.definition.root.type).toBe('sequence');
    expect(workflow.definition.root.nodes).toHaveLength(0);
  });

  it('defaults name to id when options are omitted', () => {
    const workflow = defineWorkflow('my-flow');
    expect(workflow.definition.id).toBe('my-flow');
    expect(workflow.definition.name).toBeUndefined();
  });

  it('defaults scope to global', () => {
    const workflow = defineWorkflow('scope-flow');
    expect(workflow.definition.scope).toEqual({ type: 'global' });
  });

  it('serializes a definition-owned success finalizer selector when configured', () => {
    const workflow = defineWorkflow('finalized-flow', { successFinalizerId: 'factory.workflow-success' });

    expect(workflow.definition.successFinalizerId).toBe('factory.workflow-success');
  });

  it('omits the success finalizer selector when it is not configured', () => {
    const workflow = defineWorkflow('unfinalized-flow');

    expect(workflow.definition).not.toHaveProperty('successFinalizerId');
  });

  it('copies the extensions option into the definition', () => {
    const extensions = { 'makaio.clients-core': { follow: true }, '@acme/review': [1, 'a'] };
    const workflow = defineWorkflow('extended-flow', { extensions });

    expect(workflow.definition.extensions).toEqual(extensions);
  });

  it('throws at the defineWorkflow call when an extension name is invalid', () => {
    expect(() => defineWorkflow('bad-extension-flow', { extensions: { 'a/b': { follow: true } } })).toThrow();
    expect(() => defineWorkflow('dot-segment-flow', { extensions: { '..': true } })).toThrow();
  });

  it('omits extensions from the definition when the option is not configured', () => {
    const workflow = defineWorkflow('plain-extension-flow');

    expect(workflow.definition).not.toHaveProperty('extensions');
  });

  it('does not expose extension or extensions methods on the builder', () => {
    const workflow = defineWorkflow('no-extension-method-flow');

    // The type check is the assertion for the builder's type: an unused `@ts-expect-error` fails it.
    // @ts-expect-error The builder has no `extension` member; extensions are an option of defineWorkflow.
    const extension: unknown = workflow.extension;
    // @ts-expect-error The builder has no `extensions` member; extensions are an option of defineWorkflow.
    const extensions: unknown = workflow.extensions;

    expect(extension).toBeUndefined();
    expect(extensions).toBeUndefined();
    expect(Reflect.get(workflow, 'extension')).not.toBeTypeOf('function');
    expect(Reflect.get(workflow, 'extensions')).not.toBeTypeOf('function');
  });

  it('does not expose a gate method on the builder', () => {
    const workflow = defineWorkflow('no-gate-method-flow');

    // @ts-expect-error The builder has no gate member.
    expect(workflow.gate).toBeUndefined();
  });

  it('codeStep appends code-step nodes to the root sequence', () => {
    const workflow = defineWorkflow('fn-flow');
    workflow.codeStep('compute', () => ({ value: 42 }));
    expect(workflow.definition.root.nodes).toHaveLength(1);
    const codeStepNode = workflow.definition.root.nodes[0];
    expect(codeStepNode?.type).toBe('code-step');
    expect(codeStepNode?.id).toBe('compute');
  });

  it('registers the handler in runtimeHandlers', () => {
    const workflow = defineWorkflow('fn-flow-3');
    workflow.codeStep('compute', () => ({ value: 42 }));
    expect(workflow.runtimeHandlers.has('compute')).toBe(true);
  });

  it('throws on duplicate code step IDs', () => {
    const workflow = defineWorkflow('dup-flow');
    workflow.codeStep('step-a', () => null);
    expect(() => workflow.codeStep('step-a', () => null)).toThrow('Duplicate step ID: step-a');
  });

  it('throws on duplicate IDs when addNode reuses an id already claimed by codeStep', () => {
    const workflow = defineWorkflow('dup-node-flow');
    workflow.codeStep('step-a', () => null);
    expect(() => workflow.addNode(agentStep('step-a', 'analyst'))).toThrow('Duplicate step ID: step-a');
  });

  it('throws on duplicate IDs when addNode is called twice with the same id', () => {
    const workflow = defineWorkflow('dup-addnode-flow');
    workflow.addNode(agentStep('step-a', 'analyst'));
    expect(() => workflow.addNode(agentStep('step-a', 'reviewer'))).toThrow('Duplicate step ID: step-a');
  });

  it('preserves typed trigger metadata when a trigger is added after defineWorkflow', () => {
    const trigger = BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout });
    const workflow = defineWorkflow('late-trigger-flow').addTrigger(trigger);

    expectTypeOf<ExtractTriggerPayload<typeof trigger>>().toEqualTypeOf<{
      isNewWorktree: boolean;
      mainWorktree: string;
      worktreePath: string;
    }>();
    workflow.codeStep('reads-workflow-identity', (ctx) => {
      expectTypeOf(ctx).not.toHaveProperty('trigger');
      return { workflowId: ctx.workflowId };
    });

    expect(workflow.definition.triggers).toEqual([trigger]);
  });

  it('accepts parallel nodes via addNode', () => {
    const workflow = defineWorkflow('parallel-flow');
    const secBranch: WorkflowSequenceNode = { id: 'sec-branch', type: 'sequence', nodes: [] };
    const perfBranch: WorkflowSequenceNode = { id: 'perf-branch', type: 'sequence', nodes: [] };
    const parallelNode: WorkflowParallelNode = {
      id: 'parallel-review',
      type: 'parallel',
      branches: { security: secBranch, performance: perfBranch },
    };
    workflow.addNode(parallelNode);

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('parallel');
  });

  it('serializes the definition as a JSON-safe tree (no functions)', () => {
    const workflow = defineWorkflow('json-safe-flow');
    workflow.codeStep('do-work', () => ({ done: true }));

    // The definition should be JSON-serializable (no functions)
    const serialized = JSON.stringify(workflow.definition);
    const parsed = JSON.parse(serialized) as unknown;
    expect(parsed).toBeDefined();
    expect((parsed as { id: string }).id).toBe('json-safe-flow');
  });
});

// ─────────────────────────────────────────────────────────────
// Fluent builder API
// ─────────────────────────────────────────────────────────────

describe('fluent builder — input/config/output schemas', () => {
  it('captures input schema in zodSchemas and converts to JSON Schema in definition', () => {
    const InputSchema = z.object({ env: z.string() });
    const workflow = defineWorkflow('schema-flow').input(InputSchema);

    expect(workflow.zodSchemas.input).toBe(InputSchema);
    expect(workflow.definition.inputSchema).toBeDefined();
    expect(workflow.definition.inputSchema?.type).toBe('object');
  });

  it('captures config schema in zodSchemas and converts to JSON Schema in definition', () => {
    const ConfigSchema = z.object({ maxRetries: z.number().int() });
    const workflow = defineWorkflow('config-flow').config(ConfigSchema);

    expect(workflow.zodSchemas.config).toBe(ConfigSchema);
    expect(workflow.definition.configSchema).toBeDefined();
    expect(workflow.definition.configSchema?.type).toBe('object');
  });

  it('captures output schema in zodSchemas and converts to JSON Schema in definition', () => {
    const OutputSchema = z.object({ approved: z.boolean() });
    const workflow = defineWorkflow('output-flow').output(OutputSchema);

    expect(workflow.zodSchemas.output).toBe(OutputSchema);
    expect(workflow.definition.outputSchema).toBeDefined();
  });

  it('the JSON Schema stored in definition contains no functions', () => {
    const workflow = defineWorkflow('no-fn-schema')
      .input(z.object({ query: z.string() }))
      .output(z.object({ result: z.string() }));

    const serialized = JSON.stringify(workflow.definition);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});

describe('fluent builder — artifact binding', () => {
  it('captures artifact Zod schema in zodSchemas', () => {
    const ArtifactSchema = z.object({ review: z.string() });
    const workflow = defineWorkflow('artifact-flow').artifact({
      kind: 'implementation-review',
      schemaVersion: 1,
      scope: { level: 'global' },
      schema: ArtifactSchema,
    });

    expect(workflow.zodSchemas.artifact).toBe(ArtifactSchema);
  });

  it('writes artifact binding to definition.artifact', () => {
    const workflow = defineWorkflow('artifact-def-flow').artifact({
      kind: 'report',
      schemaVersion: 2,
      scope: { level: 'global' },
    });

    expect(workflow.definition.artifact).toBeDefined();
    expect(workflow.definition.artifact?.kind).toBe('report');
    expect(workflow.definition.artifact?.schemaVersion).toBe(2);
  });

  it('serializes artifact resolution and status options', () => {
    const workflow = defineWorkflow('artifact-options-flow').artifact({
      kind: 'report',
      schemaVersion: 2,
      scope: { level: 'global' },
      resolve: 'inputs.reportRef',
      create: '{ title: inputs.title, status: "draft" }',
      statusPath: 'status',
    });

    expect(workflow.definition.artifact).toEqual({
      kind: 'report',
      schemaVersion: 2,
      scope: { level: 'global' },
      resolve: 'inputs.reportRef',
      create: '{ title: inputs.title, status: "draft" }',
      statusPath: 'status',
    });
  });

  it('does not require a Zod schema for artifact', () => {
    const workflow = defineWorkflow('artifact-no-schema').artifact({
      kind: 'summary',
      schemaVersion: 1,
      scope: { level: 'global' },
    });

    expect(workflow.zodSchemas.artifact).toBeUndefined();
    expect(workflow.definition.artifact?.kind).toBe('summary');
  });
});

describe('fluent builder — state declarations', () => {
  interface ReviewState {
    tier: 'T0' | 'T1' | 'T2' | 'T3';
    selectedReviewers: string[];
  }

  const ReviewStateSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] },
      selectedReviewers: { type: 'array', items: { type: 'string' } },
    },
    required: ['tier', 'selectedReviewers'],
  } as const;

  it('stores a typed workflow state declaration while keeping step data independent', () => {
    const workflow = defineWorkflow('typed-state-flow')
      .state<ReviewState>({
        schema: ReviewStateSchema,
        initial: { tier: 'T1', selectedReviewers: [] },
      })
      .codeStep('select-reviewer', (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<StepContext>();
        expectTypeOf(ctx).not.toHaveProperty('state');
        return { workflowId: ctx.workflowId };
      });

    expectTypeOf<Parameters<typeof workflow.state<ReviewState>>[0]['initial']>().toEqualTypeOf<
      ReviewState | undefined
    >();
    expect(workflow.definition.state).toEqual({
      schema: ReviewStateSchema,
      initial: { tier: 'T1', selectedReviewers: [] },
    });
  });

  it('preserves the state declaration when a trigger is added', () => {
    const trigger = BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout });
    const workflow = defineWorkflow('state-then-trigger-flow')
      .state<ReviewState>({
        schema: ReviewStateSchema,
        initial: { tier: 'T2', selectedReviewers: [] },
      })
      .addTrigger(trigger);

    expect(workflow.definition.state).toEqual({
      schema: ReviewStateSchema,
      initial: { tier: 'T2', selectedReviewers: [] },
    });
    expect(workflow.definition.triggers).toEqual([trigger]);
  });
});

describe('fluent builder — code step nodes', () => {
  it('uses the same restricted context for fluent, standalone, and iterate handlers', () => {
    const workflow = defineWorkflow('no-state-flow').codeStep('do-work', (ctx) => {
      expectTypeOf<keyof typeof ctx>().toEqualTypeOf<
        | 'executionId'
        | 'workflowId'
        | 'inputs'
        | 'config'
        | 'previousSteps'
        | 'item'
        | 'index'
        | 'previous'
        | 'signal'
        | 'request'
        | 'launchProcess'
      >();
      expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
      expectTypeOf(ctx.request).toEqualTypeOf<(input: CodeStepRequestInput) => Promise<CodeStepRequestResult>>();
      expectTypeOf(ctx.launchProcess).toEqualTypeOf<(input: CodeStepLaunchInput) => Promise<CodeStepLaunchResult>>();
      return { workflowId: ctx.workflowId };
    });

    type Handler = Parameters<typeof workflow.codeStep>[1];
    expectTypeOf<Parameters<typeof codeStep>[1]>().toEqualTypeOf<Handler>();
    expectTypeOf<Parameters<typeof workflow.iterate>[1]>().toEqualTypeOf<Handler>();
    expectTypeOf<Parameters<typeof iterate>[1]>().toEqualTypeOf<Handler>();
    expect(workflow.runtimeHandlers.has('do-work')).toBe(true);
  });

  it('appends a code-step node to the root sequence', () => {
    const handler = () => ({ done: true }) as const;
    const workflow = defineWorkflow('code-step-flow').codeStep('do-work', handler);

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.id).toBe('do-work');
    expect(node?.type).toBe('code-step');
  });

  it('registers the handler in runtimeHandlers', () => {
    const handler = () => ({ done: true }) as const;
    const workflow = defineWorkflow('handler-flow').codeStep('do-work', handler);

    expect(workflow.runtimeHandlers.has('do-work')).toBe(true);
    expect(workflow.runtimeHandlers.get('do-work')).toBe(handler);
  });

  it('applies when/skip conditions to code step nodes', () => {
    const workflow = defineWorkflow('cond-flow').codeStep('conditional', () => null, {
      when: "ctx.inputs.run == 'true'",
      skip: "ctx.inputs.skip == 'true'",
    });

    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.run == 'true'");
    expect(node?.skip).toBe("ctx.inputs.skip == 'true'");
  });

  it('code-step node in definition does not contain function bodies', () => {
    const workflow = defineWorkflow('no-fn-code-step').codeStep('work', () => null);
    const serialized = JSON.stringify(workflow.definition);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain('function');
  });

  it('throws on duplicate code step IDs', () => {
    expect(() =>
      defineWorkflow('dup-code-step')
        .codeStep('a', () => null)
        .codeStep('a', () => null),
    ).toThrow('Duplicate step ID: a');
  });
});

describe('fluent builder — agentStep nodes', () => {
  it('appends an agent-step node with the given role', () => {
    const workflow = defineWorkflow('agent-step-flow').agentStep('review', 'code-reviewer');

    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('agent-step');
    expect(node?.id).toBe('review');
    expect((node as { role?: string }).role).toBe('code-reviewer');
  });

  it('defaults prompt to node ID when not provided', () => {
    const workflow = defineWorkflow('role-prompt-default').agentStep('analyze', 'analyst');
    const node = workflow.definition.root.nodes[0];
    expect((node as { prompt?: string }).prompt).toBe('analyze');
  });

  it('accepts a custom prompt override', () => {
    const workflow = defineWorkflow('role-prompt-override').agentStep('analyze', 'analyst', {
      prompt: 'Perform a detailed analysis',
    });
    const node = workflow.definition.root.nodes[0];
    expect((node as { prompt?: string }).prompt).toBe('Perform a detailed analysis');
  });

  it('preserves agent step schema, timeout, and completion settings', () => {
    const outputSchema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
    };
    const workflow = defineWorkflow('role-contract-options').agentStep('review', 'analyst', {
      outputSchema,
      timeoutMs: 120_000,
      completion: 'turn',
      allowedTools: ['artifact.read'],
      resultFinalizerId: 'artifact.read-wrap',
    });

    expect(workflow.definition.root.nodes[0]).toMatchObject({
      type: 'agent-step',
      outputSchema,
      timeoutMs: 120_000,
      completion: 'turn',
      allowedTools: ['artifact.read'],
      resultFinalizerId: 'artifact.read-wrap',
    });
  });
});

describe('fluent builder — parallel nodes', () => {
  it('appends a parallel node with branches from standalone factories', () => {
    const workflow = defineWorkflow('parallel-fluent').parallel('reviews', { mode: 'all-settled' }, [
      codeStep('spec-review', () => null),
      agentStep('quality-review', 'code-reviewer'),
    ]);

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('parallel');
    expect(node?.id).toBe('reviews');
  });

  it('creates one branch per entry in the branches array', () => {
    const workflow = defineWorkflow('parallel-branches').parallel('par', {}, [
      codeStep('step-a', () => null),
      codeStep('step-b', () => null),
    ]);

    const node = workflow.definition.root.nodes[0];
    const parallelNode = node as { branches?: Record<string, unknown> };
    expect(Object.keys(parallelNode.branches ?? {})).toHaveLength(2);
  });

  it('parallel node definition is JSON-serializable', () => {
    const workflow = defineWorkflow('parallel-serializable').parallel('par', {}, [codeStep('x', () => null)]);
    expect(() => JSON.stringify(workflow.definition)).not.toThrow();
  });

  it('serializes all-settled as the default parallel mode', () => {
    const workflow = defineWorkflow('parallel-default-mode').parallel('par', {}, [codeStep('x', () => null)]);
    const node = workflow.definition.root.nodes[0];
    expect((node as WorkflowParallelNode | undefined)?.mode).toBe('all-settled');
  });

  it('serializes fail-fast parallel mode', () => {
    const workflow = defineWorkflow('parallel-fail-fast').parallel('par', { mode: 'fail-fast' }, [
      codeStep('x', () => null),
    ]);
    const node = workflow.definition.root.nodes[0];
    expect((node as WorkflowParallelNode | undefined)?.mode).toBe('fail-fast');
  });

  it('registers handlers from standalone codeStep() branches in runtimeHandlers', () => {
    const specHandler = () => ({ ok: true }) as const;
    const workflow = defineWorkflow('parallel-handler-reg').parallel('reviews', { mode: 'all-settled' }, [
      codeStep('spec-review', specHandler),
      agentStep('quality-review', 'code-reviewer'),
    ]);

    expect(workflow.runtimeHandlers.has('spec-review')).toBe(true);
    expect(workflow.runtimeHandlers.get('spec-review')).toBe(specHandler);
    // agent-step nodes have no handler
    expect(workflow.runtimeHandlers.has('quality-review')).toBe(false);
  });

  it('registers standalone iterate branch handlers under executable body code steps', () => {
    const handler = () => ({ processed: true }) as const;
    const workflow = defineWorkflow('parallel-iterate-handler-reg').parallel('fanout', {}, [
      iterate('loop', handler, { collection: 'ctx.inputs.items' }),
    ]);

    const parallelNode = workflow.definition.root.nodes[0] as WorkflowParallelNode | undefined;
    const branchNode = parallelNode?.branches['loop']?.nodes[0];
    const body = (branchNode as { body?: { nodes?: { id: string; type: string }[] } } | undefined)?.body;
    expect(body?.nodes).toEqual([{ id: 'loop__item', type: 'code-step' }]);
    expect(workflow.runtimeHandlers.get('loop__item')).toBe(handler);
    expect(workflow.runtimeHandlers.has('loop')).toBe(false);
  });

  it('throws on duplicate branch IDs when parallel() branch reuses an existing id', () => {
    const workflow = defineWorkflow('parallel-dup-branch');
    workflow.codeStep('existing', () => null);
    expect(() => workflow.parallel('par', {}, [codeStep('existing', () => null)])).toThrow(
      'Duplicate step ID: existing',
    );
  });

  it('throws when a synthesized parallel branch sequence ID reuses an existing ID', () => {
    const workflow = defineWorkflow('parallel-dup-branch-sequence');
    workflow.codeStep('fanout__review', () => null);
    expect(() => workflow.parallel('fanout', {}, [codeStep('review', () => null)])).toThrow(
      'Duplicate step ID: fanout__review',
    );
  });
});

describe('fluent builder — iterate nodes', () => {
  it('appends an iterate node to the root sequence', () => {
    const handler = () => ({ processed: true }) as const;
    const workflow = defineWorkflow('iterate-flow').iterate('process-items', handler, {
      collection: 'ctx.inputs.items',
    });

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('iterate');
    expect(node?.id).toBe('process-items');
  });

  it('sets collection expression on the iterate node', () => {
    const workflow = defineWorkflow('iterate-collection').iterate('loop', () => null, {
      collection: 'ctx.outputs.list',
    });

    const node = workflow.definition.root.nodes[0];
    expect((node as { collection?: string }).collection).toBe('ctx.outputs.list');
  });

  it('iterate node body contains a code step wrapping the handler', () => {
    const workflow = defineWorkflow('iterate-body').iterate('loop', () => null, {
      collection: 'ctx.inputs.items',
    });

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: { type: string }[] } }).body;
    expect(body?.nodes?.[0]?.type).toBe('code-step');
  });

  it('registers the handler in runtimeHandlers', () => {
    const handler = () => null;
    const workflow = defineWorkflow('iterate-handler').iterate('loop', handler, {
      collection: 'ctx.inputs.items',
    });
    // The handler is registered under a synthetic code step ID
    expect(workflow.runtimeHandlers.size).toBe(1);
  });

  it('iterate node is JSON-serializable', () => {
    const workflow = defineWorkflow('iterate-serial').iterate('loop', () => null, {
      collection: 'ctx.inputs.items',
    });
    expect(() => JSON.stringify(workflow.definition)).not.toThrow();
  });

  it('throws when a synthesized iterate body sequence ID reuses an existing ID', () => {
    const workflow = defineWorkflow('iterate-dup-body-sequence');
    workflow.codeStep('loop__body', () => null);
    expect(() =>
      workflow.iterate('loop', () => null, {
        collection: 'ctx.inputs.items',
      }),
    ).toThrow('Duplicate step ID: loop__body');
  });
});

describe('fluent builder — iterateChain nodes', () => {
  it('appends an iterate-chain node to the root sequence', () => {
    const chain = [codeStep('step-a', () => null), agentStep('step-b', 'analyst')];
    const workflow = defineWorkflow('iterate-chain-flow').iterateChain('chain-loop', chain, {
      collection: 'ctx.inputs.items',
    });

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('iterate-chain');
  });

  it('stores the sub-chain nodes in body.nodes', () => {
    const chain = [codeStep('step-a', () => null), codeStep('step-b', () => null)];
    const workflow = defineWorkflow('iterate-chain-body').iterateChain('chain', chain, {
      collection: 'ctx.inputs.items',
    });

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: unknown[] } }).body;
    expect(body?.nodes).toHaveLength(2);
  });

  it('iterate-chain body sub-chain is introspectable', () => {
    const chain = [codeStep('review', () => null), agentStep('apply', 'coder')];
    const workflow = defineWorkflow('iterate-chain-introspect').iterateChain('chain', chain, {
      collection: 'ctx.inputs.items',
    });

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: { id: string; type: string }[] } }).body;
    expect(body?.nodes?.[0]?.id).toBe('review');
    expect(body?.nodes?.[1]?.id).toBe('apply');
    expect(body?.nodes?.[1]?.type).toBe('agent-step');
  });

  it('iterate-chain node is JSON-serializable', () => {
    const workflow = defineWorkflow('iterate-chain-serial').iterateChain('chain', [codeStep('s', () => null)], {
      collection: 'ctx.inputs.items',
    });
    expect(() => JSON.stringify(workflow.definition)).not.toThrow();
  });

  it('registers handlers from standalone codeStep() nodes in the chain in runtimeHandlers', () => {
    const reviewHandler = () => ({ reviewed: true }) as const;
    const workflow = defineWorkflow('iterate-chain-handler-reg').iterateChain(
      'process',
      [codeStep('review', reviewHandler), agentStep('apply', 'coder')],
      { collection: 'ctx.inputs.items' },
    );

    expect(workflow.runtimeHandlers.has('review')).toBe(true);
    expect(workflow.runtimeHandlers.get('review')).toBe(reviewHandler);
    // agent-step nodes have no handler
    expect(workflow.runtimeHandlers.has('apply')).toBe(false);
  });

  it('throws on duplicate IDs when iterateChain() chain reuses an existing id', () => {
    const workflow = defineWorkflow('iterate-chain-dup');
    workflow.codeStep('existing', () => null);
    expect(() =>
      workflow.iterateChain('chain', [codeStep('existing', () => null)], {
        collection: 'ctx.inputs.items',
      }),
    ).toThrow('Duplicate step ID: existing');
  });

  it('throws when a synthesized iterate-chain body sequence ID reuses an existing ID', () => {
    const workflow = defineWorkflow('iterate-chain-dup-body-sequence');
    workflow.codeStep('chain__body', () => null);
    expect(() =>
      workflow.iterateChain('chain', [codeStep('step-a', () => null)], {
        collection: 'ctx.inputs.items',
      }),
    ).toThrow('Duplicate step ID: chain__body');
  });
});

describe('fluent builder — full chain', () => {
  const InputSchema = z.object({ items: z.array(z.string()) });
  const ConfigSchema = z.object({ maxRetries: z.number().int() });
  const OutputSchema = z.object({ processed: z.boolean() });
  const ArtifactSchema = z.object({ summary: z.string() });

  const analyzeHandler = () => ({ findings: [] }) as const;
  const applyHandler = () => ({ done: true }) as const;

  const workflow = defineWorkflow('full-chain-flow')
    .input(InputSchema)
    .config(ConfigSchema)
    .artifact({ kind: 'review', schemaVersion: 1, scope: { level: 'global' }, schema: ArtifactSchema })
    .parallel('reviews', { mode: 'all-settled' }, [
      codeStep('spec-review', () => null),
      agentStep('quality-review', 'code-reviewer'),
    ])
    .codeStep('analyze', analyzeHandler)
    .iterateChain('apply', [codeStep('apply-item', applyHandler)], { collection: 'ctx.outputs.findings' })
    .output(OutputSchema);

  it('produces correct node count in root sequence', () => {
    expect(workflow.definition.root.nodes).toHaveLength(3);
  });

  it('has correct node types in order', () => {
    const types = workflow.definition.root.nodes.map((n) => n.type);
    expect(types).toEqual(['parallel', 'code-step', 'iterate-chain']);
  });

  it('definition is fully JSON-serializable (no functions)', () => {
    const serialized = JSON.stringify(workflow.definition);
    expect(() => JSON.parse(serialized)).not.toThrow();
    // Verify no function strings leaked
    expect(serialized).not.toContain('"function"');
  });

  it('zodSchemas contains all expected schemas', () => {
    expect(workflow.zodSchemas.input).toBe(InputSchema);
    expect(workflow.zodSchemas.config).toBe(ConfigSchema);
    expect(workflow.zodSchemas.output).toBe(OutputSchema);
    expect(workflow.zodSchemas.artifact).toBe(ArtifactSchema);
  });

  it('runtimeHandlers contains builder code step handler and standalone factory handlers', () => {
    // builder .codeStep() registers directly
    expect(workflow.runtimeHandlers.has('analyze')).toBe(true);
    expect(workflow.runtimeHandlers.get('analyze')).toBe(analyzeHandler);
    // standalone codeStep() inside parallel() — handler must be extracted
    expect(workflow.runtimeHandlers.has('spec-review')).toBe(true);
    // standalone codeStep() inside iterateChain() — handler must be extracted
    expect(workflow.runtimeHandlers.has('apply-item')).toBe(true);
    expect(workflow.runtimeHandlers.get('apply-item')).toBe(applyHandler);
  });

  it('runtimeHandlers does not contain agent-step entries', () => {
    expect(workflow.runtimeHandlers.has('quality-review')).toBe(false);
  });

  it('runtimeFactories is empty while v1 topology is static', () => {
    expect(workflow.runtimeFactories.size).toBe(0);
  });
});

describe('fluent builder — Resolvable<T> in when/skip conditions', () => {
  it('accepts a when jexl expression on code step', () => {
    const workflow = defineWorkflow('when-flow').codeStep('step', () => null, {
      when: "ctx.inputs.enabled == 'true'",
    });
    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.enabled == 'true'");
  });

  it('accepts a skip jexl expression on code step', () => {
    const workflow = defineWorkflow('skip-flow').codeStep('step', () => null, {
      skip: "ctx.inputs.skip == 'true'",
    });
    const node = workflow.definition.root.nodes[0];
    expect(node?.skip).toBe("ctx.inputs.skip == 'true'");
  });

  it('accepts when on agentStep node', () => {
    const workflow = defineWorkflow('when-role').agentStep('review', 'analyst', {
      when: "ctx.inputs.mode == 'full'",
    });
    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.mode == 'full'");
  });

  it('accepts when on parallel node', () => {
    const workflow = defineWorkflow('when-parallel').parallel('par', { when: "ctx.inputs.parallel == 'true'" }, [
      codeStep('x', () => null),
    ]);
    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.parallel == 'true'");
  });
});

// ─────────────────────────────────────────────────────────────
// Standalone node factory functions
// ─────────────────────────────────────────────────────────────

describe('standalone factory — codeStep()', () => {
  it('creates a code-step node with the correct shape', () => {
    const node = codeStep('my-step', () => null);
    expect(node.id).toBe('my-step');
    expect(node.type).toBe('code-step');
    expect(node).not.toHaveProperty('prompt');
  });

  it('applies when/skip options', () => {
    const node = codeStep('s', () => null, { when: 'x', skip: 'y' });
    expect(node.when).toBe('x');
    expect(node.skip).toBe('y');
  });

  it('returns a JSON-serializable node', () => {
    const node = codeStep('s', () => null);
    expect(() => JSON.stringify(node)).not.toThrow();
  });
});

describe('standalone factory — agentStep()', () => {
  it('creates an agent-step node', () => {
    const node = agentStep('review', 'code-reviewer');
    expect(node.id).toBe('review');
    expect(node.type).toBe('agent-step');
    expect(node.role).toBe('code-reviewer');
    expect(node.prompt).toBe('review');
  });

  it('accepts a custom prompt', () => {
    const node = agentStep('r', 'analyst', { prompt: 'Custom prompt' });
    expect(node.prompt).toBe('Custom prompt');
  });

  it('preserves schema, timeout, and completion settings', () => {
    const outputSchema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    };
    const node = agentStep('r', 'analyst', {
      outputSchema,
      timeoutMs: 45_000,
      completion: 'turn',
      allowedTools: ['artifact.read'],
      resultFinalizerId: 'artifact.read-wrap',
    });

    expect(node.outputSchema).toBe(outputSchema);
    expect(node.timeoutMs).toBe(45_000);
    expect(node.completion).toBe('turn');
    expect(node.allowedTools).toEqual(['artifact.read']);
    expect(node.resultFinalizerId).toBe('artifact.read-wrap');
  });
});

describe('standalone factory — iterate()', () => {
  it('creates an iterate node', () => {
    const node = iterate('loop', () => null, { collection: 'ctx.inputs.items' });
    expect(node.id).toBe('loop');
    expect(node.type).toBe('iterate');
    expect(node.collection).toBe('ctx.inputs.items');
  });

  it('sets concurrency when provided', () => {
    const node = iterate('loop', () => null, {
      collection: 'ctx.inputs.items',
      concurrency: 5,
    });
    expect(node.concurrency).toBe(5);
  });

  it('serializes addNode iterate handlers as executable body code steps', () => {
    const handler = () => ({ processed: true }) as const;
    const workflow = defineWorkflow('standalone-iterate-add-node');

    workflow.addNode(iterate('loop', handler, { collection: 'ctx.inputs.items' }));

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: { id: string; type: string }[] } }).body;
    expect(body?.nodes).toEqual([{ id: 'loop__item', type: 'code-step' }]);
    expect(workflow.runtimeHandlers.get('loop__item')).toBe(handler);
    expect(workflow.runtimeHandlers.has('loop')).toBe(false);
  });
});

describe('standalone factory — iterateChain()', () => {
  it('creates an iterate-chain node with sub-chain', () => {
    const chain = [codeStep('a', () => null), agentStep('b', 'analyst')];
    const node = iterateChain('chain', chain, { collection: 'ctx.inputs.items' });
    expect(node.id).toBe('chain');
    expect(node.type).toBe('iterate-chain');
    expect(node.body.nodes).toHaveLength(2);
  });

  it('iterate-chain body nodes are introspectable', () => {
    const chain = [codeStep('first', () => null), codeStep('second', () => null)];
    const node = iterateChain('ic', chain, { collection: 'ctx.inputs.items' });
    expect(node.body.nodes[0]?.id).toBe('first');
    expect(node.body.nodes[1]?.id).toBe('second');
  });

  it('iterate-chain node is JSON-serializable', () => {
    const node = iterateChain('ic', [codeStep('s', () => null)], {
      collection: 'ctx.inputs.items',
    });
    expect(() => JSON.stringify(node)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// defineWorkflowBundle
// ─────────────────────────────────────────────────────────────

describe('defineWorkflowBundle', () => {
  it('packages workflows into a bundle', () => {
    const wf1 = defineWorkflow('wf-1');
    const wf2 = defineWorkflow('wf-2');

    const bundle = defineWorkflowBundle({ workflows: [wf1, wf2] });

    expect(bundle.workflows).toHaveLength(2);
    expect(bundle.workflows[0]?.id).toBe('wf-1');
    expect(bundle.workflows[1]?.id).toBe('wf-2');
  });

  it('copies the workflows array when creating a bundle', () => {
    const wf1 = defineWorkflow('wf-1');
    const wf2 = defineWorkflow('wf-2');
    const workflows = [wf1];

    const bundle = defineWorkflowBundle({ workflows });
    workflows.push(wf2);

    expect(Object.isFrozen(bundle.workflows)).toBe(true);
    expect(bundle.workflows).toHaveLength(1);
    expect(bundle.workflows[0]?.id).toBe('wf-1');
  });

  it('throws when workflows array is empty', () => {
    expect(() => defineWorkflowBundle({ workflows: [] })).toThrow('defineWorkflowBundle: workflows must not be empty');
  });

  it('bundle workflows carry serializable definitions', () => {
    const wf = defineWorkflow('bundle-serial').codeStep('do', () => null);
    const bundle = defineWorkflowBundle({ workflows: [wf] });

    const allDefs = bundle.workflows.map((w) => w.definition);
    expect(() => JSON.stringify(allDefs)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Loop node schema parsing
// ─────────────────────────────────────────────────────────────

describe('WorkflowDefinitionSchema — loop node', () => {
  it('serializes the exhaustion policy in fluent and standalone loops', () => {
    const options = { maxRounds: 3, onExhausted: 'complete' as const };
    const workflow = defineWorkflow('review-loop').loop('fluent', [codeStep('first', () => ({ done: true }))], {
      ...options,
      check: 'first',
    });
    workflow.addNode(
      loop('standalone', [codeStep('second', () => ({ done: false }))], {
        ...options,
        check: 'second',
      }),
    );

    expect(WorkflowDefinitionSchema.parse(workflow.definition).root.nodes).toMatchObject([
      { id: 'fluent', check: 'first', onExhausted: 'complete' },
      { id: 'standalone', check: 'second', onExhausted: 'complete' },
    ]);
  });

  it('parses a loop whose check references an agent step nested in the body', () => {
    const body = {
      id: 'converge__body',
      type: 'sequence',
      nodes: [
        {
          id: 'review-group',
          type: 'sequence',
          nodes: [{ id: 'review', type: 'agent-step', role: 'analyst', prompt: 'Check the result' }],
        },
      ],
    };
    const parsed = WorkflowDefinitionSchema.parse({
      id: 'review-loop',
      scope: { type: 'global' },
      root: {
        id: 'root',
        type: 'sequence',
        nodes: [{ id: 'converge', type: 'loop', maxRounds: 3, body, check: 'review' }],
      },
    });
    expect(parsed.root.nodes).toMatchObject([{ id: 'converge', type: 'loop', body, check: 'review' }]);
  });
});

// ─────────────────────────────────────────────────────────────
// Nested loop validation
// ─────────────────────────────────────────────────────────────

describe('validateNoNestedLoops', () => {
  it('returns undefined for a loop whose body contains no loops', () => {
    const loopNode = WorkflowLoopNodeSchema.parse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [{ id: 'outer-check', type: 'code-step' }],
      },
      check: 'outer-check',
    });
    expect(validateNoNestedLoops(loopNode)).toBeUndefined();
  });

  it('rejects a directly nested loop', () => {
    const result = WorkflowLoopNodeSchema.safeParse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
          { id: 'outer-check', type: 'code-step' },
          {
            id: 'inner',
            type: 'loop',
            maxRounds: 2,
            body: {
              id: 'inner__body',
              type: 'sequence',
              nodes: [{ id: 'step', type: 'code-step' }],
            },
            check: 'step',
          },
        ],
      },
      check: 'outer-check',
    });
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [{ path: ['body'], message: expect.stringContaining("Nested loop 'inner' found inside loop 'outer'") }],
      },
    });
  });

  it('rejects a loop nested inside a parallel branch', () => {
    const result = WorkflowLoopNodeSchema.safeParse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
          { id: 'outer-check', type: 'code-step' },
          {
            id: 'par',
            type: 'parallel',
            branches: {
              left: {
                id: 'par__left',
                type: 'sequence',
                nodes: [
                  {
                    id: 'deep-loop',
                    type: 'loop',
                    maxRounds: 1,
                    body: {
                      id: 'deep__body',
                      type: 'sequence',
                      nodes: [{ id: 'x', type: 'code-step' }],
                    },
                    check: 'x',
                  },
                ],
              },
            },
          },
        ],
      },
      check: 'outer-check',
    });
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [
          { path: ['body'], message: expect.stringContaining("Nested loop 'deep-loop' found inside loop 'outer'") },
        ],
      },
    });
  });

  it('rejects a loop nested inside an iterate body', () => {
    const result = WorkflowLoopNodeSchema.safeParse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
          { id: 'outer-check', type: 'code-step' },
          {
            id: 'iter',
            type: 'iterate',
            collection: 'ctx.inputs.items',
            body: {
              id: 'iter__body',
              type: 'sequence',
              nodes: [
                {
                  id: 'nested-loop',
                  type: 'loop',
                  maxRounds: 2,
                  body: {
                    id: 'nested__body',
                    type: 'sequence',
                    nodes: [{ id: 'y', type: 'code-step' }],
                  },
                  check: 'y',
                },
              ],
            },
          },
        ],
      },
      check: 'outer-check',
    });
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [
          { path: ['body'], message: expect.stringContaining("Nested loop 'nested-loop' found inside loop 'outer'") },
        ],
      },
    });
  });

  it('rejects a loop nested inside an iterate-chain body', () => {
    const result = WorkflowLoopNodeSchema.safeParse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
          { id: 'outer-check', type: 'code-step' },
          {
            id: 'chain',
            type: 'iterate-chain',
            collection: 'ctx.inputs.items',
            body: {
              id: 'chain__body',
              type: 'sequence',
              nodes: [
                {
                  id: 'nested-chain-loop',
                  type: 'loop',
                  maxRounds: 2,
                  body: {
                    id: 'nested-chain__body',
                    type: 'sequence',
                    nodes: [{ id: 'z', type: 'code-step' }],
                  },
                  check: 'z',
                },
              ],
            },
          },
        ],
      },
      check: 'outer-check',
    });
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            path: ['body'],
            message: expect.stringContaining("Nested loop 'nested-chain-loop' found inside loop 'outer'"),
          },
        ],
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Fluent builder — loop nodes
// ─────────────────────────────────────────────────────────────

describe('fluent builder — loop nodes', () => {
  it('serializes the body step reference and collects the body code step handler', () => {
    const handler = () => ({ done: true });
    const workflow = defineWorkflow('review-loop').loop('converge', [codeStep('aggregate', handler)], {
      maxRounds: 3,
      check: 'aggregate',
    });

    expect(workflow.definition.root.nodes[0]).toMatchObject({
      id: 'converge',
      type: 'loop',
      maxRounds: 3,
      check: 'aggregate',
    });
    expect(workflow.runtimeHandlers.get('aggregate')).toBe(handler);
  });

  it('creates the body sequence with correct ID convention', () => {
    const workflow = defineWorkflow('loop-body-id').loop('retry', [codeStep('attempt', () => ({ done: true }))], {
      maxRounds: 5,
      check: 'attempt',
    });

    const loopNode = workflow.definition.root.nodes[0] as WorkflowLoopNode | undefined;
    expect(loopNode?.body.id).toBe('retry__body');
    expect(loopNode?.body.type).toBe('sequence');
    expect(loopNode?.body.nodes).toHaveLength(1);
    expect(loopNode?.body.nodes[0]?.id).toBe('attempt');
  });

  it('rejects a check that names a code step outside the loop', () => {
    const workflow = defineWorkflow('loop-scope').codeStep('outside', () => ({ done: true }));
    expect(() =>
      workflow.loop('converge', [codeStep('inside', () => ({ done: false }))], {
        maxRounds: 3,
        check: 'outside',
      }),
    ).toThrow(/outside/iu);
  });

  it('applies when/skip conditions to loop nodes', () => {
    const workflow = defineWorkflow('loop-conditions').loop('retry', [codeStep('attempt', () => ({ done: true }))], {
      maxRounds: 2,
      check: 'attempt',
      when: "ctx.inputs.retry == 'true'",
      skip: "ctx.inputs.skipRetry == 'true'",
    });

    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.retry == 'true'");
    expect(node?.skip).toBe("ctx.inputs.skipRetry == 'true'");
  });

  it('loop node definition is JSON-serializable', () => {
    const workflow = defineWorkflow('loop-serial').loop('converge', [codeStep('work', () => ({ done: true }))], {
      maxRounds: 3,
      check: 'work',
    });
    expect(() => JSON.stringify(workflow.definition)).not.toThrow();
  });

  it('throws on duplicate loop ID', () => {
    const workflow = defineWorkflow('loop-dup');
    workflow.codeStep('converge', () => null);
    expect(() =>
      workflow.loop('converge', [codeStep('work', () => ({ done: true }))], {
        maxRounds: 3,
        check: 'work',
      }),
    ).toThrow('Duplicate step ID: converge');
  });

  it('throws on duplicate body node ID', () => {
    const workflow = defineWorkflow('loop-dup-body');
    workflow.codeStep('work', () => null);
    expect(() =>
      workflow.loop('converge', [codeStep('work', () => ({ done: true }))], {
        maxRounds: 3,
        check: 'work',
      }),
    ).toThrow('Duplicate step ID: work');
  });

  it('throws when synthesized body sequence ID reuses an existing ID', () => {
    const workflow = defineWorkflow('loop-dup-body-seq');
    workflow.codeStep('retry__body', () => null);
    expect(() =>
      workflow.loop('retry', [codeStep('attempt', () => ({ done: true }))], {
        maxRounds: 2,
        check: 'attempt',
      }),
    ).toThrow('Duplicate step ID: retry__body');
  });

  it('does not register the loop node itself in runtimeHandlers', () => {
    const workflow = defineWorkflow('loop-no-handler').loop('converge', [codeStep('work', () => ({ done: true }))], {
      maxRounds: 3,
      check: 'work',
    });
    expect(workflow.runtimeHandlers.has('converge')).toBe(false);
    expect(workflow.runtimeHandlers.has('work')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Standalone factory — loop()
// ─────────────────────────────────────────────────────────────

describe('standalone factory — loop()', () => {
  it('is exported from the root package barrel with loop schemas', () => {
    const loopNode = rootLoop('converge', [codeStep('aggregate', () => ({ done: true }))], {
      maxRounds: 2,
      check: 'aggregate',
    });

    expect(RootWorkflowLoopNodeSchema.parse(loopNode)).toMatchObject({ type: 'loop', check: 'aggregate' });
    expect(RootLoopCheckOutputSchema.parse({ done: false })).toEqual({ done: false });
    expect(RootLoopCheckOutputSchema.safeParse({ kind: 'loop' }).success).toBe(false);
  });

  it('creates a serializable loop node', () => {
    const loopNode = loop('converge', [codeStep('aggregate', () => ({ done: true }))], {
      maxRounds: 3,
      check: 'aggregate',
    });

    expect(loopNode).toMatchObject({
      id: 'converge',
      type: 'loop',
      maxRounds: 3,
      check: 'aggregate',
      body: {
        id: 'converge__body',
        type: 'sequence',
      },
    });
    expect(JSON.parse(JSON.stringify(loopNode))).toEqual(loopNode);
  });

  it('applies when/skip to the standalone loop node', () => {
    const loopNode = loop('retry', [codeStep('attempt', () => ({ done: true }))], {
      maxRounds: 2,
      check: 'attempt',
      when: 'x',
      skip: 'y',
    });
    expect(loopNode.when).toBe('x');
    expect(loopNode.skip).toBe('y');
  });

  it.each(['missing-step', 'converge__body'])('rejects a check naming %s instead of a body step', (check) => {
    expect(() => loop('converge', [codeStep('work', () => ({ done: true }))], { maxRounds: 3, check })).toThrow();
  });

  it('rejects nested loops before returning a standalone node', () => {
    expect(() =>
      loop(
        'outer',
        [
          codeStep('outer-check', () => ({ done: true })),
          loop('inner', [codeStep('inner-check', () => ({ done: true }))], {
            maxRounds: 2,
            check: 'inner-check',
          }),
        ],
        { maxRounds: 3, check: 'outer-check' },
      ),
    ).toThrow("Nested loop 'inner' found inside loop 'outer'");
  });

  it('addNode collects standalone loop body code step handlers into runtimeHandlers', () => {
    const bodyHandler = () => ({ processed: true }) as const;
    const workflow = defineWorkflow('standalone-loop-body-handlers');
    workflow.addNode(
      loop('converge', [codeStep('work', bodyHandler), agentStep('review', 'analyst')], {
        maxRounds: 3,
        check: 'review',
      }),
    );

    expect(workflow.definition.root.nodes[0]).toMatchObject({ check: 'review' });
    expect(workflow.runtimeHandlers.get('work')).toBe(bodyHandler);
    expect(workflow.runtimeHandlers.has('review')).toBe(false);
  });
});
