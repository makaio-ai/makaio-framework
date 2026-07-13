import { expect, expectTypeOf, it, describe } from 'vitest';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import {
  BusEventWorkflowTrigger,
  CronWorkflowTrigger,
  ManualWorkflowTrigger,
  WebhookWorkflowTrigger,
  ExtensionWorkflowTrigger,
  defineWorkflow,
  station,
  delegateToAgent,
  delegateToRole,
  gate,
  iterate,
  iterateChain,
  loop,
} from '../authoring.js';
import {
  loop as rootLoop,
  LoopGateOutcomeSchema as RootLoopGateOutcomeSchema,
  WorkflowLoopNodeSchema as RootWorkflowLoopNodeSchema,
} from '../../index.js';
import type { WorkflowGateNode, WorkflowLoopNode, WorkflowParallelNode, WorkflowSequenceNode } from '../schemas.js';
import { WorkflowDefinitionSchema, WorkflowLoopNodeSchema } from '../schemas.js';
import { validateNoNestedLoops } from '../loop.js';
import { defineWorkflowBundle } from '../bundle.js';

const GitNamespace = createBusNamespace('git', {
  checkout: z.object({
    isNewWorktree: z.boolean(),
    mainWorktree: z.string(),
    worktreePath: z.string(),
  }),
});

// ─────────────────────────────────────────────────────────────
// Trigger helpers
// ─────────────────────────────────────────────────────────────

describe('workflow trigger helpers', () => {
  it('serializes typed bus event triggers to workflow trigger schema', () => {
    const trigger = BusEventWorkflowTrigger({
      subject: GitNamespace.subjects.checkout,
      filter: { isNewWorktree: true },
    });

    expect(trigger.type).toBe('bus-event');
    expect(trigger.subject).toBe('git.checkout');
  });

  it('creates a manual trigger', () => {
    expect(ManualWorkflowTrigger().type).toBe('manual');
  });

  it('creates a cron trigger with schedule', () => {
    const t = CronWorkflowTrigger({ schedule: '0 9 * * 1' });
    expect(t.type).toBe('cron');
    if (t.type === 'cron') {
      expect(t.schedule).toBe('0 9 * * 1');
    }
  });

  it('creates a webhook trigger with event', () => {
    const t = WebhookWorkflowTrigger({ event: 'push', branch: 'main' });
    expect(t.type).toBe('webhook');
    if (t.type === 'webhook') {
      expect(t.event).toBe('push');
      expect(t.branch).toBe('main');
    }
  });

  it('creates an extension trigger', () => {
    const t = ExtensionWorkflowTrigger({ extensionType: 'github:pr.opened' });
    expect(t.type).toBe('extension');
    if (t.type === 'extension') {
      expect(t.extensionType).toBe('github:pr.opened');
    }
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

  it('station appends station nodes to the root sequence', () => {
    const workflow = defineWorkflow('fn-flow');
    workflow.station('compute', () => ({ value: 42 }));
    expect(workflow.definition.root.nodes).toHaveLength(1);
    const stationNode = workflow.definition.root.nodes[0];
    expect(stationNode?.type).toBe('station');
    expect(stationNode?.id).toBe('compute');
  });

  it('registers the handler in runtimeHandlers', () => {
    const workflow = defineWorkflow('fn-flow-3');
    workflow.station('compute', () => ({ value: 42 }));
    expect(workflow.runtimeHandlers.has('compute')).toBe(true);
  });

  it('throws on duplicate station IDs', () => {
    const workflow = defineWorkflow('dup-flow');
    workflow.station('step-a', () => null);
    expect(() => workflow.station('step-a', () => null)).toThrow('Duplicate step ID: step-a');
  });

  it('throws on duplicate IDs when addNode reuses an id already claimed by station', () => {
    const workflow = defineWorkflow('dup-node-flow');
    workflow.station('step-a', () => null);
    const gateNode: WorkflowGateNode = {
      id: 'step-a',
      type: 'gate',
      prompt: 'Approve?',
      autoAction: 'reject',
      timeoutMs: null,
    };
    expect(() => workflow.addNode(gateNode)).toThrow('Duplicate step ID: step-a');
  });

  it('throws on duplicate IDs when addNode is called twice with the same id', () => {
    const workflow = defineWorkflow('dup-addnode-flow');
    const gateA: WorkflowGateNode = {
      id: 'gate-a',
      type: 'gate',
      prompt: 'Approve?',
      autoAction: 'reject',
      timeoutMs: null,
    };
    workflow.addNode(gateA);
    const gateADup: WorkflowGateNode = {
      id: 'gate-a',
      type: 'gate',
      prompt: 'Approve again?',
      autoAction: 'reject',
      timeoutMs: null,
    };
    expect(() => workflow.addNode(gateADup)).toThrow('Duplicate step ID: gate-a');
  });

  it('recovers trigger payload typing when a trigger is added after defineWorkflow', () => {
    const workflow = defineWorkflow('late-trigger-flow').addTrigger(
      BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout }),
    );

    workflow.station('uses-trigger', (ctx) => {
      const trigger = ctx.trigger as { worktreePath: string };
      return { worktreePath: trigger.worktreePath };
    });

    expect(workflow.definition.triggers).toHaveLength(1);
  });

  it('accepts gate nodes via addNode', () => {
    const workflow = defineWorkflow('gate-flow');
    workflow.station('analyze', () => ({ findings: [] }));
    const approvalNode: WorkflowGateNode = {
      id: 'approval',
      type: 'gate',
      prompt: 'Approve the findings?',
      autoAction: 'reject',
      timeoutMs: null,
    };
    workflow.addNode(approvalNode);
    workflow.station('implement', () => ({ done: true }));

    expect(workflow.definition.root.nodes).toHaveLength(3);
    expect(workflow.definition.root.nodes[1]?.type).toBe('gate');
    expect(workflow.runtimeHandlers.has('approval')).toBe(false);
    expect(workflow.runtimeHandlers.has('analyze')).toBe(true);
    expect(workflow.runtimeHandlers.has('implement')).toBe(true);
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
    workflow.station('do-work', () => ({ done: true }));

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
      schemaVersion: '1.0',
      scope: { level: 'global' },
      schema: ArtifactSchema,
    });

    expect(workflow.zodSchemas.artifact).toBe(ArtifactSchema);
  });

  it('writes artifact binding to definition.artifact', () => {
    const workflow = defineWorkflow('artifact-def-flow').artifact({
      kind: 'report',
      schemaVersion: '2.0',
      scope: { level: 'global' },
    });

    expect(workflow.definition.artifact).toBeDefined();
    expect(workflow.definition.artifact?.kind).toBe('report');
    expect(workflow.definition.artifact?.schemaVersion).toBe('2.0');
  });

  it('serializes artifact resolution and status options', () => {
    const workflow = defineWorkflow('artifact-options-flow').artifact({
      kind: 'report',
      schemaVersion: '2.0',
      scope: { level: 'global' },
      resolve: 'inputs.reportRef',
      create: '{ title: inputs.title, status: "draft" }',
      statusPath: 'status',
    });

    expect(workflow.definition.artifact).toEqual({
      kind: 'report',
      schemaVersion: '2.0',
      scope: { level: 'global' },
      resolve: 'inputs.reportRef',
      create: '{ title: inputs.title, status: "draft" }',
      statusPath: 'status',
    });
  });

  it('does not require a Zod schema for artifact', () => {
    const workflow = defineWorkflow('artifact-no-schema').artifact({
      kind: 'summary',
      schemaVersion: '1.0',
      scope: { level: 'global' },
    });

    expect(workflow.zodSchemas.artifact).toBeUndefined();
    expect(workflow.definition.artifact?.kind).toBe('summary');
  });
});

describe('fluent builder — state typing', () => {
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

  it('types workflow state in station handlers after state declaration', () => {
    const workflow = defineWorkflow('typed-state-flow')
      .state<ReviewState>({
        schema: ReviewStateSchema,
        initial: { tier: 'T1', selectedReviewers: [] },
      })
      .station('select-reviewer', async (ctx) => {
        expectTypeOf(ctx.state.get()).toEqualTypeOf<Promise<ReviewState>>();
        const current = await ctx.state.get();
        expectTypeOf(current.tier).toEqualTypeOf<ReviewState['tier']>();
        expectTypeOf(current.selectedReviewers).toEqualTypeOf<string[]>();

        const updated = await ctx.state.update((draft) => {
          expectTypeOf(draft).toEqualTypeOf<ReviewState>();
          draft.selectedReviewers.push('correctness-reviewer');
          // @ts-expect-error ReviewState.selectedReviewers only accepts strings.
          draft.selectedReviewers.push(42);
        });

        expectTypeOf(ctx.state.update((draft) => void draft)).toEqualTypeOf<Promise<ReviewState>>();
        expectTypeOf(
          ctx.state.update(() => ({ tier: 'T2', selectedReviewers: ['correctness-reviewer'] })),
        ).toEqualTypeOf<Promise<ReviewState>>();
        expectTypeOf(updated).toEqualTypeOf<ReviewState>();
        return { reviewerCount: updated.selectedReviewers.length };
      });

    expect(workflow.definition.state?.initial).toEqual({ tier: 'T1', selectedReviewers: [] });
  });

  it('preserves state typing when a trigger is added after state declaration', () => {
    const workflow = defineWorkflow('state-then-trigger-flow')
      .state<ReviewState>({
        schema: ReviewStateSchema,
        initial: { tier: 'T2', selectedReviewers: [] },
      })
      .addTrigger(BusEventWorkflowTrigger({ subject: GitNamespace.subjects.checkout }));

    workflow.station('uses-trigger-and-state', async (ctx) => {
      expectTypeOf(ctx.state.get()).toEqualTypeOf<Promise<ReviewState>>();
      expectTypeOf(ctx.trigger.worktreePath).toEqualTypeOf<string>();
      return { tier: (await ctx.state.get()).tier, worktreePath: ctx.trigger.worktreePath };
    });

    expect(workflow.definition.triggers).toHaveLength(1);
  });

  it('keeps no-state workflow handlers ergonomic', () => {
    const workflow = defineWorkflow('no-state-flow').station('do-work', (ctx) => {
      expectTypeOf(ctx.state).toEqualTypeOf<undefined>();
      return { workflowId: ctx.workflowId };
    });

    expect(workflow.runtimeHandlers.has('do-work')).toBe(true);
  });
});

describe('fluent builder — station nodes', () => {
  it('appends a station node to the root sequence', () => {
    const handler = () => ({ done: true }) as const;
    const workflow = defineWorkflow('station-flow').station('do-work', handler);

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.id).toBe('do-work');
    expect(node?.type).toBe('station');
  });

  it('registers the handler in runtimeHandlers', () => {
    const handler = () => ({ done: true }) as const;
    const workflow = defineWorkflow('handler-flow').station('do-work', handler);

    expect(workflow.runtimeHandlers.has('do-work')).toBe(true);
    expect(workflow.runtimeHandlers.get('do-work')).toBe(handler);
  });

  it('applies when/skip conditions to station nodes', () => {
    const workflow = defineWorkflow('cond-flow').station('conditional', () => null, {
      when: "ctx.inputs.run == 'true'",
      skip: "ctx.inputs.skip == 'true'",
    });

    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.run == 'true'");
    expect(node?.skip).toBe("ctx.inputs.skip == 'true'");
  });

  it('station node in definition does not contain function bodies', () => {
    const workflow = defineWorkflow('no-fn-station').station('work', () => null);
    const serialized = JSON.stringify(workflow.definition);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain('function');
  });

  it('throws on duplicate station IDs', () => {
    expect(() =>
      defineWorkflow('dup-station')
        .station('a', () => null)
        .station('a', () => null),
    ).toThrow('Duplicate step ID: a');
  });
});

describe('fluent builder — delegateToAgent nodes', () => {
  it('appends a delegate-agent node to the root sequence', () => {
    const workflow = defineWorkflow('delegate-agent-flow').delegateToAgent('sub-task', {
      agentId: 'code-writer',
      completion: 'turn',
    });

    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('delegate-agent');
    expect(node?.id).toBe('sub-task');
    expect((node as { agentId?: string }).agentId).toBe('code-writer');
    expect((node as { completion?: string }).completion).toBe('turn');
  });

  it('does not add to runtimeHandlers for delegate-agent nodes', () => {
    const workflow = defineWorkflow('no-handler-agent').delegateToAgent('sub', {
      agentId: 'writer',
    });
    expect(workflow.runtimeHandlers.has('sub')).toBe(false);
  });
});

describe('fluent builder — delegateToRole nodes', () => {
  it('appends a delegate-role node with the given role', () => {
    const workflow = defineWorkflow('delegate-role-flow').delegateToRole('review', 'code-reviewer');

    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('delegate-role');
    expect(node?.id).toBe('review');
    expect((node as { role?: string }).role).toBe('code-reviewer');
  });

  it('defaults prompt to node ID when not provided', () => {
    const workflow = defineWorkflow('role-prompt-default').delegateToRole('analyze', 'analyst');
    const node = workflow.definition.root.nodes[0];
    expect((node as { prompt?: string }).prompt).toBe('analyze');
  });

  it('accepts a custom prompt override', () => {
    const workflow = defineWorkflow('role-prompt-override').delegateToRole('analyze', 'analyst', {
      prompt: 'Perform a detailed analysis',
    });
    const node = workflow.definition.root.nodes[0];
    expect((node as { prompt?: string }).prompt).toBe('Perform a detailed analysis');
  });

  it('preserves role delegation schema, timeout, and completion settings', () => {
    const outputSchema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
    };
    const workflow = defineWorkflow('role-contract-options').delegateToRole('review', 'analyst', {
      outputSchema,
      timeoutMs: 120_000,
      completion: 'turn',
      allowedTools: ['artifact.read'],
      resultFinalizerId: 'artifact.read-wrap',
    });

    expect(workflow.definition.root.nodes[0]).toMatchObject({
      type: 'delegate-role',
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
      station('spec-review', () => null),
      delegateToRole('quality-review', 'code-reviewer'),
    ]);

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('parallel');
    expect(node?.id).toBe('reviews');
  });

  it('creates one branch per entry in the branches array', () => {
    const workflow = defineWorkflow('parallel-branches').parallel('par', {}, [
      station('step-a', () => null),
      station('step-b', () => null),
    ]);

    const node = workflow.definition.root.nodes[0];
    const parallelNode = node as { branches?: Record<string, unknown> };
    expect(Object.keys(parallelNode.branches ?? {})).toHaveLength(2);
  });

  it('parallel node definition is JSON-serializable', () => {
    const workflow = defineWorkflow('parallel-serializable').parallel('par', {}, [station('x', () => null)]);
    expect(() => JSON.stringify(workflow.definition)).not.toThrow();
  });

  it('serializes all-settled as the default parallel mode', () => {
    const workflow = defineWorkflow('parallel-default-mode').parallel('par', {}, [station('x', () => null)]);
    const node = workflow.definition.root.nodes[0];
    expect((node as WorkflowParallelNode | undefined)?.mode).toBe('all-settled');
  });

  it('serializes fail-fast parallel mode', () => {
    const workflow = defineWorkflow('parallel-fail-fast').parallel('par', { mode: 'fail-fast' }, [
      station('x', () => null),
    ]);
    const node = workflow.definition.root.nodes[0];
    expect((node as WorkflowParallelNode | undefined)?.mode).toBe('fail-fast');
  });

  it('registers handlers from standalone station() branches in runtimeHandlers', () => {
    const specHandler = () => ({ ok: true }) as const;
    const workflow = defineWorkflow('parallel-handler-reg').parallel('reviews', { mode: 'all-settled' }, [
      station('spec-review', specHandler),
      delegateToRole('quality-review', 'code-reviewer'),
    ]);

    expect(workflow.runtimeHandlers.has('spec-review')).toBe(true);
    expect(workflow.runtimeHandlers.get('spec-review')).toBe(specHandler);
    // delegate-role nodes have no handler
    expect(workflow.runtimeHandlers.has('quality-review')).toBe(false);
  });

  it('registers standalone iterate branch handlers under executable body stations', () => {
    const handler = () => ({ processed: true }) as const;
    const workflow = defineWorkflow('parallel-iterate-handler-reg').parallel('fanout', {}, [
      iterate('loop', handler, { collection: 'ctx.inputs.items' }),
    ]);

    const parallelNode = workflow.definition.root.nodes[0] as WorkflowParallelNode | undefined;
    const branchNode = parallelNode?.branches['loop']?.nodes[0];
    const body = (branchNode as { body?: { nodes?: { id: string; type: string }[] } } | undefined)?.body;
    expect(body?.nodes).toEqual([{ id: 'loop__item', type: 'station', prompt: 'loop__item' }]);
    expect(workflow.runtimeHandlers.get('loop__item')).toBe(handler);
    expect(workflow.runtimeHandlers.has('loop')).toBe(false);
  });

  it('throws on duplicate branch IDs when parallel() branch reuses an existing id', () => {
    const workflow = defineWorkflow('parallel-dup-branch');
    workflow.station('existing', () => null);
    expect(() => workflow.parallel('par', {}, [station('existing', () => null)])).toThrow(
      'Duplicate step ID: existing',
    );
  });

  it('throws when a synthesized parallel branch sequence ID reuses an existing ID', () => {
    const workflow = defineWorkflow('parallel-dup-branch-sequence');
    workflow.station('fanout__review', () => null);
    expect(() => workflow.parallel('fanout', {}, [station('review', () => null)])).toThrow(
      'Duplicate step ID: fanout__review',
    );
  });
});

describe('fluent builder — gate nodes', () => {
  it('appends a gate node to the root sequence', () => {
    const workflow = defineWorkflow('gate-fluent').gate('triage', {
      prompt: 'Triage findings',
      autoAction: 'reject',
      timeoutMs: null,
    });

    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('gate');
    expect(node?.id).toBe('triage');
    expect((node as { prompt?: string }).prompt).toBe('Triage findings');
  });

  it('captures resume Zod schema in zodSchemas.gates keyed by node ID', () => {
    const TriageDecisionSchema = z.object({ approved: z.boolean(), reason: z.string() });
    const workflow = defineWorkflow('gate-schema').gate('triage', {
      prompt: 'Triage',
      autoAction: 'approve',
      timeoutMs: 3_600_000,
      resume: TriageDecisionSchema,
    });

    expect(workflow.zodSchemas.gates['triage']).toBe(TriageDecisionSchema);
  });

  it('converts resume schema to JSON Schema in node.resumeSchema', () => {
    const TriageSchema = z.object({ approved: z.boolean() });
    const workflow = defineWorkflow('gate-json-schema').gate('triage', {
      prompt: 'Approve?',
      autoAction: 'approve',
      timeoutMs: null,
      resume: TriageSchema,
    });

    const node = workflow.definition.root.nodes[0];
    expect((node as { resumeSchema?: Record<string, unknown> }).resumeSchema).toBeDefined();
    expect((node as { resumeSchema?: { type?: string } }).resumeSchema?.type).toBe('object');
  });

  it('gate without resume schema produces no resumeSchema in node', () => {
    const workflow = defineWorkflow('gate-no-resume').gate('approve', {
      prompt: 'Approve?',
      autoAction: 'approve',
      timeoutMs: null,
    });

    const node = workflow.definition.root.nodes[0];
    expect((node as { resumeSchema?: unknown }).resumeSchema).toBeUndefined();
  });

  it('does not add gate to runtimeHandlers', () => {
    const workflow = defineWorkflow('gate-no-handler').gate('approve', {
      prompt: 'Approve?',
      autoAction: 'reject',
      timeoutMs: null,
    });
    expect(workflow.runtimeHandlers.has('approve')).toBe(false);
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

  it('iterate node body contains a station wrapping the handler', () => {
    const workflow = defineWorkflow('iterate-body').iterate('loop', () => null, {
      collection: 'ctx.inputs.items',
    });

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: { type: string }[] } }).body;
    expect(body?.nodes?.[0]?.type).toBe('station');
  });

  it('registers the handler in runtimeHandlers', () => {
    const handler = () => null;
    const workflow = defineWorkflow('iterate-handler').iterate('loop', handler, {
      collection: 'ctx.inputs.items',
    });
    // The handler is registered under a synthetic station ID
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
    workflow.station('loop__body', () => null);
    expect(() =>
      workflow.iterate('loop', () => null, {
        collection: 'ctx.inputs.items',
      }),
    ).toThrow('Duplicate step ID: loop__body');
  });
});

describe('fluent builder — iterateChain nodes', () => {
  it('appends an iterate-chain node to the root sequence', () => {
    const chain = [station('step-a', () => null), delegateToRole('step-b', 'analyst')];
    const workflow = defineWorkflow('iterate-chain-flow').iterateChain('chain-loop', chain, {
      collection: 'ctx.inputs.items',
    });

    expect(workflow.definition.root.nodes).toHaveLength(1);
    const node = workflow.definition.root.nodes[0];
    expect(node?.type).toBe('iterate-chain');
  });

  it('stores the sub-chain nodes in body.nodes', () => {
    const chain = [station('step-a', () => null), station('step-b', () => null)];
    const workflow = defineWorkflow('iterate-chain-body').iterateChain('chain', chain, {
      collection: 'ctx.inputs.items',
    });

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: unknown[] } }).body;
    expect(body?.nodes).toHaveLength(2);
  });

  it('iterate-chain body sub-chain is introspectable', () => {
    const chain = [station('review', () => null), delegateToRole('apply', 'coder')];
    const workflow = defineWorkflow('iterate-chain-introspect').iterateChain('chain', chain, {
      collection: 'ctx.inputs.items',
    });

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: { id: string; type: string }[] } }).body;
    expect(body?.nodes?.[0]?.id).toBe('review');
    expect(body?.nodes?.[1]?.id).toBe('apply');
    expect(body?.nodes?.[1]?.type).toBe('delegate-role');
  });

  it('iterate-chain node is JSON-serializable', () => {
    const workflow = defineWorkflow('iterate-chain-serial').iterateChain('chain', [station('s', () => null)], {
      collection: 'ctx.inputs.items',
    });
    expect(() => JSON.stringify(workflow.definition)).not.toThrow();
  });

  it('registers handlers from standalone station() nodes in the chain in runtimeHandlers', () => {
    const reviewHandler = () => ({ reviewed: true }) as const;
    const workflow = defineWorkflow('iterate-chain-handler-reg').iterateChain(
      'process',
      [station('review', reviewHandler), delegateToRole('apply', 'coder')],
      { collection: 'ctx.inputs.items' },
    );

    expect(workflow.runtimeHandlers.has('review')).toBe(true);
    expect(workflow.runtimeHandlers.get('review')).toBe(reviewHandler);
    // delegate-role nodes have no handler
    expect(workflow.runtimeHandlers.has('apply')).toBe(false);
  });

  it('throws on duplicate IDs when iterateChain() chain reuses an existing id', () => {
    const workflow = defineWorkflow('iterate-chain-dup');
    workflow.station('existing', () => null);
    expect(() =>
      workflow.iterateChain('chain', [station('existing', () => null)], {
        collection: 'ctx.inputs.items',
      }),
    ).toThrow('Duplicate step ID: existing');
  });

  it('throws when a synthesized iterate-chain body sequence ID reuses an existing ID', () => {
    const workflow = defineWorkflow('iterate-chain-dup-body-sequence');
    workflow.station('chain__body', () => null);
    expect(() =>
      workflow.iterateChain('chain', [station('step-a', () => null)], {
        collection: 'ctx.inputs.items',
      }),
    ).toThrow('Duplicate step ID: chain__body');
  });
});

describe('fluent builder — full chain with all node types', () => {
  const InputSchema = z.object({ items: z.array(z.string()) });
  const ConfigSchema = z.object({ maxRetries: z.number().int() });
  const OutputSchema = z.object({ processed: z.boolean() });
  const ArtifactSchema = z.object({ summary: z.string() });
  const TriageSchema = z.object({ approved: z.boolean() });

  const analyzeHandler = () => ({ findings: [] }) as const;
  const applyHandler = () => ({ done: true }) as const;

  const workflow = defineWorkflow('full-chain-flow')
    .input(InputSchema)
    .config(ConfigSchema)
    .artifact({ kind: 'review', schemaVersion: '1.0', scope: { level: 'global' }, schema: ArtifactSchema })
    .parallel('reviews', { mode: 'all-settled' }, [
      station('spec-review', () => null),
      delegateToRole('quality-review', 'code-reviewer'),
    ])
    .station('analyze', analyzeHandler)
    .gate('triage', { prompt: 'Triage findings', resume: TriageSchema, autoAction: 'reject', timeoutMs: null })
    .iterateChain('apply', [station('apply-item', applyHandler)], { collection: 'ctx.outputs.findings' })
    .output(OutputSchema);

  it('produces correct node count in root sequence', () => {
    expect(workflow.definition.root.nodes).toHaveLength(4);
  });

  it('has correct node types in order', () => {
    const types = workflow.definition.root.nodes.map((n) => n.type);
    expect(types).toEqual(['parallel', 'station', 'gate', 'iterate-chain']);
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
    expect(workflow.zodSchemas.gates['triage']).toBe(TriageSchema);
  });

  it('runtimeHandlers contains builder station handler and standalone factory handlers', () => {
    // builder .station() registers directly
    expect(workflow.runtimeHandlers.has('analyze')).toBe(true);
    expect(workflow.runtimeHandlers.get('analyze')).toBe(analyzeHandler);
    // standalone station() inside parallel() — handler must be extracted
    expect(workflow.runtimeHandlers.has('spec-review')).toBe(true);
    // standalone station() inside iterateChain() — handler must be extracted
    expect(workflow.runtimeHandlers.has('apply-item')).toBe(true);
    expect(workflow.runtimeHandlers.get('apply-item')).toBe(applyHandler);
  });

  it('runtimeHandlers does not contain gate or delegate-role entries', () => {
    expect(workflow.runtimeHandlers.has('triage')).toBe(false);
    expect(workflow.runtimeHandlers.has('quality-review')).toBe(false);
  });

  it('runtimeFactories is empty while v1 topology is static', () => {
    expect(workflow.runtimeFactories.size).toBe(0);
  });
});

describe('fluent builder — Resolvable<T> in when/skip conditions', () => {
  it('accepts a when jexl expression on station', () => {
    const workflow = defineWorkflow('when-flow').station('step', () => null, {
      when: "ctx.inputs.enabled == 'true'",
    });
    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.enabled == 'true'");
  });

  it('accepts a skip jexl expression on station', () => {
    const workflow = defineWorkflow('skip-flow').station('step', () => null, {
      skip: "ctx.inputs.skip == 'true'",
    });
    const node = workflow.definition.root.nodes[0];
    expect(node?.skip).toBe("ctx.inputs.skip == 'true'");
  });

  it('accepts when on delegateToRole node', () => {
    const workflow = defineWorkflow('when-role').delegateToRole('review', 'analyst', {
      when: "ctx.inputs.mode == 'full'",
    });
    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.mode == 'full'");
  });

  it('accepts when on parallel node', () => {
    const workflow = defineWorkflow('when-parallel').parallel('par', { when: "ctx.inputs.parallel == 'true'" }, [
      station('x', () => null),
    ]);
    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.parallel == 'true'");
  });
});

// ─────────────────────────────────────────────────────────────
// Standalone node factory functions
// ─────────────────────────────────────────────────────────────

describe('standalone factory — station()', () => {
  it('creates a station node with the correct shape', () => {
    const node = station('my-step', () => null);
    expect(node.id).toBe('my-step');
    expect(node.type).toBe('station');
    expect(node.prompt).toBe('my-step');
  });

  it('applies when/skip options', () => {
    const node = station('s', () => null, { when: 'x', skip: 'y' });
    expect(node.when).toBe('x');
    expect(node.skip).toBe('y');
  });

  it('returns a JSON-serializable node', () => {
    const node = station('s', () => null);
    expect(() => JSON.stringify(node)).not.toThrow();
  });
});

describe('standalone factory — delegateToAgent()', () => {
  it('creates a delegate-agent node with agentId', () => {
    const node = delegateToAgent('sub', { agentId: 'writer' });
    expect(node.id).toBe('sub');
    expect(node.type).toBe('delegate-agent');
    expect(node.agentId).toBe('writer');
  });

  it('includes inputExpression when provided', () => {
    const node = delegateToAgent('sub', {
      agentId: 'writer',
      inputExpression: 'ctx.outputs.spec',
    });
    expect(node.inputExpression).toBe('ctx.outputs.spec');
  });
});

describe('standalone factory — delegateToRole()', () => {
  it('creates a delegate-role node', () => {
    const node = delegateToRole('review', 'code-reviewer');
    expect(node.id).toBe('review');
    expect(node.type).toBe('delegate-role');
    expect(node.role).toBe('code-reviewer');
    expect(node.prompt).toBe('review');
  });

  it('accepts a custom prompt', () => {
    const node = delegateToRole('r', 'analyst', { prompt: 'Custom prompt' });
    expect(node.prompt).toBe('Custom prompt');
  });

  it('preserves schema, timeout, and completion settings', () => {
    const outputSchema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    };
    const node = delegateToRole('r', 'analyst', {
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

describe('standalone factory — gate()', () => {
  it('creates a gate node', () => {
    const node = gate('approve', {
      prompt: 'Approve?',
      autoAction: 'reject',
      timeoutMs: null,
    });
    expect(node.id).toBe('approve');
    expect(node.type).toBe('gate');
    expect(node.autoAction).toBe('reject');
    expect(node.timeoutMs).toBeNull();
  });

  it('converts resume schema to JSON Schema in node.resumeSchema', () => {
    const ResumeSchema = z.object({ approved: z.boolean() });
    const node = gate('g', {
      prompt: 'Approve?',
      autoAction: 'approve',
      timeoutMs: null,
      resume: ResumeSchema,
    });
    expect(node.resumeSchema).toBeDefined();
    expect(node.resumeSchema?.type).toBe('object');
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

  it('serializes addNode iterate handlers as executable body stations', () => {
    const handler = () => ({ processed: true }) as const;
    const workflow = defineWorkflow('standalone-iterate-add-node');

    workflow.addNode(iterate('loop', handler, { collection: 'ctx.inputs.items' }));

    const node = workflow.definition.root.nodes[0];
    const body = (node as { body?: { nodes?: { id: string; type: string }[] } }).body;
    expect(body?.nodes).toEqual([{ id: 'loop__item', type: 'station', prompt: 'loop__item' }]);
    expect(workflow.runtimeHandlers.get('loop__item')).toBe(handler);
    expect(workflow.runtimeHandlers.has('loop')).toBe(false);
  });
});

describe('standalone factory — iterateChain()', () => {
  it('creates an iterate-chain node with sub-chain', () => {
    const chain = [station('a', () => null), delegateToRole('b', 'analyst')];
    const node = iterateChain('chain', chain, { collection: 'ctx.inputs.items' });
    expect(node.id).toBe('chain');
    expect(node.type).toBe('iterate-chain');
    expect(node.body.nodes).toHaveLength(2);
  });

  it('iterate-chain body nodes are introspectable', () => {
    const chain = [station('first', () => null), station('second', () => null)];
    const node = iterateChain('ic', chain, { collection: 'ctx.inputs.items' });
    expect(node.body.nodes[0]?.id).toBe('first');
    expect(node.body.nodes[1]?.id).toBe('second');
  });

  it('iterate-chain node is JSON-serializable', () => {
    const node = iterateChain('ic', [station('s', () => null)], {
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
    const wf = defineWorkflow('bundle-serial').station('do', () => null);
    const bundle = defineWorkflowBundle({ workflows: [wf] });

    const allDefs = bundle.workflows.map((w) => w.definition);
    expect(() => JSON.stringify(allDefs)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Loop node schema parsing
// ─────────────────────────────────────────────────────────────

describe('WorkflowDefinitionSchema — loop node', () => {
  it('parses a gated loop node', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: 'review-loop',
      name: 'Review Loop',
      scope: { type: 'global' },
      root: {
        id: 'root',
        type: 'sequence',
        nodes: [
          {
            id: 'converge',
            type: 'loop',
            maxRounds: 3,
            body: {
              id: 'converge__body',
              type: 'sequence',
              nodes: [{ id: 'aggregate', type: 'station', prompt: 'Aggregate findings' }],
            },
            gate: {
              handler: 'no-open-blockers',
              input: 'frames.aggregate.output',
              config: { blockerSeverities: ['blocker'] },
              escalation: {
                title: 'Review loop escalation',
                prompt: 'The loop reached escalation. Choose the next action.',
                autoAction: 'reject',
                timeoutMs: null,
              },
            },
          },
        ],
      },
    });
    expect(parsed.root.nodes[0]?.type).toBe('loop');
  });

  it('parses a loop node without optional gate fields', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: 'minimal-loop',
      scope: { type: 'global' },
      root: {
        id: 'root',
        type: 'sequence',
        nodes: [
          {
            id: 'retry',
            type: 'loop',
            maxRounds: 5,
            body: {
              id: 'retry__body',
              type: 'sequence',
              nodes: [{ id: 'attempt', type: 'station', prompt: 'Try again' }],
            },
            gate: {
              handler: 'check-success',
            },
          },
        ],
      },
    });
    expect(parsed.root.nodes[0]?.type).toBe('loop');
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
        nodes: [{ id: 'step', type: 'station', prompt: 'Do work' }],
      },
      gate: { handler: 'check' },
    });
    expect(validateNoNestedLoops(loopNode)).toBeUndefined();
  });

  it('rejects a directly nested loop', () => {
    const loopNode = WorkflowLoopNodeSchema.parse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
          {
            id: 'inner',
            type: 'loop',
            maxRounds: 2,
            body: {
              id: 'inner__body',
              type: 'sequence',
              nodes: [{ id: 'step', type: 'station', prompt: 'work' }],
            },
            gate: { handler: 'check' },
          },
        ],
      },
      gate: { handler: 'check' },
    });
    const result = validateNoNestedLoops(loopNode);
    expect(result).toBeDefined();
    expect(result).toContain("Nested loop 'inner'");
    expect(result).toContain("inside loop 'outer'");
  });

  it('rejects a loop nested inside a parallel branch', () => {
    const loopNode = WorkflowLoopNodeSchema.parse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
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
                      nodes: [{ id: 'x', type: 'station', prompt: 'x' }],
                    },
                    gate: { handler: 'check' },
                  },
                ],
              },
            },
          },
        ],
      },
      gate: { handler: 'check' },
    });
    const result = validateNoNestedLoops(loopNode);
    expect(result).toBeDefined();
    expect(result).toContain("Nested loop 'deep-loop'");
  });

  it('rejects a loop nested inside an iterate body', () => {
    const loopNode = WorkflowLoopNodeSchema.parse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
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
                    nodes: [{ id: 'y', type: 'station', prompt: 'y' }],
                  },
                  gate: { handler: 'check' },
                },
              ],
            },
          },
        ],
      },
      gate: { handler: 'check' },
    });
    const result = validateNoNestedLoops(loopNode);
    expect(result).toBeDefined();
    expect(result).toContain("Nested loop 'nested-loop'");
  });

  it('rejects a loop nested inside an iterate-chain body', () => {
    const loopNode = WorkflowLoopNodeSchema.parse({
      id: 'outer',
      type: 'loop',
      maxRounds: 3,
      body: {
        id: 'outer__body',
        type: 'sequence',
        nodes: [
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
                    nodes: [{ id: 'z', type: 'station', prompt: 'z' }],
                  },
                  gate: { handler: 'check' },
                },
              ],
            },
          },
        ],
      },
      gate: { handler: 'check' },
    });
    const result = validateNoNestedLoops(loopNode);
    expect(result).toBeDefined();
    expect(result).toContain("Nested loop 'nested-chain-loop'");
  });
});

// ─────────────────────────────────────────────────────────────
// Fluent builder — loop nodes
// ─────────────────────────────────────────────────────────────

describe('fluent builder — loop nodes', () => {
  it('appends a serializable loop node and stores gate handler', () => {
    const workflow = defineWorkflow('review-loop').loop('converge', [station('aggregate', () => ({ blockers: [] }))], {
      maxRounds: 3,
      gate: {
        handler: 'no-open-blockers',
        evaluate: () => ({ kind: 'pass' as const }),
      },
    });

    expect(workflow.definition.root.nodes[0]).toMatchObject({
      id: 'converge',
      type: 'loop',
      maxRounds: 3,
      gate: { handler: 'no-open-blockers' },
    });
    expect(workflow.runtimeLoopGates.get('no-open-blockers')).toBeTypeOf('function');
    // body station handler should be collected
    expect(workflow.runtimeHandlers.get('aggregate')).toBeTypeOf('function');
  });

  it('creates the body sequence with correct ID convention', () => {
    const workflow = defineWorkflow('loop-body-id').loop('retry', [station('attempt', () => null)], {
      maxRounds: 5,
      gate: {
        handler: 'check-success',
        evaluate: () => ({ kind: 'pass' as const }),
      },
    });

    const loopNode = workflow.definition.root.nodes[0] as WorkflowLoopNode | undefined;
    expect(loopNode?.body.id).toBe('retry__body');
    expect(loopNode?.body.type).toBe('sequence');
    expect(loopNode?.body.nodes).toHaveLength(1);
    expect(loopNode?.body.nodes[0]?.id).toBe('attempt');
  });

  it('serializes gate input, config, and escalation', () => {
    const workflow = defineWorkflow('loop-full-gate').loop('converge', [station('work', () => null)], {
      maxRounds: 3,
      gate: {
        handler: 'checker',
        evaluate: () => ({ kind: 'loop' as const }),
        input: 'frames.work.output',
        config: { severity: 'blocker' },
        escalation: {
          title: 'Loop escalation',
          prompt: 'The loop needs human input.',
          autoAction: 'reject',
          timeoutMs: null,
        },
      },
    });

    const loopNode = workflow.definition.root.nodes[0] as WorkflowLoopNode | undefined;
    expect(loopNode?.gate.input).toBe('frames.work.output');
    expect(loopNode?.gate.config).toEqual({ severity: 'blocker' });
    expect(loopNode?.gate.escalation).toEqual({
      title: 'Loop escalation',
      prompt: 'The loop needs human input.',
      autoAction: 'reject',
      timeoutMs: null,
    });
  });

  it('applies when/skip conditions to loop nodes', () => {
    const workflow = defineWorkflow('loop-conditions').loop('retry', [station('attempt', () => null)], {
      maxRounds: 2,
      gate: {
        handler: 'check',
        evaluate: () => ({ kind: 'pass' as const }),
      },
      when: "ctx.inputs.retry == 'true'",
      skip: "ctx.inputs.skipRetry == 'true'",
    });

    const node = workflow.definition.root.nodes[0];
    expect(node?.when).toBe("ctx.inputs.retry == 'true'");
    expect(node?.skip).toBe("ctx.inputs.skipRetry == 'true'");
  });

  it('loop node definition is JSON-serializable', () => {
    const workflow = defineWorkflow('loop-serial').loop('converge', [station('work', () => null)], {
      maxRounds: 3,
      gate: {
        handler: 'checker',
        evaluate: () => ({ kind: 'pass' as const }),
      },
    });
    expect(() => JSON.stringify(workflow.definition)).not.toThrow();
  });

  it('throws on duplicate loop ID', () => {
    const workflow = defineWorkflow('loop-dup');
    workflow.station('converge', () => null);
    expect(() =>
      workflow.loop('converge', [station('work', () => null)], {
        maxRounds: 3,
        gate: {
          handler: 'check',
          evaluate: () => ({ kind: 'pass' as const }),
        },
      }),
    ).toThrow('Duplicate step ID: converge');
  });

  it('throws on duplicate body node ID', () => {
    const workflow = defineWorkflow('loop-dup-body');
    workflow.station('work', () => null);
    expect(() =>
      workflow.loop('converge', [station('work', () => null)], {
        maxRounds: 3,
        gate: {
          handler: 'check',
          evaluate: () => ({ kind: 'pass' as const }),
        },
      }),
    ).toThrow('Duplicate step ID: work');
  });

  it('throws when synthesized body sequence ID reuses an existing ID', () => {
    const workflow = defineWorkflow('loop-dup-body-seq');
    workflow.station('retry__body', () => null);
    expect(() =>
      workflow.loop('retry', [station('attempt', () => null)], {
        maxRounds: 2,
        gate: {
          handler: 'check',
          evaluate: () => ({ kind: 'pass' as const }),
        },
      }),
    ).toThrow('Duplicate step ID: retry__body');
  });

  it('does not register the loop node itself in runtimeHandlers', () => {
    const workflow = defineWorkflow('loop-no-handler').loop('converge', [station('work', () => null)], {
      maxRounds: 3,
      gate: {
        handler: 'checker',
        evaluate: () => ({ kind: 'pass' as const }),
      },
    });
    expect(workflow.runtimeHandlers.has('converge')).toBe(false);
    expect(workflow.runtimeHandlers.has('work')).toBe(true);
  });

  it('runtimeLoopGates is empty when no loop nodes are present', () => {
    const workflow = defineWorkflow('no-loop').station('work', () => null);
    expect(workflow.runtimeLoopGates.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Standalone factory — loop()
// ─────────────────────────────────────────────────────────────

describe('standalone factory — loop()', () => {
  it('is exported from the root package barrel with loop schemas', () => {
    const loopNode = rootLoop('converge', [station('aggregate', () => null)], {
      maxRounds: 2,
      gate: { handler: 'check', evaluate: () => ({ kind: 'pass' as const }) },
    });

    expect(RootWorkflowLoopNodeSchema.parse(loopNode).type).toBe('loop');
    expect(RootLoopGateOutcomeSchema.parse({ kind: 'loop' })).toEqual({ kind: 'loop' });
  });

  it('creates a serializable loop node', () => {
    const loopNode = loop('converge', [station('aggregate', () => ({ blockers: [] }))], {
      maxRounds: 3,
      gate: {
        handler: 'no-open-blockers',
        evaluate: () => ({ kind: 'pass' as const }),
      },
    });

    expect(loopNode).toMatchObject({
      id: 'converge',
      type: 'loop',
      maxRounds: 3,
      gate: { handler: 'no-open-blockers' },
      body: {
        id: 'converge__body',
        type: 'sequence',
      },
    });
  });

  it('applies when/skip to the standalone loop node', () => {
    const loopNode = loop('retry', [station('attempt', () => null)], {
      maxRounds: 2,
      gate: {
        handler: 'check',
        evaluate: () => ({ kind: 'pass' as const }),
      },
      when: 'x',
      skip: 'y',
    });
    expect(loopNode.when).toBe('x');
    expect(loopNode.skip).toBe('y');
  });

  it('is JSON-serializable', () => {
    const loopNode = loop('retry', [station('attempt', () => null)], {
      maxRounds: 2,
      gate: {
        handler: 'check',
        evaluate: () => ({ kind: 'pass' as const }),
      },
    });
    expect(() => JSON.stringify(loopNode)).not.toThrow();
  });

  it('serializes gate input, config, and escalation on standalone node', () => {
    const loopNode = loop('converge', [station('work', () => null)], {
      maxRounds: 3,
      gate: {
        handler: 'checker',
        evaluate: () => ({ kind: 'loop' as const }),
        input: 'frames.work.output',
        config: { threshold: 0.9 },
        escalation: {
          prompt: 'Human needed',
        },
      },
    });

    expect(loopNode.gate.input).toBe('frames.work.output');
    expect(loopNode.gate.config).toEqual({ threshold: 0.9 });
    expect(loopNode.gate.escalation).toEqual({
      prompt: 'Human needed',
      autoAction: 'reject',
      timeoutMs: null,
    });
  });

  it('rejects nested loops before returning a standalone node', () => {
    expect(() =>
      loop(
        'outer',
        [
          loop('inner', [station('work', () => null)], {
            maxRounds: 2,
            gate: { handler: 'inner-check', evaluate: () => ({ kind: 'pass' as const }) },
          }),
        ],
        {
          maxRounds: 3,
          gate: { handler: 'outer-check', evaluate: () => ({ kind: 'pass' as const }) },
        },
      ),
    ).toThrow("Nested loop 'inner' found inside loop 'outer'");
  });

  it('addNode collects standalone loop gate handler into runtimeLoopGates', () => {
    const gateEvaluate = () => ({ kind: 'pass' as const });
    const workflow = defineWorkflow('standalone-loop-addnode');
    workflow.addNode(
      loop('converge', [station('aggregate', () => null)], {
        maxRounds: 3,
        gate: {
          handler: 'blocker-check',
          evaluate: gateEvaluate,
        },
      }),
    );

    expect(workflow.runtimeLoopGates.get('blocker-check')).toBe(gateEvaluate);
    expect(workflow.runtimeHandlers.get('aggregate')).toBeTypeOf('function');
  });

  it('addNode collects standalone loop body station handlers into runtimeHandlers', () => {
    const bodyHandler = () => ({ processed: true }) as const;
    const workflow = defineWorkflow('standalone-loop-body-handlers');
    workflow.addNode(
      loop('converge', [station('work', bodyHandler), delegateToRole('review', 'analyst')], {
        maxRounds: 3,
        gate: {
          handler: 'check',
          evaluate: () => ({ kind: 'pass' as const }),
        },
      }),
    );

    expect(workflow.runtimeHandlers.get('work')).toBe(bodyHandler);
    expect(workflow.runtimeHandlers.has('review')).toBe(false);
  });
});
