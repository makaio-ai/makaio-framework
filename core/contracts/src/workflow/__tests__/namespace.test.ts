import { describe, expect, it } from 'vitest';
import { getObservabilitySchemaPolicy } from '@makaio/core';
import {
  WorkflowResolvedAgentSchema,
  WorkflowResolvedRoleSchema,
  WorkflowStationNodeSchema,
  WorkflowDelegateAgentNodeSchema,
  WorkflowDelegateRoleNodeSchema,
  WorkflowGateNodeSchema,
  WorkflowParallelNodeSchema,
  WorkflowIterateNodeSchema,
  WorkflowIterateChainNodeSchema,
  WorkflowSequenceNodeSchema,
  WorkflowNodeSchema,
  WorkflowDefinitionSchema,
  WorkflowArtifactBindingSchema,
  WorkflowFrameStateSchema,
  WorkflowGateInstanceSchema,
  WorkflowNodeTypeSchema,
  WorkflowParallelModeSchema,
} from '../schemas.js';
import type { WorkflowParallelNode } from '../schemas.js';
import { WorkflowProgressUpdateSchema, WorkflowSchemas, WorkflowSubjects } from '../namespace.js';
import { WorkLogExecutionSummarySchema } from '../worklog.js';

// ─────────────────────────────────────────────────────────────
// Namespace subjects
// ─────────────────────────────────────────────────────────────

describe('WorkflowNamespace', () => {
  it('exposes dotted lifecycle subjects as nested accessors', () => {
    expect(WorkflowSubjects.start.subject).toBe('start');
    expect(WorkflowSubjects.gate.respond.subject).toBe('gate.respond');
    expect(WorkflowSubjects.gate.requested.subject).toBe('gate.requested');
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

  it('exposes gate suspension/resumption subjects as nested accessors', () => {
    expect(WorkflowSubjects.gate.suspended.subject).toBe('gate.suspended');
    expect(WorkflowSubjects.gate.resumed.subject).toBe('gate.resumed');
  });

  it('exposes public execution trace read subjects', () => {
    expect(WorkflowSubjects.listSpans.subject).toBe('listSpans');
    expect(WorkflowSubjects.listGateInstances.subject).toBe('listGateInstances');
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
    expect(WorkflowSubjects.worklog.list.subject).toBe('worklog.list');
    expect(WorkflowSubjects.worklog.stats.subject).toBe('worklog.stats');
    expect(WorkflowSubjects.worklog.changed.subject).toBe('worklog.changed');
  });
});

describe('execution lifecycle events', () => {
  it('marks paused execution events as traceAll for observability', () => {
    expect(getObservabilitySchemaPolicy(WorkflowSchemas['execution.paused'])).toEqual({ traceAll: true });
  });

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

describe('WorkflowSubjects.resolveAgent', () => {
  it('exposes the resolveAgent subject', () => {
    expect(WorkflowSubjects.resolveAgent.subject).toBe('resolveAgent');
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowNodeTypeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowNodeTypeSchema', () => {
  it('accepts all 8 node types', () => {
    const validTypes = [
      'station',
      'delegate-agent',
      'delegate-role',
      'parallel',
      'gate',
      'iterate',
      'iterate-chain',
      'sequence',
    ];
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
});

describe('WorkflowArtifactBindingSchema', () => {
  it('accepts artifact resolve, create, and status path options', () => {
    const binding = WorkflowArtifactBindingSchema.parse({
      kind: 'implementation-review',
      schemaVersion: '1',
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
// WorkflowStationNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowStationNodeSchema', () => {
  it('accepts a minimal station node with id and prompt', () => {
    const node = WorkflowStationNodeSchema.parse({
      id: 'analyze',
      type: 'station',
      prompt: 'Analyze the requirements document',
    });
    expect(node.type).toBe('station');
    expect(node.id).toBe('analyze');
    expect(node.prompt).toBe('Analyze the requirements document');
  });

  it('accepts a station with optional role and outputSchema', () => {
    const node = WorkflowStationNodeSchema.parse({
      id: 'review',
      type: 'station',
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
    const node = WorkflowStationNodeSchema.parse({
      id: 'conditional',
      type: 'station',
      prompt: 'Run only if env is production',
      when: "ctx.inputs.env == 'production'",
      skip: 'ctx.inputs.dryRun == true',
    });
    expect(node.when).toBe("ctx.inputs.env == 'production'");
    expect(node.skip).toBe('ctx.inputs.dryRun == true');
  });

  it('rejects a station with empty id', () => {
    expect(() => WorkflowStationNodeSchema.parse({ id: '', type: 'station', prompt: 'Do something' })).toThrow();
  });

  it('rejects a station with empty prompt', () => {
    expect(() => WorkflowStationNodeSchema.parse({ id: 'step', type: 'station', prompt: '' })).toThrow();
  });

  it('rejects functions in outputSchema (must be JSON-safe)', () => {
    expect(() =>
      WorkflowStationNodeSchema.parse({
        id: 'bad',
        type: 'station',
        prompt: 'Run',
        outputSchema: { validator: () => undefined },
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowDelegateAgentNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowDelegateAgentNodeSchema', () => {
  it('accepts a minimal delegate-agent node', () => {
    const node = WorkflowDelegateAgentNodeSchema.parse({
      id: 'delegate-1',
      type: 'delegate-agent',
      agentId: 'code-review-agent',
    });
    expect(node.type).toBe('delegate-agent');
    expect(node.agentId).toBe('code-review-agent');
  });

  it('accepts delegate-agent with inputExpression and outputSchema', () => {
    const node = WorkflowDelegateAgentNodeSchema.parse({
      id: 'delegate-1',
      type: 'delegate-agent',
      agentId: 'code-review-agent',
      inputExpression: 'ctx.frames["build"].output',
      outputSchema: { type: 'object' },
    });
    expect(node.inputExpression).toBe('ctx.frames["build"].output');
    expect(node.outputSchema).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowDelegateRoleNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowDelegateRoleNodeSchema', () => {
  it('accepts a minimal delegate-role node', () => {
    const node = WorkflowDelegateRoleNodeSchema.parse({
      id: 'role-delegate',
      type: 'delegate-role',
      role: 'senior-reviewer',
      prompt: 'Review the PR and provide feedback',
    });
    expect(node.type).toBe('delegate-role');
    expect(node.role).toBe('senior-reviewer');
    expect(node.prompt).toBe('Review the PR and provide feedback');
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowGateNodeSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowGateNodeSchema', () => {
  it('accepts a gate node with null timeoutMs', () => {
    const node = WorkflowGateNodeSchema.parse({
      id: 'approval',
      type: 'gate',
      prompt: 'Approve deployment to production?',
      autoAction: 'reject',
      timeoutMs: null,
    });
    expect(node.type).toBe('gate');
    expect(node.timeoutMs).toBeNull();
    expect(node.autoAction).toBe('reject');
  });

  it('accepts a gate with a numeric timeout', () => {
    const node = WorkflowGateNodeSchema.parse({
      id: 'timed-gate',
      type: 'gate',
      prompt: 'Review required',
      autoAction: 'approve',
      timeoutMs: 3600000,
      resumeSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
    });
    expect(node.timeoutMs).toBe(3600000);
    expect(node.resumeSchema).toBeDefined();
  });

  it('rejects gate without prompt', () => {
    expect(() =>
      WorkflowGateNodeSchema.parse({ id: 'g', type: 'gate', autoAction: 'reject', timeoutMs: null }),
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
        { id: 'step-1', type: 'station', prompt: 'Analyze' },
        {
          id: 'gate-1',
          type: 'gate',
          prompt: 'Approve?',
          autoAction: 'reject',
          timeoutMs: null,
        },
        { id: 'step-2', type: 'station', prompt: 'Deploy' },
      ],
    });
    expect(node.nodes).toHaveLength(3);
    expect(node.nodes[0]?.type).toBe('station');
    expect(node.nodes[1]?.type).toBe('gate');
    expect(node.nodes[2]?.type).toBe('station');
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
              nodes: [{ id: 'inner-station', type: 'station', prompt: 'Inner work' }],
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
            id: 'bad-station',
            type: 'station',
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
  it('routes station nodes by type discriminant', () => {
    const node = WorkflowNodeSchema.parse({
      id: 'station-1',
      type: 'station',
      prompt: 'Do work',
    });
    expect(node.type).toBe('station');
  });

  it('routes gate nodes by type discriminant', () => {
    const node = WorkflowNodeSchema.parse({
      id: 'gate-1',
      type: 'gate',
      prompt: 'Approve?',
      autoAction: 'approve',
      timeoutMs: 3600000,
    });
    expect(node.type).toBe('gate');
  });

  it('rejects nodes without a type discriminant', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'no-type', prompt: 'Do work' })).toThrow();
  });

  it('rejects unknown node types', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'bad', type: 'unknown-type' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowDefinitionSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowDefinitionSchema', () => {
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
        schemaVersion: '1',
        scope: { level: 'workspace', ids: { workspaceId: 'ws-1' } },
      },
      root: {
        id: 'root',
        type: 'sequence',
        nodes: [
          { id: 'analyze', type: 'station', prompt: 'Analyze' },
          {
            id: 'approve',
            type: 'gate',
            prompt: 'Approve plan?',
            autoAction: 'reject',
            timeoutMs: null,
          },
          { id: 'implement', type: 'station', prompt: 'Implement' },
        ],
      },
      triggers: [{ type: 'manual' }],
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
              type: 'station',
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
      executionHints: {
        requirements: {
          capabilities: ['makaio.factory.github-actions'],
        },
        providers: {
          'github-actions': {
            owner: 'cyberport',
            repo: 'ai-factory',
            workflowFile: '.github/workflows/makaio-dispatch.yml',
            sourceFile: '.makaio/workflows/intake.ts',
            ref: 'main',
          },
        },
      },
    });

    expect(def.source?.kind).toBe('extension');
    expect(def.executionHints?.requirements?.capabilities).toEqual(['makaio.factory.github-actions']);
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
});

// ─────────────────────────────────────────────────────────────
// WorkflowFrameStateSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowFrameStateSchema', () => {
  it('parses a minimal pending frame', () => {
    const frame = WorkflowFrameStateSchema.parse({
      frameId: 'frame-1',
      nodeId: 'analyze',
      nodeType: 'station',
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
      nodeType: 'gate',
      path: ['frame-root'],
      status: 'waiting',
    });
    expect(frame.attempt).toBe(0);
  });

  it('parses a completed frame with output', () => {
    const frame = WorkflowFrameStateSchema.parse({
      frameId: 'frame-3',
      nodeId: 'analyze',
      nodeType: 'station',
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
      nodeType: 'station',
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
      nodeType: 'station',
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
        nodeType: 'station',
        path: [],
        status: 'expanding',
        attempt: 0,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowGateInstanceSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowGateInstanceSchema', () => {
  it('parses a waiting gate instance with captured timeout policy', () => {
    const gate = WorkflowGateInstanceSchema.parse({
      executionId: 'wfx-1',
      nodeId: 'approval',
      frameId: 'frame-gate',
      schema: {},
      status: 'waiting',
      autoAction: 'approve',
      timeoutMs: 5000,
      createdAt: 1000,
    });

    expect(gate.autoAction).toBe('approve');
    expect(gate.timeoutMs).toBe(5000);
  });

  it('rejects gate instances without captured timeout policy', () => {
    expect(() =>
      WorkflowGateInstanceSchema.parse({
        executionId: 'wfx-1',
        nodeId: 'approval',
        frameId: 'frame-gate',
        schema: { type: 'object', properties: { approved: { type: 'boolean' } } },
        status: 'waiting',
        createdAt: 1000,
      }),
    ).toThrow();
  });

  it('parses a resumed gate instance with resumeData', () => {
    const gate = WorkflowGateInstanceSchema.parse({
      executionId: 'wfx-1',
      nodeId: 'approval',
      frameId: 'frame-gate',
      schema: { type: 'object' },
      status: 'resumed',
      autoAction: 'reject',
      timeoutMs: null,
      createdAt: 1000,
      resolvedAt: 2000,
      resumeData: { approved: true, comment: 'LGTM' },
    });
    expect(gate.status).toBe('resumed');
    expect(gate.resolvedAt).toBe(2000);
    expect(gate.resumeData).toEqual({ approved: true, comment: 'LGTM' });
  });

  it('parses a timed-out gate instance', () => {
    const gate = WorkflowGateInstanceSchema.parse({
      executionId: 'wfx-1',
      nodeId: 'approval',
      frameId: 'frame-gate',
      schema: {},
      status: 'timed-out',
      autoAction: 'reject',
      timeoutMs: null,
      createdAt: 1000,
      resolvedAt: 3600000,
    });
    expect(gate.status).toBe('timed-out');
  });

  it('parses a rejected gate instance with resumeData', () => {
    const gate = WorkflowGateInstanceSchema.parse({
      executionId: 'wfx-1',
      nodeId: 'approval',
      frameId: 'frame-gate',
      schema: {},
      status: 'rejected',
      autoAction: 'reject',
      timeoutMs: null,
      createdAt: 1000,
      resolvedAt: 2000,
      resumeData: { decision: 'rejected' },
    });
    expect(gate.status).toBe('rejected');
    expect(gate.resumeData).toEqual({ decision: 'rejected' });
  });

  it('rejects invalid gate status', () => {
    expect(() =>
      WorkflowGateInstanceSchema.parse({
        executionId: 'wfx-1',
        nodeId: 'g',
        frameId: 'f',
        schema: {},
        status: 'open',
        createdAt: 1000,
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
      providerContext: {
        providerConfigId: 'pc-1',
        definitionId: 'openai',
        credentialRefs: { apiKey: 'env:OPENAI_API_KEY' },
      },
    });
    expect(role.adapterName).toBe('openai');
    expect(role.model).toBe('gpt-4');
    expect(role).toMatchObject({ reasoningEffort: 'high' });
    expect(role.harnessId).toBe('harness-reviewer');
    expect(role.systemPrompt).toBe('You are a code reviewer');
    expect(role.contextMode).toBe('fresh');
    expect(role.providerContext?.providerConfigId).toBe('pc-1');
  });

  it('rejects a resolved role without adapterName', () => {
    expect(() => WorkflowResolvedRoleSchema.parse({ model: 'gpt-4' })).toThrow();
  });

  it('rejects a resolved role with empty adapterName', () => {
    expect(() => WorkflowResolvedRoleSchema.parse({ adapterName: '' })).toThrow();
  });
});

describe('WorkflowResolvedAgentSchema', () => {
  it('uses the same executable adapter config shape as resolved roles', () => {
    const agent = WorkflowResolvedAgentSchema.parse({
      adapterName: 'claudeCode',
      model: 'sonnet',
      harnessId: 'implementation-harness',
    });

    expect(agent).toEqual({
      adapterName: 'claudeCode',
      model: 'sonnet',
      harnessId: 'implementation-harness',
    });
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
      stepType: 'station',
      result: { copied: ['.env'], count: 1 },
      duration: 12,
    });
    expect(payload.result).toEqual({ copied: ['.env'], count: 1 });
  });
});

describe('gate.awaitApproval subject', () => {
  it('defines gate.awaitApproval as a request subject', () => {
    expect(WorkflowSubjects.gate.awaitApproval.subject).toBe('gate.awaitApproval');
    const request = WorkflowSchemas['gate.awaitApproval'].request.parse({
      executionId: 'wfx-1',
      stepId: 'approve',
      stepType: 'gate',
      workflowId: 'wf-1',
      workflowName: 'Workflow One',
      title: 'Approve',
      message: 'Continue?',
      autoAction: 'reject',
      timeoutMs: null,
      openedAt: 1,
    });
    expect(request.workflowId).toBe('wf-1');
  });

  it('rejects non-gate step types for gate approval payloads', () => {
    const gatePayload = {
      executionId: 'wfx-1',
      stepId: 'approve',
      stepType: 'station',
      workflowId: 'wf-1',
      workflowName: 'Workflow One',
      title: 'Approve',
      message: 'Continue?',
      autoAction: 'reject',
      timeoutMs: null,
      openedAt: 1,
    };

    expect(() => WorkflowSchemas['gate.requested'].parse(gatePayload)).toThrow();
    expect(() => WorkflowSchemas['gate.awaitApproval'].request.parse(gatePayload)).toThrow();
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
      executionHints: { priority: 'high' },
    });
    expect(req.workflowId).toBe('wf-1');
    expect(req.input).toEqual({ env: 'production', count: 5 });
    expect(req.config).toEqual({ timeoutMs: 60000 });
    expect(req.artifactRef).toEqual({ kind: 'implementation-plan', id: 'art-42' });
    expect(req.executionHints).toEqual({ priority: 'high' });
  });

  it('accepts start with only workflowId (all new fields optional)', () => {
    const req = WorkflowSchemas.start.request.parse({ workflowId: 'wf-minimal' });
    expect(req.workflowId).toBe('wf-minimal');
    expect(req.input).toBeUndefined();
    expect(req.config).toBeUndefined();
    expect(req.artifactRef).toBeUndefined();
    expect(req.executionHints).toBeUndefined();
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
// gate.respond updated payload
// ─────────────────────────────────────────────────────────────

describe('gate.respond updated payload', () => {
  it('accepts gate.respond with gateId, action, and resumeData', () => {
    const req = WorkflowSchemas['gate.respond'].request.parse({
      executionId: 'wfx-1',
      gateId: 'approval-gate',
      action: 'approve',
      resumeData: { approved: true, comment: 'LGTM' },
    });
    expect(req.gateId).toBe('approval-gate');
    expect(req.action).toBe('approve');
    expect(req.resumeData).toEqual({ approved: true, comment: 'LGTM' });
    expect(req.frameId).toBeUndefined();
  });

  it('accepts gate.respond with optional frameId for iterate gates', () => {
    const req = WorkflowSchemas['gate.respond'].request.parse({
      executionId: 'wfx-1',
      gateId: 'iter-gate',
      frameId: 'frame-42',
      action: 'approve',
      resumeData: { proceed: true },
      reason: 'Approved by reviewer',
    });
    expect(req.frameId).toBe('frame-42');
    expect(req.reason).toBe('Approved by reviewer');
  });

  it('accepts null resumeData (valid JSON value)', () => {
    const req = WorkflowSchemas['gate.respond'].request.parse({
      executionId: 'wfx-1',
      gateId: 'gate-1',
      action: 'approve',
      resumeData: null,
    });
    expect(req.resumeData).toBeNull();
  });

  it('rejects gate.respond without resumeData', () => {
    expect(() =>
      WorkflowSchemas['gate.respond'].request.parse({
        executionId: 'wfx-1',
        gateId: 'gate-1',
        action: 'approve',
      }),
    ).toThrow();
  });

  it('rejects gate.respond without an explicit action', () => {
    expect(() =>
      WorkflowSchemas['gate.respond'].request.parse({
        executionId: 'wfx-1',
        gateId: 'gate-1',
        resumeData: null,
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
      nodeType: 'station',
      path: ['frame-root', 'frame-analyze'],
      parentFrameId: 'frame-root',
      startedAt: 1000,
    });
    expect(payload.frameId).toBe('frame-analyze');
    expect(payload.nodeType).toBe('station');
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
      frameId: 'frame-gate',
      nodeId: 'gate-1',
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
        duration: -1,
      }),
    ).toThrow();
  });

  it('parses a frame.failed event with error and duration', () => {
    const payload = WorkflowSchemas['frame.failed'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-deploy',
      nodeId: 'deploy',
      error: 'Timeout exceeded',
      duration: 300000,
      completedAt: 301000,
    });
    expect(payload.error).toBe('Timeout exceeded');
    expect(payload.duration).toBe(300000);
    expect(payload.completedAt).toBe(301000);
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
// Gate suspension / resumption events
// ─────────────────────────────────────────────────────────────

describe('gate.suspended event', () => {
  it('parses a gate.suspended event with schema and prompt', () => {
    const payload = WorkflowSchemas['gate.suspended'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-gate',
      nodeId: 'approval',
      schema: { type: 'object', properties: { approved: { type: 'boolean' } } },
      prompt: 'Approve deployment to production?',
      title: 'Deployment approval',
      autoAction: 'reject',
      timeoutMs: 300000,
      openedAt: 1000,
    });
    expect(payload.nodeId).toBe('approval');
    expect(payload.schema).toBeDefined();
    expect(payload.prompt).toBe('Approve deployment to production?');
  });

  it('parses a gate.suspended event without prompt', () => {
    const payload = WorkflowSchemas['gate.suspended'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-gate',
      nodeId: 'gate-1',
      schema: {},
      autoAction: 'approve',
      timeoutMs: null,
      openedAt: 1000,
    });
    expect(payload.prompt).toBeUndefined();
  });
});

describe('gate.resumed event', () => {
  it('parses a gate.resumed event with resumeData', () => {
    const payload = WorkflowSchemas['gate.resumed'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-gate',
      nodeId: 'approval',
      resumeData: { approved: true, reviewer: 'alice' },
    });
    expect(payload.resumeData).toEqual({ approved: true, reviewer: 'alice' });
  });

  it('accepts null as resumeData', () => {
    const payload = WorkflowSchemas['gate.resumed'].parse({
      executionId: 'wfx-1',
      frameId: 'frame-gate',
      nodeId: 'gate-1',
      resumeData: null,
    });
    expect(payload.resumeData).toBeNull();
  });
});

describe('gate.resolved event', () => {
  it('parses frame-scoped gate resolution metadata', () => {
    const payload = WorkflowSchemas['gate.resolved'].parse({
      executionId: 'wfx-1',
      stepId: 'approval',
      stepType: 'gate',
      frameId: 'frame-gate',
      action: 'approve',
      source: 'user',
    });

    expect(payload.frameId).toBe('frame-gate');
    expect(payload.source).toBe('user');
    if (payload.source !== 'user') throw new Error('expected user gate resolution');
    expect(payload.action).toBe('approve');
  });

  it('parses cancelled gate settlement metadata without an approval action', () => {
    const payload = WorkflowSchemas['gate.resolved'].parse({
      executionId: 'wfx-1',
      stepId: 'approval',
      stepType: 'gate',
      frameId: 'frame-gate',
      source: 'cancelled',
    });

    expect(payload.frameId).toBe('frame-gate');
    expect('action' in payload).toBe(false);
    expect(payload.source).toBe('cancelled');
  });

  it('rejects gate.resolved without frame identity', () => {
    expect(() =>
      WorkflowSchemas['gate.resolved'].parse({
        executionId: 'wfx-1',
        stepId: 'approval',
        stepType: 'gate',
        action: 'approve',
        source: 'user',
      }),
    ).toThrow();
  });
});

describe('listGateInstances subject', () => {
  it('parses public gate instance read responses', () => {
    const response = WorkflowSchemas.listGateInstances.response.parse({
      gates: [
        {
          executionId: 'wfx-1',
          nodeId: 'approval',
          frameId: 'frame-gate',
          schema: {},
          prompt: 'Approve?',
          status: 'waiting',
          autoAction: 'reject',
          timeoutMs: null,
          createdAt: 1000,
        },
      ],
    });

    expect(response.gates[0]?.frameId).toBe('frame-gate');
    expect(response.gates[0]?.status).toBe('waiting');
  });

  it('accepts a status-only gate inbox query', () => {
    const query = WorkflowSchemas.listGateInstances.request.parse({ status: 'waiting' });
    expect(query.status).toBe('waiting');
    expect(query.limit).toBe(50);
  });

  it('rejects an empty gate instance query', () => {
    expect(WorkflowSchemas.listGateInstances.request.safeParse({}).success).toBe(false);
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
// execution.paused event
// ─────────────────────────────────────────────────────────────

describe('execution.paused event', () => {
  it('defines execution.paused with gate and frame identity', () => {
    expect(WorkflowSubjects.execution.paused.subject).toBe('execution.paused');
    expect(
      WorkflowSchemas['execution.paused'].parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        pausedAtGateId: 'approve',
        pausedAtFrameId: 'frame-approve-1',
      }),
    ).toMatchObject({ pausedAtFrameId: 'frame-approve-1' });
  });
});

// ─────────────────────────────────────────────────────────────
// State RPC subjects
// ─────────────────────────────────────────────────────────────

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
