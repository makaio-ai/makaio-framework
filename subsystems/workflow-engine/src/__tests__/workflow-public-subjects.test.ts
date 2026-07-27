import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type IWorkflowRunner,
  type WorkflowExecutionScope,
  type WorkflowRunnerCompletion,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition } from './shared.js';

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

  it('passes non-object start inputs through isolated runner configuration', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const capturedConfigs: WorkflowWorkerConfig[] = [];
    const workflowRunner: IWorkflowRunner = {
      async run(config, signal): Promise<WorkflowRunnerCompletion> {
        capturedConfigs.push(config);
        if (config.definition === undefined) {
          throw new Error('Definition-backed runner config must include a workflow definition snapshot.');
        }
        const result = await runWorkflowOrchestrator({
          config,
          loaded: {
            definition: config.definition,
            runtimeHandlers: new Map(),
          },
          bus: MakaioBus,
          signal,
        });
        return { state: 'uncommitted', result };
      },
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const workflow = createWorkflowDefinition({
      id: 'public-start-runner-input-hints',
      name: 'Public Start Runner Input Hints',
      root: { id: 'public-start-runner-input-hints-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

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
      });

      await expect(completedPromise).resolves.toBe(executionId);
    }

    expect(capturedConfigs).toHaveLength(starts.length);
    expect(capturedConfigs.map((config) => config.inputs)).toEqual(starts);
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
      async run(config): Promise<WorkflowRunnerCompletion> {
        capturedConfigs.push(config);
        if (returnedStatus === 'failed') {
          return {
            state: 'uncommitted',
            result: {
              executionId: config.executionId,
              workflowId: config.workflowId,
              status: 'failed',
              error: `${returnedStatus} by remote runner`,
            },
          };
        }
        if (returnedStatus === 'cancelled') {
          return {
            state: 'uncommitted',
            result: {
              executionId: config.executionId,
              workflowId: config.workflowId,
              status: 'cancelled',
              reason: `${returnedStatus} by remote runner`,
            },
          };
        }
        return {
          state: 'uncommitted',
          result: {
            executionId: config.executionId,
            workflowId: config.workflowId,
            status: 'completed',
          },
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
    // Runner configs are launch inputs; terminal metadata belongs on the
    // persisted execution returned by the public read subject.
    if (expectedStatus === 'failed') {
      expect(execution?.error).toBe('failed by remote runner');
    } else if (expectedStatus === 'cancelled') {
      expect(execution?.reason).toBe('cancelled by remote runner');
    }
  });
});

describe('workflow start with parentSessionId', () => {
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

  it('rejects with a clear error before creating any coordinator session when parentSessionId is stale', async () => {
    if (!setup) throw new Error('Workflow executor test setup did not initialize.');

    const workflow = createWorkflowDefinition({
      id: 'start-stale-parent',
      name: 'Start Stale Parent',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    // Track coordinator session creation attempts — should be zero for a stale parent.
    const coordinatorSessionIds: string[] = [];
    const offCreate = MakaioBus.on(SessionSubjects.created, (ctx) => {
      coordinatorSessionIds.push(ctx.payload.sessionId);
    });

    try {
      await expect(
        MakaioBus.request(WorkflowSubjects.start, {
          workflowId: workflow.id,
          parentSessionId: 'session-does-not-exist',
        }),
      ).rejects.toThrow('Parent session not found: session-does-not-exist');
      // No coordinator session must have been created before the error was thrown.
      expect(coordinatorSessionIds).toHaveLength(0);
    } finally {
      offCreate();
    }
  });

  it('accepts a valid parentSessionId and records it on the coordinator session', async () => {
    if (!setup) throw new Error('Workflow executor test setup did not initialize.');

    const workflow = createWorkflowDefinition({
      id: 'start-valid-parent',
      name: 'Start Valid Parent',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    // Create a real parent session through the session service.
    const { sessionId: parentSessionId } = await MakaioBus.request(SessionSubjects.create, {
      title: 'Parent Session',
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      parentSessionId,
    });

    // The run context must record the coordinator session that was created as a
    // child of the supplied parent.
    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(runContext).not.toBeNull();

    // Verify the coordinator session was created with the parent linked.
    const { session } = await MakaioBus.request(SessionSubjects.get, {
      sessionId: runContext!.coordinatorSessionId,
    });
    expect(session?.parentSessionId).toBe(parentSessionId);
  });
});
