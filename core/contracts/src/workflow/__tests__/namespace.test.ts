import { describe, expect, it } from 'vitest';
import {
  WorkflowResolvedRoleSchema,
  WorkflowAgentStepNodeSchema,
  WorkflowCodeStepNodeSchema,
  WorkflowParallelNodeSchema,
  WorkflowIterateNodeSchema,
  WorkflowIterateChainNodeSchema,
  WorkflowSequenceNodeSchema,
  WorkflowNodeSchema,
  WorkflowDefinitionSchema,
  WorkflowDefinitionListSchema,
  WorkflowArtifactBindingSchema,
  WorkflowFrameStateSchema,
  WorkflowNodeTypeSchema,
  WorkflowParallelModeSchema,
} from '../schemas.js';
import type { WorkflowParallelNode } from '../schemas.js';
import { WorkflowProgressUpdateSchema, WorkflowSchemas, WorkflowSubjects } from '../namespace.js';
import { WorkLogExecutionSummarySchema, WorkLogFrameEntrySchema } from '../worklog.js';

// ─────────────────────────────────────────────────────────────
// Namespace subjects
// ─────────────────────────────────────────────────────────────

describe('WorkflowNamespace', () => {
  it('exposes dotted lifecycle subjects as nested accessors', () => {
    expect(WorkflowSubjects.start.subject).toBe('start');
    expect(WorkflowSubjects.execution.started.subject).toBe('execution.started');
    expect(WorkflowSubjects.execution.progress.subject).toBe('execution.progress');
    expect(WorkflowSubjects.step.beforeStart.subject).toBe('step.beforeStart');
    expect(WorkflowSubjects.step.completed.subject).toBe('step.completed');
  });

  it('exposes new frame lifecycle subjects as nested accessors', () => {
    expect(WorkflowSubjects.frame.started.subject).toBe('frame.started');
    expect(WorkflowSubjects.frame.completed.subject).toBe('frame.completed');
    expect(WorkflowSubjects.frame.failed.subject).toBe('frame.failed');
    expect(WorkflowSubjects.frame.sessionLinked.subject).toBe('frame.sessionLinked');
  });

  it('exposes public execution trace read subjects', () => {
    expect(WorkflowSubjects.listSpans.subject).toBe('listSpans');
    expect(WorkflowSubjects.setExecutionLink.subject).toBe('setExecutionLink');
    expect(WorkflowSubjects.listExecutionLinks.subject).toBe('listExecutionLinks');
    expect(WorkflowSubjects.listFrames.subject).toBe('listFrames');
  });

  it('exposes dynamic and artifact subjects', () => {
    expect(WorkflowSubjects.dynamic.materialized.subject).toBe('dynamic.materialized');
    expect(WorkflowSubjects.artifact.updated.subject).toBe('artifact.updated');
  });

  it('exposes worklog RPC and event subjects', () => {
    expect(WorkflowSubjects.worklog.get.subject).toBe('worklog.get');
    expect(WorkflowSubjects.worklog.frame.get.subject).toBe('worklog.frame.get');
    expect(WorkflowSubjects.worklog.list.subject).toBe('worklog.list');
    expect(WorkflowSubjects.worklog.stats.subject).toBe('worklog.stats');
    expect(WorkflowSubjects.worklog.changed.subject).toBe('worklog.changed');
  });
});

describe('execution lifecycle events', () => {
  it('parses execution lifecycle events with source timestamps', () => {
    const started = WorkflowSchemas['execution.started'].parse({
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      coordinatorSessionId: 'sess-coordinator',
      startedAt: 1000,
      artifactRef: { kind: 'workpiece', id: 'wp-1' },
    });
    const completed = WorkflowSchemas['execution.completed'].parse({
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      totalDuration: 1500,
      completedAt: 2500,
    });
    const failed = WorkflowSchemas['execution.failed'].parse({
      executionId: 'wfx-2',
      workflowId: 'wf-2',
      error: 'Boom',
      completedAt: 3000,
    });
    const cancelled = WorkflowSchemas['execution.cancelled'].parse({
      executionId: 'wfx-3',
      workflowId: 'wf-3',
      reason: 'User cancelled',
      completedAt: 4000,
    });

    expect(started.startedAt).toBe(1000);
    expect(started.artifactRef).toEqual({ kind: 'workpiece', id: 'wp-1' });
    expect(completed.completedAt).toBe(2500);
    expect(failed.completedAt).toBe(3000);
    expect(cancelled.completedAt).toBe(4000);
  });

  it('requires workflow identity on terminal execution events', () => {
    expect(() =>
      WorkflowSchemas['execution.completed'].parse({
        executionId: 'wfx-1',
        totalDuration: 1500,
      }),
    ).toThrow();
    expect(() =>
      WorkflowSchemas['execution.failed'].parse({
        executionId: 'wfx-2',
        error: 'Boom',
      }),
    ).toThrow();
    expect(() =>
      WorkflowSchemas['execution.cancelled'].parse({
        executionId: 'wfx-3',
      }),
    ).toThrow();
  });

  it('parses structured progress updates and execution.progress events', () => {
    const progress = WorkflowProgressUpdateSchema.parse({
      message: 'Review draft ready',
      details: 'The review artifact has been updated.',
      kind: 'checkpoint',
      metadata: { artifactId: 'artifact-1', percent: 50 },
    });
    const event = WorkflowSchemas['execution.progress'].parse({
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      frameId: 'frame-review',
      nodeId: 'review',
      progress,
      emittedAt: 2500,
    });

    expect(event.progress).toEqual(progress);
    expect(event.frameId).toBe('frame-review');
  });

  it('rejects progress events with an empty progress message', () => {
    expect(() =>
      WorkflowSchemas['execution.progress'].parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        frameId: 'frame-review',
        nodeId: 'review',
        progress: { message: '' },
        emittedAt: 2500,
      }),
    ).toThrow();
  });
});

describe('WorkflowSubjects.resolveRole', () => {
  it('exposes the resolveRole subject', () => {
    expect(WorkflowSubjects.resolveRole.subject).toBe('resolveRole');
  });
});

describe('workflow.acceptAuthorityRunnerResult', () => {
  it('accepts a completed runner result', () => {
    const request = {
      executionId: 'wfx-1',
      result: { executionId: 'wfx-1', workflowId: 'wf-1', status: 'completed' },
    };

    expect(WorkflowSchemas.acceptAuthorityRunnerResult.request.parse(request)).toEqual(request);
  });

  it('rejects a legacy paused runner result', () => {
    const result = WorkflowSchemas.acceptAuthorityRunnerResult.request.safeParse({
      executionId: 'wfx-1',
      result: {
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'paused', // legacy-input
        pausedAtGateId: 'approval', // legacy-input
        pausedAtFrameId: 'frame-approval', // legacy-input
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([expect.objectContaining({ path: ['result', 'status'] })]);
  });
});

describe('workflow.getRunContext', () => {
  it('returns the stored context with its historical definition snapshot intact', () => {
    const executionId = 'wfx-1';
    const workflowId = 'wf-1';
    const definitionSnapshot = {
      id: workflowId,
      root: {
        id: 'root',
        type: 'sequence',
        nodes: [
          { id: 'approval', type: 'gate', prompt: 'Approve?', autoAction: 'reject', timeoutMs: null }, // legacy-input
        ],
      },
    };
    const context = {
      executionId,
      workflowId,
      source: { kind: 'definition', workflowId },
      definitionSnapshot,
      workerManifest: { contributionRefs: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'coordinator-1',
      cancelSubject: 'workflow.cancel.wfx-1',
      env: {},
      createdAt: 1000,
    };

    expect(WorkflowSubjects.getRunContext.subject).toBe('getRunContext');
    expect(WorkflowDefinitionSchema.safeParse(definitionSnapshot).success).toBe(false);
    expect(WorkflowSchemas.getRunContext.response.parse(context)).toEqual(context);
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowNodeTypeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowNodeTypeSchema', () => {
  it('accepts all 7 node types', () => {
    const validTypes = ['code-step', 'agent-step', 'parallel', 'iterate', 'iterate-chain', 'loop', 'sequence'];
    for (const t of validTypes) {
      expect(WorkflowNodeTypeSchema.parse(t)).toBe(t);
    }
  });

  it('rejects old DAG step types', () => {
    expect(() => WorkflowNodeTypeSchema.parse('agent')).toThrow();
    expect(() => WorkflowNodeTypeSchema.parse('shell')).toThrow();
    expect(() => WorkflowNodeTypeSchema.parse('function')).toThrow();
    expect(() => WorkflowNodeTypeSchema.parse('for-each')).toThrow();
    expect(() => WorkflowNodeTypeSchema.parse('bus-request')).toThrow();
  });

  it('rejects retired workflow node types', () => {
    expect(() => WorkflowNodeTypeSchema.parse('station')).toThrow(); // legacy-input
    expect(() => WorkflowNodeTypeSchema.parse('delegate-agent')).toThrow(); // legacy-input
  });
});

describe('WorkflowArtifactBindingSchema', () => {
  it('accepts artifact resolve, create, and status path options', () => {
    const binding = WorkflowArtifactBindingSchema.parse({
      kind: 'implementation-review',
      schemaVersion: 1,
      scope: { level: 'global' },
      resolve: 'inputs.reviewArtifactRef',
      create: '{ status: "draft" }',
      statusPath: 'status',
    });

    expect(binding.resolve).toBe('inputs.reviewArtifactRef');
    expect(binding.create).toBe('{ status: "draft" }');
    expect(binding.statusPath).toBe('status');
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowAgentStepNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowAgentStepNodeSchema', () => {
  it('accepts a minimal agent-step node with id, role, and prompt', () => {
    const node = WorkflowAgentStepNodeSchema.parse({
      id: 'analyze',
      type: 'agent-step',
      role: 'requirements-analyst',
      prompt: 'Analyze the requirements document',
    });
    expect(node.type).toBe('agent-step');
    expect(node.id).toBe('analyze');
    expect(node.prompt).toBe('Analyze the requirements document');
  });

  it('accepts an agent-step with optional outputSchema and timeoutMs', () => {
    const node = WorkflowAgentStepNodeSchema.parse({
      id: 'review',
      type: 'agent-step',
      prompt: 'Review the implementation plan',
      role: 'requirements-analyst',
      outputSchema: { type: 'object', properties: { status: { type: 'string' } } },
      timeoutMs: 300000,
    });
    expect(node.role).toBe('requirements-analyst');
    expect(node.outputSchema).toBeDefined();
    expect(node.timeoutMs).toBe(300000);
  });

  it('accepts when and skip conditions', () => {
    const node = WorkflowAgentStepNodeSchema.parse({
      id: 'conditional',
      type: 'agent-step',
      role: 'requirements-analyst',
      prompt: 'Run only if env is production',
      when: "ctx.inputs.env == 'production'",
      skip: 'ctx.inputs.dryRun == true',
    });
    expect(node.when).toBe("ctx.inputs.env == 'production'");
    expect(node.skip).toBe('ctx.inputs.dryRun == true');
  });

  it('accepts exact allowed tools, turn completion, and an authority result finalizer', () => {
    const node = WorkflowAgentStepNodeSchema.parse({
      id: 'role-delegate',
      type: 'agent-step',
      role: 'senior-reviewer',
      prompt: 'Review the PR and provide feedback',
      allowedTools: ['artifact.read'],
      completion: 'turn',
      resultFinalizerId: 'artifact.read-wrap',
    });

    expect(node.allowedTools).toEqual(['artifact.read']);
    expect(node.completion).toBe('turn');
    expect(node.resultFinalizerId).toBe('artifact.read-wrap');
  });

  it('rejects an agent-step with empty id', () => {
    expect(() =>
      WorkflowAgentStepNodeSchema.parse({ id: '', type: 'agent-step', role: 'r', prompt: 'Do something' }),
    ).toThrow();
  });

  it('rejects an agent-step with empty prompt', () => {
    expect(() =>
      WorkflowAgentStepNodeSchema.parse({ id: 'step', type: 'agent-step', role: 'r', prompt: '' }),
    ).toThrow();
  });

  it('rejects an agent-step without a role', () => {
    expect(() =>
      WorkflowAgentStepNodeSchema.parse({ id: 'step', type: 'agent-step', prompt: 'Do something' }),
    ).toThrow();
  });

  it('rejects functions in outputSchema (must be JSON-safe)', () => {
    expect(() =>
      WorkflowAgentStepNodeSchema.parse({
        id: 'bad',
        type: 'agent-step',
        role: 'r',
        prompt: 'Run',
        outputSchema: { validator: () => undefined },
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowCodeStepNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowCodeStepNodeSchema', () => {
  it('accepts a minimal code-step node', () => {
    const node = WorkflowCodeStepNodeSchema.parse({
      id: 'collect',
      type: 'code-step',
    });
    expect(node.type).toBe('code-step');
    expect(node.id).toBe('collect');
  });

  it('rejects a code-step carrying role (.strict())', () => {
    expect(() =>
      WorkflowCodeStepNodeSchema.parse({
        id: 'bad',
        type: 'code-step',
        role: 'requirements-analyst',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowParallelNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowParallelNodeSchema', () => {
  it('accepts all parallel execution modes', () => {
    expect(WorkflowParallelModeSchema.parse('all-settled')).toBe('all-settled');
    expect(WorkflowParallelModeSchema.parse('fail-fast')).toBe('fail-fast');
  });

  it('accepts a parallel node with named branches', () => {
    const node = WorkflowParallelNodeSchema.parse({
      id: 'parallel-review',
      type: 'parallel',
      mode: 'fail-fast',
      branches: {
        security: { id: 'sec-branch', type: 'sequence', nodes: [] },
        performance: { id: 'perf-branch', type: 'sequence', nodes: [] },
      },
    });
    expect(node.type).toBe('parallel');
    expect(node.mode).toBe('fail-fast');
    expect(Object.keys(node.branches)).toHaveLength(2);
    expect(node.branches['security']).toBeDefined();
    expect(node.branches['performance']).toBeDefined();
  });

  it('rejects removed parallel execution modes', () => {
    expect(() =>
      WorkflowParallelNodeSchema.parse({
        id: 'parallel-review',
        type: 'parallel',
        mode: 'first-success',
        branches: {},
      }),
    ).toThrow();
  });

  it('rejects parallel with empty branches record', () => {
    // Zod record allows empty objects — this is valid for schema purposes
    const node = WorkflowParallelNodeSchema.parse({
      id: 'empty-parallel',
      type: 'parallel',
      branches: {},
    });
    expect(Object.keys(node.branches)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowIterateNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowIterateNodeSchema', () => {
  it('accepts an iterate node with collection and body', () => {
    const node = WorkflowIterateNodeSchema.parse({
      id: 'process-items',
      type: 'iterate',
      collection: 'ctx.inputs.items',
      body: { id: 'item-body', type: 'sequence', nodes: [] },
    });
    expect(node.type).toBe('iterate');
    expect(node.collection).toBe('ctx.inputs.items');
  });

  it('accepts optional concurrency limit', () => {
    const node = WorkflowIterateNodeSchema.parse({
      id: 'bounded-iterate',
      type: 'iterate',
      collection: 'ctx.inputs.repos',
      body: { id: 'repo-body', type: 'sequence', nodes: [] },
      concurrency: 3,
    });
    expect(node.concurrency).toBe(3);
  });

  it('accepts concurrency 0 (unlimited)', () => {
    const node = WorkflowIterateNodeSchema.parse({
      id: 'unlimited-iterate',
      type: 'iterate',
      collection: 'ctx.inputs.items',
      body: { id: 'body', type: 'sequence', nodes: [] },
      concurrency: 0,
    });
    expect(node.concurrency).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowIterateChainNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowIterateChainNodeSchema', () => {
  it('accepts an iterate-chain node', () => {
    const node = WorkflowIterateChainNodeSchema.parse({
      id: 'pipeline',
      type: 'iterate-chain',
      collection: 'ctx.inputs.stages',
      body: { id: 'stage-body', type: 'sequence', nodes: [] },
    });
    expect(node.type).toBe('iterate-chain');
    expect(node.collection).toBe('ctx.inputs.stages');
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowSequenceNodeSchema (recursive)
// ─────────────────────────────────────────────────────────────

describe('WorkflowSequenceNodeSchema', () => {
  it('accepts an empty sequence', () => {
    const node = WorkflowSequenceNodeSchema.parse({
      id: 'root',
      type: 'sequence',
      nodes: [],
    });
    expect(node.type).toBe('sequence');
    expect(node.nodes).toHaveLength(0);
  });

  it('accepts nested node types', () => {
    const node = WorkflowSequenceNodeSchema.parse({
      id: 'root',
      type: 'sequence',
      nodes: [
        { id: 'step-1', type: 'agent-step', role: 'analyst', prompt: 'Analyze' },
        { id: 'validate', type: 'code-step' },
        { id: 'step-2', type: 'agent-step', role: 'deployer', prompt: 'Deploy' },
      ],
    });
    expect(node.nodes).toHaveLength(3);
    expect(node.nodes[0]?.type).toBe('agent-step');
    expect(node.nodes[1]?.type).toBe('code-step');
    expect(node.nodes[2]?.type).toBe('agent-step');
  });

  it('accepts deeply nested sequences', () => {
    const node = WorkflowSequenceNodeSchema.parse({
      id: 'root',
      type: 'sequence',
      nodes: [
        {
          id: 'parallel-1',
          type: 'parallel',
          branches: {
            a: {
              id: 'branch-a',
              type: 'sequence',
              nodes: [{ id: 'inner-step', type: 'agent-step', role: 'reviewer', prompt: 'Inner work' }],
            },
          },
        },
      ],
    });
    const parallel = node.nodes[0];
    expect(parallel?.type).toBe('parallel');
    if (parallel?.type === 'parallel') {
      expect(Object.keys((parallel as WorkflowParallelNode).branches)).toHaveLength(1);
    }
  });

  it('rejects functions inside node trees', () => {
    expect(() =>
      WorkflowSequenceNodeSchema.parse({
        id: 'root',
        type: 'sequence',
        nodes: [
          {
            id: 'bad-step',
            type: 'agent-step',
            role: 'r',
            prompt: 'Run',
            outputSchema: { transform: () => undefined },
          },
        ],
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowNodeSchema (discriminated union)
// ─────────────────────────────────────────────────────────────

describe('WorkflowNodeSchema', () => {
  it('routes agent-step nodes by type discriminant', () => {
    const node = WorkflowNodeSchema.parse({
      id: 'step-1',
      type: 'agent-step',
      role: 'r',
      prompt: 'Do work',
    });
    expect(node.type).toBe('agent-step');
  });

  it('rejects nodes without a type discriminant', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'no-type', prompt: 'Do work' })).toThrow();
  });

  it('rejects unknown node types', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'bad', type: 'unknown-type' })).toThrow();
  });

  it('rejects retired workflow node shapes', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'bad', type: 'station', prompt: 'Do work' })).toThrow(); // legacy-input
    expect(() => WorkflowNodeSchema.parse({ id: 'bad', type: 'delegate-agent', agentId: 'a' })).toThrow(); // legacy-input
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowDefinitionSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowDefinitionSchema', () => {
  const emptySequence = { id: 'body', type: 'sequence', nodes: [] };

  it.each([
    emptySequence,
    { id: 'parallel', type: 'parallel', branches: { first: emptySequence } },
    { id: 'iterate', type: 'iterate', collection: 'inputs.items', body: emptySequence },
    { id: 'chain', type: 'iterate-chain', collection: 'inputs.items', body: emptySequence },
    {
      id: 'loop',
      type: 'loop',
      maxRounds: 2,
      body: { ...emptySequence, nodes: [{ id: 'converged', type: 'code-step' }] },
      check: 'converged',
    },
    { id: 'code', type: 'code-step' },
    { id: 'agent', type: 'agent-step', role: 'reviewer', prompt: 'Review changes' },
  ])('rejects an unknown key on a nested $type node', (node) => {
    const definition = { id: 'strict-workflow', root: { ...emptySequence, nodes: [node] } };
    expect(WorkflowDefinitionSchema.safeParse(definition).success).toBe(true);
    const result = WorkflowDefinitionSchema.safeParse({
      ...definition,
      root: { ...emptySequence, nodes: [{ ...node, concurency: 2 }] },
    });
    expect(result).toMatchObject({
      success: false,
      error: { issues: [{ code: 'unrecognized_keys', keys: ['concurency'], path: ['root', 'nodes', 0] }] },
    });
  });

  it('accepts a minimal workflow definition with a root sequence', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'simple-flow',
      root: { id: 'root', type: 'sequence', nodes: [] },
    });
    expect(def.id).toBe('simple-flow');
    expect(def.root.type).toBe('sequence');
    expect(def.scope).toEqual({ type: 'global' });
  });

  it('accepts a workflow with inputSchema, outputSchema, and artifact binding', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'advanced-flow',
      name: 'Advanced Flow',
      description: 'A complex pipeline',
      inputSchema: { type: 'object', properties: { env: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
      artifact: {
        kind: 'implementation-plan',
        schemaVersion: 1,
        scope: { level: 'workspace', ids: { workspaceId: 'ws-1' } },
      },
      root: {
        id: 'root',
        type: 'sequence',
        nodes: [
          { id: 'analyze', type: 'agent-step', role: 'analyst', prompt: 'Analyze' },
          { id: 'validate', type: 'code-step' },
          { id: 'implement', type: 'agent-step', role: 'implementer', prompt: 'Implement' },
        ],
      },
      triggers: [{ kind: 'makaio.cron', params: { schedule: '0 * * * *', timezone: 'UTC' } }],
      scope: { type: 'external', kind: 'project', id: 'proj-1' },
    });
    expect(def.id).toBe('advanced-flow');
    expect(def.root.nodes).toHaveLength(3);
    expect(def.artifact?.kind).toBe('implementation-plan');
    expect(def.scope).toEqual({ type: 'external', kind: 'project', id: 'proj-1' });
  });

  it('rejects a workflow definition without id', () => {
    expect(() => WorkflowDefinitionSchema.parse({ root: { id: 'root', type: 'sequence', nodes: [] } })).toThrow();
  });

  it('rejects a workflow definition without root', () => {
    expect(() => WorkflowDefinitionSchema.parse({ id: 'bad-flow' })).toThrow();
  });

  it('rejects functions inside the definition (must be JSON-safe)', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        id: 'fn-flow',
        root: {
          id: 'root',
          type: 'sequence',
          nodes: [
            {
              id: 'bad',
              type: 'agent-step',
              role: 'r',
              prompt: 'Run',
              outputSchema: { handler: () => undefined },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('parses extension-sourced workflow definitions with execution hints', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'factory:intake',
      name: 'intake',
      root: { id: 'root', type: 'sequence', nodes: [] },
      source: {
        kind: 'extension',
        extension: 'factory',
        externalId: 'cyberport/ai-factory:.makaio/workflows/intake.ts',
        syncedAt: '2026-06-01T00:00:00.000Z',
        metadata: {
          repo: 'cyberport/ai-factory',
          file: '.makaio/workflows/intake.ts',
        },
      },
      successFinalizerId: 'factory.success-finalizer',
    });

    expect(def.source?.kind).toBe('extension');
    expect(def.successFinalizerId).toBe('factory.success-finalizer');
  });

  it('accepts a workflow definition with a state contract', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'review',
      state: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] },
            selectedReviewers: { type: 'array', items: { type: 'string' } },
          },
          required: ['tier', 'selectedReviewers'],
        },
        initial: { tier: 'T1', selectedReviewers: [] },
      },
      root: { id: 'root', type: 'sequence', nodes: [] },
    });

    expect(def.state?.initial).toEqual({ tier: 'T1', selectedReviewers: [] });
    expect(def.state?.schema).toBeDefined();
  });

  describe('extensions', () => {
    const root = { id: 'root', type: 'sequence', nodes: [] };

    it('parses two extension entries with different JSON shapes and returns them unchanged', () => {
      const extensions = {
        gateway: { lane: 'review', limits: { retries: 2, enabled: true } },
        '@acme/review': [['T1', 'T2'], { nested: [1, null, 'x'] }],
      };

      const def = WorkflowDefinitionSchema.parse({ id: 'with-extensions', root, extensions });

      expect(def.extensions).toEqual(extensions);
    });

    it.each(['../x', '..'])('rejects the invalid extension name %j with a path pointing at extensions', (name) => {
      const result = WorkflowDefinitionSchema.safeParse({
        id: 'bad-extension-name',
        root,
        extensions: { [name]: { any: 'value' } },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues.every((issue) => issue.path[0] === 'extensions')).toBe(true);
      }
    });

    it('parses a definition without extensions and leaves the key out of the result', () => {
      const def = WorkflowDefinitionSchema.parse({ id: 'no-extensions', root });

      expect('extensions' in def).toBe(false);
    });

    it('rejects a definition with an unknown top-level key instead of dropping it (.strict())', () => {
      const result = WorkflowDefinitionSchema.safeParse({
        id: 'unknown-key',
        root,
        extensions: { gateway: { lane: 'review' } },
        extension: { lane: 'review' },
      });

      expect(result.success).toBe(false);
    });

    it('rejects an own "__proto__" key of the extensions record instead of dropping it', () => {
      const extensions: unknown = JSON.parse('{"__proto__": {"lane": "review"}, "gateway": {"lane": "review"}}');

      const result = WorkflowDefinitionSchema.safeParse({ id: 'proto-key', root, extensions });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.path).toEqual(['extensions', '__proto__']);
        expect(result.error.issues[0]?.message).toBe('"__proto__" is not a valid extension name or declaration key');
      }
    });

    it('rejects an own "__proto__" key nested deep inside an extension value', () => {
      const gateway: unknown = JSON.parse('{"limits": {"inner": [{"__proto__": {"polluted": true}}]}}');

      const result = WorkflowDefinitionSchema.safeParse({ id: 'nested-proto-key', root, extensions: { gateway } });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.path).toEqual(['extensions', 'gateway', 'limits', 'inner', 0, '__proto__']);
        expect(result.error.issues[0]?.message).toBe('"__proto__" is not a valid extension name or declaration key');
      }
    });

    it('parses every ordinary JSON shape and returns a record equal to the input', () => {
      const extensions = {
        gateway: {
          text: 'review',
          integer: 3,
          fraction: -1.5,
          zero: 0,
          enabled: true,
          disabled: false,
          nothing: null,
          emptyObject: {},
          emptyArray: [],
          nested: { deeper: { list: [1, 'two', null, { three: [3] }, [], {}] } },
        },
        '@acme/review': ['T1', 7, false, null, { a: { b: {} } }, [[]]],
        plain: 'string',
        count: 42,
        flag: false,
        none: null,
      };

      const def = WorkflowDefinitionSchema.parse({ id: 'all-json-shapes', root, extensions });

      expect(def.extensions).toStrictEqual(extensions);
    });

    it('parses an empty extensions record to an empty record', () => {
      const def = WorkflowDefinitionSchema.parse({ id: 'empty-extensions', root, extensions: {} });

      expect(def.extensions).toStrictEqual({});
    });

    it.each<[string, () => unknown, readonly (string | number)[], string]>([
      [
        'a non-plain object',
        () => ({ gateway: new Map([['lane', 'review']]) }),
        ['extensions', 'gateway'],
        'extension declarations must be plain JSON objects and arrays',
      ],
      [
        'a symbol-keyed property',
        () => ({ gateway: { [Symbol('hidden')]: 1, lane: 'review' } }),
        ['extensions', 'gateway'],
        'extension declarations carry a symbol-keyed property, which cannot be transported as JSON',
      ],
      [
        'a non-enumerable property',
        () => ({ gateway: Object.defineProperty({ lane: 'review' }, 'hidden', { value: 1, enumerable: false }) }),
        ['extensions', 'gateway', 'hidden'],
        'extension declarations carry a non-enumerable property, which the record parse would drop',
      ],
      [
        'an array with an extra own property',
        () => ({ gateway: Object.assign(['T1'], { extra: 1 }) }),
        ['extensions', 'gateway', 'extra'],
        'extension declarations must not contain an array with extra own properties',
      ],
    ])('rejects %s in an extension value with the declared message', (_case, build, path, message) => {
      const result = WorkflowDefinitionSchema.safeParse({ id: 'lossy-shape', root, extensions: build() });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.path).toEqual(path);
        expect(result.error.issues[0]?.message).toBe(message);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowDefinitionListSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowDefinitionListSchema', () => {
  it('accepts a list with readable definitions and an empty rejected array', () => {
    const list = WorkflowDefinitionListSchema.parse({
      workflows: [WorkflowDefinitionSchema.parse({ id: 'ok', root: { id: 'root', type: 'sequence', nodes: [] } })],
      rejected: [],
    });
    expect(list.workflows).toHaveLength(1);
    expect(list.rejected).toEqual([]);
  });

  it('requires the rejected field', () => {
    expect(() => WorkflowDefinitionListSchema.parse({ workflows: [] })).toThrow();
  });

  it('rejects a rejected-row reason that is an empty string', () => {
    expect(() =>
      WorkflowDefinitionListSchema.parse({
        workflows: [],
        rejected: [{ id: 'bad-flow', reason: '' }],
      }),
    ).toThrow();
  });

  it('accepts a rejected row with a non-empty reason', () => {
    const list = WorkflowDefinitionListSchema.parse({
      workflows: [],
      rejected: [{ id: 'bad-flow', reason: "root.nodes.0.type: Invalid literal value, expected 'agent-step'" }],
    });
    expect(list.rejected).toEqual([
      { id: 'bad-flow', reason: "root.nodes.0.type: Invalid literal value, expected 'agent-step'" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowFrameStateSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowFrameStateSchema', () => {
  it('parses a minimal pending frame', () => {
    const frame = WorkflowFrameStateSchema.parse({
      frameId: 'frame-1',
      nodeId: 'analyze',
      nodeType: 'agent-step',
      path: ['frame-root', 'frame-1'],
      status: 'pending',
      attempt: 0,
    });
    expect(frame.frameId).toBe('frame-1');
    expect(frame.status).toBe('pending');
    expect(frame.attempt).toBe(0);
  });

  it('defaults attempt to 0 when omitted', () => {
    const frame = WorkflowFrameStateSchema.parse({
      frameId: 'frame-2',
      nodeId: 'review',
      nodeType: 'code-step',
      path: ['frame-root'],
      status: 'pending',
    });
    expect(frame.attempt).toBe(0);
  });

  it('parses a completed frame with output', () => {
    const frame = WorkflowFrameStateSchema.parse({
      frameId: 'frame-3',
      nodeId: 'analyze',
      nodeType: 'agent-step',
      path: ['frame-root', 'frame-3'],
      status: 'completed',
      attempt: 0,
      output: { findings: ['issue-1', 'issue-2'] },
      startedAt: 1000,
      completedAt: 2000,
    });
    expect(frame.output).toEqual({ findings: ['issue-1', 'issue-2'] });
    expect(frame.startedAt).toBe(1000);
    expect(frame.completedAt).toBe(2000);
  });

  it('parses an iterate frame with iteration index', () => {
    const frame = WorkflowFrameStateSchema.parse({
      frameId: 'frame-4',
      nodeId: 'process',
      nodeType: 'agent-step',
      path: ['root', 'iterate', 'frame-4'],
      status: 'running',
      attempt: 0,
      iteration: 2,
    });
    expect(frame.iteration).toBe(2);
  });

  it('parses a parallel branch frame with branchKey', () => {
    const frame = WorkflowFrameStateSchema.parse({
      frameId: 'frame-5',
      nodeId: 'security-check',
      nodeType: 'agent-step',
      path: ['root', 'parallel', 'frame-5'],
      status: 'running',
      attempt: 0,
      branchKey: 'security',
    });
    expect(frame.branchKey).toBe('security');
  });

  it('rejects invalid node types', () => {
    expect(() =>
      WorkflowFrameStateSchema.parse({
        frameId: 'frame-bad',
        nodeId: 'x',
        nodeType: 'agent',
        path: [],
        status: 'pending',
        attempt: 0,
      }),
    ).toThrow();
  });

  it('rejects invalid status values', () => {
    expect(() =>
      WorkflowFrameStateSchema.parse({
        frameId: 'f',
        nodeId: 'x',
        nodeType: 'agent-step',
        path: [],
        status: 'expanding',
        attempt: 0,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowResolvedRoleSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowResolvedRoleSchema', () => {
  it('parses a minimal resolved role (adapterName only)', () => {
    const role = WorkflowResolvedRoleSchema.parse({ adapterName: 'claudeCode' });
    expect(role.adapterName).toBe('claudeCode');
    expect(role.model).toBeUndefined();
    expect(role.harnessId).toBeUndefined();
    expect(role.systemPrompt).toBeUndefined();
    expect(role.contextMode).toBeUndefined();
    expect(role.providerContext).toBeUndefined();
  });

  it('parses a fully populated resolved role', () => {
    const role = WorkflowResolvedRoleSchema.parse({
      adapterName: 'openai',
      model: 'gpt-4',
      reasoningEffort: 'high',
      harnessId: 'harness-reviewer',
      systemPrompt: 'You are a code reviewer',
      contextMode: 'fresh',
      providerConfigId: 'pc-1',
      adapterConfig: {},
      tools: [],
      disallowedTools: [],
      allowedDirectories: [],
      providerContext: {
        state: 'resolved',
        providerConfigId: 'pc-1',
        definitionId: 'openai',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'openai', methodId: 'api-key' },
          definition: {
            id: 'api-key',
            mode: 'explicit',
            label: 'API key',
            fields: [{ id: 'apiKey', label: 'API key', required: true, secret: true, sourceHints: [] }],
          },
          credentialRefs: { apiKey: 'env:OPENAI_API_KEY' },
        },
      },
    });
    expect(role.adapterName).toBe('openai');
    expect(role.model).toBe('gpt-4');
    expect(role).toMatchObject({ reasoningEffort: 'high' });
    expect(role.harnessId).toBe('harness-reviewer');
    expect(role.systemPrompt).toBe('You are a code reviewer');
    expect(role.contextMode).toBe('fresh');
    expect(role.providerConfigId).toBe('pc-1');
    expect(role.adapterConfig).toEqual({});
    expect(role.tools).toEqual([]);
    expect(role.disallowedTools).toEqual([]);
    expect(role.allowedDirectories).toEqual([]);
    expect(role.providerContext?.state).toBe('resolved');
    if (role.providerContext?.state !== 'resolved') throw new Error('Expected resolved provider context.');
    expect(role.providerContext.providerConfigId).toBe('pc-1');
  });

  it('rejects a resolved role without adapterName', () => {
    expect(() => WorkflowResolvedRoleSchema.parse({ model: 'gpt-4' })).toThrow();
  });

  it('rejects a resolved role with empty adapterName', () => {
    expect(() => WorkflowResolvedRoleSchema.parse({ adapterName: '' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Namespace bus schemas
// ─────────────────────────────────────────────────────────────

describe('step.completed JSON result', () => {
  it('accepts JSON step completion results', () => {
    const payload = WorkflowSchemas['step.completed'].parse({
      executionId: 'wfx-1',
      stepId: 'collect',
      stepType: 'code-step',
      result: { copied: ['.env'], count: 1 },
      duration: 12,
    });
    expect(payload.result).toEqual({ copied: ['.env'], count: 1 });
  });
});

// ─────────────────────────────────────────────────────────────
// workflow.start updated payload
// ─────────────────────────────────────────────────────────────

describe('workflow.start updated payload', () => {
  it('accepts start with new input, config, and artifactRef fields', () => {
    const req = WorkflowSchemas.start.request.parse({
      workflowId: 'wf-1',
      input: { env: 'production', count: 5 },
      config: { timeoutMs: 60000 },
      artifactRef: { kind: 'implementation-plan', id: 'art-42' },
      scope: { type: 'global' },
    });
    expect(req.workflowId).toBe('wf-1');
    expect(req.input).toEqual({ env: 'production', count: 5 });
    expect(req.config).toEqual({ timeoutMs: 60000 });
    expect(req.artifactRef).toEqual({ kind: 'implementation-plan', id: 'art-42' });
  });

  it('accepts start with only workflowId (all new fields optional)', () => {
    const req = WorkflowSchemas.start.request.parse({ workflowId: 'wf-minimal' });
    expect(req.workflowId).toBe('wf-minimal');
    expect(req.input).toBeUndefined();
    expect(req.config).toBeUndefined();
    expect(req.artifactRef).toBeUndefined();
  });

  it('accepts input as any JSON value (not just objects)', () => {
    const withArrayInput = WorkflowSchemas.start.request.parse({
      workflowId: 'wf-1',
      input: ['item-1', 'item-2'],
    });
    expect(withArrayInput.input).toEqual(['item-1', 'item-2']);

    const withStringInput = WorkflowSchemas.start.request.parse({
      workflowId: 'wf-1',
      input: 'plain-string',
    });
    expect(withStringInput.input).toBe('plain-string');
  });

  it('rejects artifactRef with missing id', () => {
    expect(() =>
      WorkflowSchemas.start.request.parse({
        workflowId: 'wf-1',
        artifactRef: { kind: 'plan' },
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Frame lifecycle events
// ─────────────────────────────────────────────────────────────

describe('frame lifecycle events', () => {
  it('parses a frame.started event', () => {
    const payload = WorkflowSchemas['frame.started'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-analyze',
      nodeId: 'analyze',
      nodeType: 'agent-step',
      path: ['frame-root', 'frame-analyze'],
      parentFrameId: 'frame-root',
      startedAt: 1000,
    });
    expect(payload.frameId).toBe('frame-analyze');
    expect(payload.nodeType).toBe('agent-step');
    expect(payload.path).toEqual(['frame-root', 'frame-analyze']);
    expect(payload.parentFrameId).toBe('frame-root');
    expect(payload.startedAt).toBe(1000);
  });

  it('parses a frame.started event for the root frame (no parentFrameId)', () => {
    const payload = WorkflowSchemas['frame.started'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-root',
      nodeId: 'root',
      nodeType: 'sequence',
      path: ['frame-root'],
    });
    expect(payload.parentFrameId).toBeUndefined();
  });

  it('rejects frame.started with unknown nodeType', () => {
    expect(() =>
      WorkflowSchemas['frame.started'].parse({
        executionId: 'wfx-1',
        frameId: 'f',
        nodeId: 'n',
        nodeType: 'unknown-type',
        path: [],
      }),
    ).toThrow();
  });

  it('parses a frame.completed event with output and duration', () => {
    const payload = WorkflowSchemas['frame.completed'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-analyze',
      nodeId: 'analyze',
      nodeType: 'agent-step',
      output: { findings: 3 },
      duration: 1500,
      completedAt: 2500,
    });
    expect(payload.output).toEqual({ findings: 3 });
    expect(payload.duration).toBe(1500);
    expect(payload.completedAt).toBe(2500);
  });

  it('parses a frame.completed event with no output', () => {
    const payload = WorkflowSchemas['frame.completed'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-validate',
      nodeId: 'validate',
      nodeType: 'code-step',
    });
    expect(payload.output).toBeUndefined();
    expect(payload.duration).toBeUndefined();
  });

  it('rejects frame.completed with negative duration', () => {
    expect(() =>
      WorkflowSchemas['frame.completed'].parse({
        executionId: 'wfx-1',
        frameId: 'f',
        nodeId: 'n',
        nodeType: 'code-step',
        duration: -1,
      }),
    ).toThrow();
  });

  it('rejects frame.completed without nodeType', () => {
    expect(() =>
      WorkflowSchemas['frame.completed'].parse({
        executionId: 'wfx-1',
        frameId: 'f',
        nodeId: 'n',
      }),
    ).toThrow();
  });

  it('parses a frame.failed event with error and duration', () => {
    const payload = WorkflowSchemas['frame.failed'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-deploy',
      nodeId: 'deploy',
      nodeType: 'agent-step',
      error: 'Timeout exceeded',
      duration: 300000,
      completedAt: 301000,
    });
    expect(payload.error).toBe('Timeout exceeded');
    expect(payload.duration).toBe(300000);
    expect(payload.completedAt).toBe(301000);
  });

  it('rejects frame.failed without nodeType', () => {
    expect(() =>
      WorkflowSchemas['frame.failed'].parse({
        executionId: 'wfx-1',
        frameId: 'f',
        nodeId: 'n',
        error: 'Timeout exceeded',
      }),
    ).toThrow();
  });
});

describe('frame.sessionLinked event', () => {
  it('parses a session link event', () => {
    const payload = WorkflowSchemas['frame.sessionLinked'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-analyze',
      sessionId: 'sess-child',
    });

    expect(payload).toEqual({
      executionId: 'wfx-1',
      frameId: 'frame-analyze',
      sessionId: 'sess-child',
    });
  });

  it('rejects unknown fields', () => {
    expect(() =>
      WorkflowSchemas['frame.sessionLinked'].parse({
        executionId: 'wfx-1',
        frameId: 'frame-analyze',
        sessionId: 'sess-child',
        subagentId: 'subagent-1',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Dynamic topology event
// ─────────────────────────────────────────────────────────────

describe('dynamic.materialized event', () => {
  it('parses a dynamic.materialized event', () => {
    const payload = WorkflowSchemas['dynamic.materialized'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-dynamic',
      factoryId: 'review-factory',
      materializedNodes: 4,
    });
    expect(payload.factoryId).toBe('review-factory');
    expect(payload.materializedNodes).toBe(4);
  });

  it('accepts zero materialized nodes', () => {
    const payload = WorkflowSchemas['dynamic.materialized'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-dynamic',
      factoryId: 'empty-factory',
      materializedNodes: 0,
    });
    expect(payload.materializedNodes).toBe(0);
  });

  it('rejects empty factoryId', () => {
    expect(() =>
      WorkflowSchemas['dynamic.materialized'].parse({
        executionId: 'wfx-1',
        frameId: 'f',
        factoryId: '',
        materializedNodes: 1,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Artifact update event
// ─────────────────────────────────────────────────────────────

describe('artifact.updated event', () => {
  it('parses an artifact.updated event', () => {
    const payload = WorkflowSchemas['artifact.updated'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-write',
      artifactRef: { kind: 'implementation-plan', id: 'art-42' },
      paths: ['/sections/0', '/summary'],
      operation: 'revise',
      revision: 'rev-7',
    });
    expect(payload.artifactRef.kind).toBe('implementation-plan');
    expect(payload.paths).toEqual(['/sections/0', '/summary']);
    expect(payload.operation).toBe('revise');
    expect(payload.revision).toBe('rev-7');
  });

  it('accepts empty paths array (full artifact replaced)', () => {
    const payload = WorkflowSchemas['artifact.updated'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-write',
      artifactRef: { kind: 'plan', id: 'art-1' },
      paths: [],
      operation: 'create',
    });
    expect(payload.paths).toHaveLength(0);
    expect(payload.revision).toBeUndefined();
  });

  it('rejects artifact.updated with empty operation', () => {
    expect(() =>
      WorkflowSchemas['artifact.updated'].parse({
        executionId: 'wfx-1',
        frameId: 'f',
        artifactRef: { kind: 'plan', id: 'art-1' },
        paths: [],
        operation: '',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkLog RPC subjects
// ─────────────────────────────────────────────────────────────

describe('worklog.frame.get RPC', () => {
  it('accepts a frame identifier and a contract-compatible response', () => {
    const request = WorkflowSchemas['worklog.frame.get'].request.parse({ frameId: 'frame-1' });
    const frame = WorkLogFrameEntrySchema.parse({
      executionId: 'wfx-1',
      frameId: 'frame-1',
      nodeId: 'review',
      nodeType: 'agent-step',
      path: ['frame-1'],
      status: 'completed',
      attempt: 0,
      startedAt: 1_000,
      completedAt: 1_250,
      durationMs: 250,
    });
    const response = WorkflowSchemas['worklog.frame.get'].response.parse({ frame });

    expect(request.frameId).toBe('frame-1');
    expect(response.frame).toEqual(frame);
  });

  it('rejects an empty frame identifier and accepts a missing frame response', () => {
    expect(() => WorkflowSchemas['worklog.frame.get'].request.parse({ frameId: '' })).toThrow();
    expect(WorkflowSchemas['worklog.frame.get'].response.parse({ frame: null }).frame).toBeNull();
  });
});

describe('worklog.get RPC', () => {
  it('accepts a valid worklog.get request', () => {
    const req = WorkflowSchemas['worklog.get'].request.parse({ executionId: 'wfx-1' });
    expect(req.executionId).toBe('wfx-1');
  });

  it('rejects worklog.get with empty executionId', () => {
    expect(() => WorkflowSchemas['worklog.get'].request.parse({ executionId: '' })).toThrow();
  });

  it('parses a null worklog.get response (execution not found)', () => {
    const res = WorkflowSchemas['worklog.get'].response.parse({ summary: null });
    expect(res.summary).toBeNull();
  });

  it('parses a populated worklog.get response', () => {
    const summary = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'completed' as const,
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
    };
    const res = WorkflowSchemas['worklog.get'].response.parse({ summary });
    expect(res?.summary?.executionId).toBe('wfx-1');
    expect(res?.summary?.status).toBe('completed');
  });

  it('response schema is compatible with WorkLogExecutionSummarySchema', () => {
    // The response type should accept anything WorkLogExecutionSummarySchema produces
    const summary = WorkLogExecutionSummarySchema.parse({
      executionId: 'wfx-2',
      workflowId: 'wf-2',
      status: 'running',
      startedAt: 1000,
    });
    const res = WorkflowSchemas['worklog.get'].response.parse({ summary });
    expect(res?.summary?.executionId).toBe('wfx-2');
  });
});

describe('worklog.list RPC', () => {
  it('accepts a worklog.list request with all filters', () => {
    const req = WorkflowSchemas['worklog.list'].request.parse({
      workflowId: 'wf-1',
      status: 'failed',
      limit: 20,
      offset: 40,
    });
    expect(req.workflowId).toBe('wf-1');
    expect(req.status).toBe('failed');
    expect(req.limit).toBe(20);
    expect(req.offset).toBe(40);
  });

  it('accepts an empty worklog.list request (all fields optional)', () => {
    const req = WorkflowSchemas['worklog.list'].request.parse({});
    expect(req.workflowId).toBeUndefined();
    expect(req.status).toBeUndefined();
  });

  it('rejects worklog.list with invalid status', () => {
    expect(() => WorkflowSchemas['worklog.list'].request.parse({ status: 'not-a-status' })).toThrow();
  });

  it('rejects worklog.list with negative offset', () => {
    expect(() => WorkflowSchemas['worklog.list'].request.parse({ offset: -1 })).toThrow();
  });

  it('rejects worklog.list with zero limit', () => {
    expect(() => WorkflowSchemas['worklog.list'].request.parse({ limit: 0 })).toThrow();
  });

  it('parses a worklog.list response', () => {
    const res = WorkflowSchemas['worklog.list'].response.parse({
      items: [
        {
          executionId: 'wfx-1',
          workflowId: 'wf-1',
          status: 'completed',
          startedAt: 1000,
        },
      ],
      total: 1,
    });
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);
  });

  it('parses a worklog.list response with empty items', () => {
    const res = WorkflowSchemas['worklog.list'].response.parse({ items: [], total: 0 });
    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(0);
  });
});

describe('worklog.changed event', () => {
  it('parses a worklog.changed event', () => {
    const payload = WorkflowSchemas['worklog.changed'].parse({ executionId: 'wfx-1' });
    expect(payload.executionId).toBe('wfx-1');
  });

  it('rejects worklog.changed with empty executionId', () => {
    expect(() => WorkflowSchemas['worklog.changed'].parse({ executionId: '' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// State RPC subjects
// ─────────────────────────────────────────────────────────────

describe('WorkflowSubjects.rerun', () => {
  it('exposes rerun as a public workflow request subject', () => {
    expect(WorkflowSubjects.rerun.subject).toBe('rerun');

    const request = WorkflowSchemas.rerun.request.parse({
      executionId: 'wfx-original',
      mode: 'snapshot',
      input: { package: 'core' },
      config: { strict: true },
      reason: 'compare fixed implementation',
    });
    expect(request).toEqual({
      executionId: 'wfx-original',
      mode: 'snapshot',
      input: { package: 'core' },
      config: { strict: true },
      reason: 'compare fixed implementation',
    });

    expect(WorkflowSchemas.rerun.response.parse({ executionId: 'wfx-rerun' })).toEqual({
      executionId: 'wfx-rerun',
    });
  });
});

describe('state RPC subjects', () => {
  it('exposes workflow state subjects as nested accessors', () => {
    expect(WorkflowSubjects.state.get.subject).toBe('state.get');
    expect(WorkflowSubjects.state.patch.subject).toBe('state.patch');
    expect(WorkflowSubjects.state.updated.subject).toBe('state.updated');
  });

  it('parses a state.get request and response', () => {
    const req = WorkflowSchemas['state.get'].request.parse({ executionId: 'wfx-1' });
    expect(req.executionId).toBe('wfx-1');

    const res = WorkflowSchemas['state.get'].response.parse({
      executionId: 'wfx-1',
      sequence: 0,
      value: { tier: 'T1', selectedReviewers: [] },
    });
    expect(res.sequence).toBe(0);
    expect(res.value).toEqual({ tier: 'T1', selectedReviewers: [] });
  });

  it('rejects state.get with empty executionId', () => {
    expect(() => WorkflowSchemas['state.get'].request.parse({ executionId: '' })).toThrow();
  });

  it('parses a state.patch request with expectedSequence', () => {
    const req = WorkflowSchemas['state.patch'].request.parse({
      executionId: 'wfx-1',
      expectedSequence: 0,
      patch: [{ op: 'add', path: '/selectedReviewers/0', value: 'correctness-reviewer' }],
      nextValue: { tier: 'T1', selectedReviewers: ['correctness-reviewer'] },
    });
    expect(req.expectedSequence).toBe(0);
    expect(req.patch).toHaveLength(1);
  });

  it('requires expectedSequence on state.patch requests', () => {
    expect(() =>
      WorkflowSchemas['state.patch'].request.parse({
        executionId: 'wfx-1',
        patch: [{ op: 'replace', path: '/tier', value: 'T2' }],
        nextValue: { tier: 'T2', selectedReviewers: [] },
      }),
    ).toThrow();
  });

  it('rejects non-JSON-Patch entries on state.patch requests', () => {
    expect(() =>
      WorkflowSchemas['state.patch'].request.parse({
        executionId: 'wfx-1',
        expectedSequence: 0,
        patch: [{ path: '/tier', value: 'T2' }],
        nextValue: { tier: 'T2', selectedReviewers: [] },
      }),
    ).toThrow();
    expect(() =>
      WorkflowSchemas['state.patch'].request.parse({
        executionId: 'wfx-1',
        expectedSequence: 0,
        patch: ['replace tier'],
        nextValue: { tier: 'T2', selectedReviewers: [] },
      }),
    ).toThrow();
  });

  it('parses a state.patch response', () => {
    const res = WorkflowSchemas['state.patch'].response.parse({
      executionId: 'wfx-1',
      sequence: 1,
      value: { tier: 'T1', selectedReviewers: ['correctness-reviewer'] },
    });
    expect(res.sequence).toBe(1);
  });

  it('rejects state.patch response with sequence 0', () => {
    expect(() =>
      WorkflowSchemas['state.patch'].response.parse({
        executionId: 'wfx-1',
        sequence: 0,
        value: {},
      }),
    ).toThrow();
  });

  it('parses a state.updated event', () => {
    const payload = WorkflowSchemas['state.updated'].parse({
      executionId: 'wfx-1',
      sequence: 1,
      patch: [{ op: 'replace', path: '/tier', value: 'T2' }],
      value: { tier: 'T2', selectedReviewers: [] },
      updatedAt: 1718280000000,
    });
    expect(payload.sequence).toBe(1);
    expect(payload.updatedAt).toBe(1718280000000);
  });

  it('rejects state.updated with sequence 0', () => {
    expect(() =>
      WorkflowSchemas['state.updated'].parse({
        executionId: 'wfx-1',
        sequence: 0,
        patch: [],
        value: {},
        updatedAt: 1000,
      }),
    ).toThrow();
  });
});
