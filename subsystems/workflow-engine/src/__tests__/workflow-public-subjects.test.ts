import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  SubagentSubjects,
  WorkerNodeSubjects,
  type ArtifactRevision,
  type IWorkflowRunner,
  type WorkflowExecutionScope,
  type WorkflowDelegateRoleNode,
  type WorkflowGateNode,
  type WorkflowRunResult,
  type WorkflowStationNode,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition } from './shared.js';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('workflow public subjects', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }
  });

  it('returns bounded scope-filtered execution pages through the public listExecutions subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-list-executions',
      name: 'Public List Executions',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const projectScope = {
      type: 'external',
      kind: 'project',
      id: 'project-public-list',
    } satisfies WorkflowExecutionScope;
    const otherScope = { type: 'external', kind: 'project', id: 'project-other' } satisfies WorkflowExecutionScope;

    const projectExecutionIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        scope: projectScope,
        input: { index },
      });
      projectExecutionIds.push(executionId);
    }
    for (let index = 0; index < 2; index++) {
      await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        scope: otherScope,
        input: { index },
      });
    }

    const page1 = await MakaioBus.request(WorkflowSubjects.listExecutions, {
      scope: projectScope,
      limit: 2,
    });

    expect(page1.executions).toHaveLength(2);
    const cursorSource = page1.executions.at(-1);
    if (!cursorSource) {
      throw new Error('Expected first execution page to include a cursor source.');
    }

    const page2 = await MakaioBus.request(WorkflowSubjects.listExecutions, {
      scope: projectScope,
      limit: 2,
      cursor: { startedAt: cursorSource.startedAt, id: cursorSource.id },
    });

    const page1Ids = new Set(page1.executions.map((execution) => execution.id));
    const listedProjectExecutions = [...page1.executions, ...page2.executions];

    expect(page2.executions).toHaveLength(2);
    expect(page2.executions.every((execution) => !page1Ids.has(execution.id))).toBe(true);
    expect(listedProjectExecutions.every((execution) => projectExecutionIds.includes(execution.id))).toBe(true);
    expect(listedProjectExecutions.map((execution) => execution.scope)).toEqual([
      projectScope,
      projectScope,
      projectScope,
      projectScope,
    ]);
    expect(new Set(listedProjectExecutions.map((execution) => execution.id)).size).toBe(4);
  });

  it('persists the requested execution scope when starting through the public start subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-start-scope-override',
      name: 'Public Start Scope Override',
      scope: { type: 'global' },
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const executionScope = { type: 'session', id: 'session-public-start' } satisfies WorkflowExecutionScope;
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: executionScope,
    });

    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(execution?.scope).toEqual(executionScope);
  });

  it('preserves non-object start inputs in execution and run context storage', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-start-non-object-input',
      name: 'Public Start Non Object Input',
      root: { id: 'public-start-non-object-input-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const starts = [
      { suffix: 'array', input: ['item-1', 'item-2'] },
      { suffix: 'string', input: 'plain-string' },
      { suffix: 'null', input: null },
    ] as const;

    for (const start of starts) {
      const completedPromise = new Promise<string>((resolve) => {
        const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
          unsubscribe();
          resolve(ctx.payload.executionId);
        });
      });
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        input: start.input,
      });
      await expect(completedPromise).resolves.toBe(executionId);

      const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
      const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });

      expect(execution?.inputs).toEqual(start.input);
      expect(runContext?.inputs).toEqual(start.input);
    }
  });

  it('passes non-object start inputs and execution hints through isolated runner configuration', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const capturedConfigs: WorkflowWorkerConfig[] = [];
    const workflowRunner: IWorkflowRunner = {
      async run(config, signal) {
        capturedConfigs.push(config);
        if (config.definition === undefined) {
          throw new Error('Definition-backed runner config must include a workflow definition snapshot.');
        }
        return runWorkflowOrchestrator({
          config,
          loaded: {
            definition: config.definition,
            runtimeHandlers: new Map(),
          },
          bus: MakaioBus,
          signal,
        });
      },
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const workflow = createWorkflowDefinition({
      id: 'public-start-runner-input-hints',
      name: 'Public Start Runner Input Hints',
      root: { id: 'public-start-runner-input-hints-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const executionHints = {
      priority: 'high',
      requirements: { isolation: 'container' as const },
      providers: { 'github-actions': { pool: 'expensive-runner' } },
    };
    const starts = [['item-1', 'item-2'], null] as const;

    for (const input of starts) {
      const completedPromise = new Promise<string>((resolve) => {
        const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
          unsubscribe();
          resolve(ctx.payload.executionId);
        });
      });
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        input,
        executionHints,
      });

      await expect(completedPromise).resolves.toBe(executionId);
      const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
      expect(runContext?.executionHints).toEqual(executionHints);
    }

    expect(capturedConfigs).toHaveLength(starts.length);
    expect(capturedConfigs.map((config) => config.inputs)).toEqual(starts);
    expect(capturedConfigs.map((config) => config.executionHints)).toEqual(starts.map(() => executionHints));
  });

  it('persists and forwards definition execution hints merged with public start overrides', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const workflowRunnerCalls: WorkflowWorkerConfig[] = [];
    const workflowRunner: IWorkflowRunner = {
      async run(config): Promise<WorkflowRunResult> {
        workflowRunnerCalls.push(config);
        return {
          executionId: config.executionId,
          workflowId: config.workflowId,
          status: 'completed',
        };
      },
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner });
    const capturedDispatchConfigs: Array<{ source: unknown; executionHints: unknown; requirements: unknown }> = [];
    const cleanupWorkerNodeDispatch = MakaioBus.on(WorkerNodeSubjects.dispatch, (ctx) => {
      capturedDispatchConfigs.push({
        source: ctx.payload.config.source,
        executionHints: ctx.payload.config.executionHints,
        requirements: ctx.payload.requirements,
      });
      ctx.setResult({
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      });
    });
    setup.cleanupFns.push(cleanupWorkerNodeDispatch);

    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-start-merged-definition-hints',
        name: 'Public Start Merged Definition Hints',
        root: { id: 'public-start-merged-definition-hints-root', type: 'sequence', nodes: [] },
      }),
      executionHints: {
        source: { kind: 'path' as const, path: '.makaio/workflows/intake.ts' },
        requirements: { isolation: 'local' as const, capabilities: ['workflow.local-runtime'] },
        providers: { piscina: { maxWorkers: 2 } },
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      executionHints: {
        requirements: { capabilities: ['gpu'] },
        providers: { 'github-actions': { pool: 'remote' } },
      },
    });
    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });

    const expectedSource = { kind: 'path' as const, path: resolve(process.cwd(), '.makaio/workflows/intake.ts') };
    expect(runContext?.source).toEqual(expectedSource);
    expect(runContext?.executionHints).toMatchObject({
      requirements: {
        isolation: 'local',
        capabilities: ['workflow.local-runtime', 'gpu'],
      },
      providers: {
        piscina: { maxWorkers: 2 },
        'github-actions': { pool: 'remote' },
      },
    });
    expect(workflowRunnerCalls).toHaveLength(0);
    expect(capturedDispatchConfigs[0]?.source).toEqual(expectedSource);
    expect(capturedDispatchConfigs[0]?.executionHints).toEqual(runContext?.executionHints);
    expect(capturedDispatchConfigs[0]?.requirements).toEqual({
      customCapabilities: ['workflow.local-runtime', 'gpu'],
    });
  });

  it.each([
    { returnedStatus: 'completed' as const, expectedStatus: 'completed' },
    { returnedStatus: 'failed' as const, expectedStatus: 'failed' },
    { returnedStatus: 'cancelled' as const, expectedStatus: 'cancelled' },
  ])('persists $returnedStatus results returned by definition-backed workflow runners', async ({
    returnedStatus,
    expectedStatus,
  }) => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const capturedConfigs: WorkflowWorkerConfig[] = [];
    const workflowRunner: IWorkflowRunner = {
      async run(config): Promise<WorkflowRunResult> {
        capturedConfigs.push(config);
        return {
          executionId: config.executionId,
          workflowId: config.workflowId,
          status: returnedStatus,
          ...(returnedStatus !== 'completed' ? { output: { reason: `${returnedStatus} by remote runner` } } : {}),
        };
      },
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const workflow = createWorkflowDefinition({
      id: 'public-start-runner-returned-result',
      name: 'Public Start Runner Returned Result',
      root: { id: 'public-start-runner-returned-result-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const terminalPromise = new Promise<string>((resolve) => {
      const unsubscribers = [
        MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
          unsubscribers.forEach((unsubscribe) => unsubscribe());
          resolve(ctx.payload.executionId);
        }),
        MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
          unsubscribers.forEach((unsubscribe) => unsubscribe());
          resolve(ctx.payload.executionId);
        }),
        MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
          unsubscribers.forEach((unsubscribe) => unsubscribe());
          resolve(ctx.payload.executionId);
        }),
      ];
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(terminalPromise).resolves.toBe(executionId);
    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(capturedConfigs).toHaveLength(1);
    expect(execution?.status).toBe(expectedStatus);
    expect(execution?.completedAt).toEqual(expect.any(Number));
  });

  it('persists the requested artifact reference when starting through the public start subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-start-artifact-ref',
      name: 'Public Start Artifact Ref',
      root: { id: 'public-start-artifact-ref-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const artifactRef = { kind: 'implementation-plan', id: 'artifact-start-1' };
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef,
    });

    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });

    expect(runContext?.artifactRef).toEqual(artifactRef);
  });

  it('passes start artifact references through isolated runner configuration', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const queriedRefs: Array<{ kind: string; ids: string[] }> = [];
    const capturedConfigs: WorkflowWorkerConfig[] = [];
    const workflowRunner: IWorkflowRunner = {
      async run(config, signal) {
        capturedConfigs.push(config);
        if (config.definition === undefined) {
          throw new Error('Definition-backed runner config must include a workflow definition snapshot.');
        }
        return runWorkflowOrchestrator({
          config,
          loaded: {
            definition: config.definition,
            runtimeHandlers: new Map([['noop', async () => null]]),
          },
          bus: MakaioBus,
          signal,
        });
      },
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner });
    MakaioBus.registerNamespace(ArtifactNamespace);

    const startArtifactRef = { kind: 'workflow-report', id: 'artifact-from-start' };
    const existingArtifact = {
      kind: startArtifactRef.kind,
      id: startArtifactRef.id,
      revision: 'rev-existing',
      schemaVersion: '1',
      scope: { level: 'global' },
      data: { status: 'existing' },
      relations: [],
      actor: { kind: 'workflow-execution', id: 'exec-existing', displayName: 'Workflow Engine' },
      timestamp: Date.now(),
      createdAt: Date.now(),
    } satisfies ArtifactRevision;
    setup.cleanupFns.push(
      MakaioBus.on(ArtifactSubjects.query, (ctx) => {
        if (ctx.payload.kind === undefined) {
          throw new Error('Artifact query must include the explicit artifact kind.');
        }
        queriedRefs.push({ kind: ctx.payload.kind, ids: [...(ctx.payload.ids ?? [])] });
        ctx.setResult({ artifacts: [existingArtifact] });
      }),
    );

    const noopNode: WorkflowStationNode = { id: 'noop', type: 'station', prompt: 'Noop' };
    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-start-artifact-ref-runner',
        name: 'Public Start Artifact Ref Runner',
        root: {
          id: 'public-start-artifact-ref-runner-root',
          type: 'sequence',
          nodes: [noopNode],
        },
      }),
      artifact: {
        kind: 'workflow-report',
        schemaVersion: '1',
        scope: { level: 'global' },
        resolve: '{ kind: "workflow-report", id: "definition-ref" }',
        create: '{ status: "created" }',
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef: startArtifactRef,
    });

    await expect(completedPromise).resolves.toBe(executionId);
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]?.artifactRef).toEqual(startArtifactRef);
    expect(queriedRefs).toEqual([{ kind: 'workflow-report', ids: ['artifact-from-start'] }]);
  });

  it('runs stored role-backed stations through the subagent seam', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        expect(ctx.payload.roleId).toBe('reviewer');
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
          contextMode: 'fresh',
        });
      }),
    );

    const roleStation: WorkflowStationNode = {
      id: 'review',
      type: 'station',
      prompt: 'Review {{ input.title }} for {{ config.repository }}',
      role: 'reviewer',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-start-role-station',
      name: 'Public Start Role Station',
      root: {
        id: 'public-start-role-station-root',
        type: 'sequence',
        nodes: [roleStation],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { title: 'the plan' },
      config: { repository: 'workflow-api' },
    });

    await expect(completedPromise).resolves.toBe(executionId);
    const { frames } = await MakaioBus.request(WorkflowStorageSubjects.listFrames, { executionId });

    expect(frames).toEqual([
      expect.objectContaining({
        nodeId: 'review',
        nodeType: 'station',
        status: 'completed',
        output: 'completed:Review the plan for workflow-api',
      }),
    ]);
  });

  it('emits frame.sessionLinked when a role-backed station spawns a child session', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
          contextMode: 'fresh',
        });
      }),
    );

    setup.cleanupFns.push(
      MakaioBus.on(SubagentSubjects.getStatus, (ctx) => {
        ctx.setResult({
          status: 'running',
          childSessionId: `session-${ctx.payload.subagentId}`,
          progress: [],
        });
      }),
    );

    const analyzeStation: WorkflowStationNode = {
      id: 'analyze',
      type: 'station',
      prompt: 'Analyze the plan',
      role: 'reviewer',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-session-linked',
      name: 'Public Session Linked',
      root: {
        id: 'public-session-linked-root',
        type: 'sequence',
        nodes: [analyzeStation],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const sessionLinks: Array<{ frameId: string; sessionId: string }> = [];
    const cleanupLinks = MakaioBus.on(WorkflowSubjects.frame.sessionLinked, (ctx) => {
      sessionLinks.push({ frameId: ctx.payload.frameId, sessionId: ctx.payload.sessionId });
    });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
      });

      await expect(completedPromise).resolves.toBe(executionId);

      expect(sessionLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            frameId: expect.any(String),
            sessionId: expect.stringMatching(/^session-/),
          }),
        ]),
      );
    } finally {
      cleanupLinks();
    }
  });

  it('runs stored delegate-role nodes through the public start subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        expect(ctx.payload.roleId).toBe('reviewer');
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
          contextMode: 'fresh',
        });
      }),
    );

    const delegateRole: WorkflowDelegateRoleNode = {
      id: 'review-delegate',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-start-delegate-role',
      name: 'Public Start Delegate Role',
      root: {
        id: 'public-start-delegate-role-root',
        type: 'sequence',
        nodes: [delegateRole],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { title: 'delegate execution' },
    });

    await expect(completedPromise).resolves.toBe(executionId);
    const { frames } = await MakaioBus.request(WorkflowStorageSubjects.listFrames, { executionId });

    expect(frames).toEqual([
      expect.objectContaining({
        nodeId: 'review-delegate',
        nodeType: 'delegate-role',
        status: 'completed',
        output: 'completed:Review delegate execution',
      }),
    ]);
  });

  it('emits frame.sessionLinked when a delegate-role node spawns a child session', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
          contextMode: 'fresh',
        });
      }),
    );

    setup.cleanupFns.push(
      MakaioBus.on(SubagentSubjects.getStatus, (ctx) => {
        ctx.setResult({
          status: 'running',
          childSessionId: `session-${ctx.payload.subagentId}`,
          progress: [],
        });
      }),
    );

    const delegateRole: WorkflowDelegateRoleNode = {
      id: 'linked-review-delegate',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review linked session',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-delegate-session-linked',
      name: 'Public Delegate Session Linked',
      root: {
        id: 'public-delegate-session-linked-root',
        type: 'sequence',
        nodes: [delegateRole],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const sessionLinks: Array<{ frameId: string; sessionId: string }> = [];
    const cleanupLinks = MakaioBus.on(WorkflowSubjects.frame.sessionLinked, (ctx) => {
      sessionLinks.push({ frameId: ctx.payload.frameId, sessionId: ctx.payload.sessionId });
    });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
      });

      await expect(completedPromise).resolves.toBe(executionId);

      expect(sessionLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            frameId: expect.any(String),
            sessionId: expect.stringMatching(/^session-/),
          }),
        ]),
      );
    } finally {
      cleanupLinks();
    }
  });

  it('finalizes in-process executions as completed when the primitive runtime succeeds', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-runtime-completed',
      name: 'Public Runtime Completed',
      root: { id: 'public-runtime-completed-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(completedPromise).resolves.toBe(executionId);
    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(execution?.status).toBe('completed');
    expect(execution?.completedAt).toEqual(expect.any(Number));
  });

  it('finalizes in-process executions as failed when the primitive runtime fails', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-runtime-failed',
      name: 'Public Runtime Failed',
      root: {
        id: 'public-runtime-failed-root',
        type: 'sequence',
        nodes: [
          {
            id: 'missing-handler',
            type: 'station',
            prompt: 'No handler is registered in-process',
          } as WorkflowStationNode,
        ],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const failedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(failedPromise).resolves.toBe(executionId);
    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(execution?.status).toBe('failed');
    expect(execution?.error).toContain('missing-handler');
    expect(execution?.completedAt).toEqual(expect.any(Number));
  });

  it('persists cancellation for in-process executions that have an abort controller', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-runtime-cancelled',
      name: 'Public Runtime Cancelled',
      root: {
        id: 'public-runtime-cancelled-root',
        type: 'sequence',
        nodes: [
          {
            id: 'approval',
            type: 'gate',
            prompt: 'Wait for cancellation',
            autoAction: 'reject',
            timeoutMs: null,
          } as WorkflowGateNode,
        ],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const suspendedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.gate.suspended, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const cancelledPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await expect(suspendedPromise).resolves.toBe(executionId);

    const cancelResult = await MakaioBus.request(WorkflowSubjects.cancel, {
      executionId,
      reason: 'test cancellation',
    });

    expect(cancelResult.cancelled).toBe(true);
    await expect(cancelledPromise).resolves.toBe(executionId);
    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(execution?.status).toBe('cancelled');
    expect(execution?.completedAt).toEqual(expect.any(Number));
  });

  it('returns execution spans through the public listSpans subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    // Seed an execution via storage so there is a foreign-key anchor for the
    // span rows. The listSpans subject reads from workflow_step_spans keyed by
    // executionId — we can populate it directly without running the full runtime.
    const workflow = createWorkflowDefinition({
      id: 'public-span-read',
      name: 'Public Span Read',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: { type: 'global' },
    });

    // Write a span record directly through the storage subject to verify the
    // public listSpans handler reads and surfaces it correctly.
    await MakaioBus.request(WorkflowStorageSubjects.setSpan, {
      span: {
        executionId,
        frameId: 'frame-echo',
        stepId: 'echo',
        stepType: 'station',
        status: 'completed',
      },
    });

    const result = await MakaioBus.request(WorkflowSubjects.listSpans, { executionId });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId,
          stepId: 'echo',
          status: 'completed',
        }),
      ]),
    );
  });

  it('returns gate instances through the public listGateInstances subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-gate-instance-read',
      name: 'Public Gate Instance Read',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: { type: 'global' },
    });

    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        executionId,
        nodeId: 'approval',
        frameId: 'frame-approval',
        schema: {},
        prompt: 'Approve this execution?',
        status: 'waiting',
        createdAt: Date.now(),
      },
    });

    const result = await MakaioBus.request(WorkflowSubjects.listGateInstances, { executionId });

    expect(result.gates).toEqual([
      expect.objectContaining({
        executionId,
        nodeId: 'approval',
        frameId: 'frame-approval',
        status: 'waiting',
      }),
    ]);
  });

  it('returns primitive runtime frame spans through the public listSpans subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-runtime-frame-spans',
      name: 'Public Runtime Frame Spans',
      root: {
        id: 'public-runtime-frame-spans-root',
        type: 'sequence',
        nodes: [
          {
            id: 'missing-runtime-handler',
            type: 'station',
            prompt: 'This node fails after frame start in the primitive runtime',
          } as WorkflowStationNode,
        ],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const failedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await expect(failedPromise).resolves.toBe(executionId);

    const { spans } = await MakaioBus.request(WorkflowSubjects.listSpans, { executionId });

    expect(spans).toEqual([
      expect.objectContaining({
        executionId,
        stepId: 'missing-runtime-handler',
        stepType: 'station',
        status: 'failed',
        startedAt: expect.any(Number),
        completedAt: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    ]);
  });
});
