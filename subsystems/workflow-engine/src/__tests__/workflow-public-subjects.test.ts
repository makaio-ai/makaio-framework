import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  SubagentSubjects,
  WorkerNodeSubjects,
  WorkflowErrorCode,
  type ArtifactRevision,
  type IWorkflowRunner,
  type StationHandler,
  type WorkflowExecutionScope,
  type WorkflowDelegateRoleNode,
  type WorkflowGateNode,
  type WorkflowRunResult,
  type WorkflowStationNode,
  type WorkflowWorkerConfig,
  serializeArtifactRef,
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

function expectRequestErrorCause(error: unknown, code: WorkflowErrorCode, message: string): void {
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).cause).toMatchObject({ code, message });
}

function waitForRunnerAbort(config: WorkflowWorkerConfig, signal: AbortSignal): Promise<WorkflowRunResult> {
  const cancelledResult: WorkflowRunResult = {
    executionId: config.executionId,
    workflowId: config.workflowId,
    status: 'cancelled',
    reason: 'test teardown',
  };
  if (signal.aborted) {
    return Promise.resolve(cancelledResult);
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(cancelledResult), { once: true });
  });
}

async function expectExecutionStatus(executionId: string, status: 'failed' | 'completed'): Promise<void> {
  await vi.waitFor(async () => {
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe(status);
  });
}

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

  it('initializes declared workflow state and emits public state updates', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-state-lifecycle',
        name: 'Public State Lifecycle',
        root: { id: 'public-state-lifecycle-root', type: 'sequence', nodes: [] },
      }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await expect(MakaioBus.request(WorkflowSubjects.state.get, { executionId })).resolves.toEqual({
      executionId,
      sequence: 0,
      value: { count: 0 },
    });

    const updates: Array<{ executionId: string; sequence: number; value: unknown }> = [];
    const offUpdated = MakaioBus.on(WorkflowSubjects.state.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      await expect(
        MakaioBus.request(WorkflowSubjects.state.patch, {
          executionId,
          expectedSequence: 0,
          patch: [],
          nextValue: { count: 1 },
        }),
      ).resolves.toEqual({ executionId, sequence: 1, value: { count: 1 } });
      await vi.waitFor(() => expect(updates).toHaveLength(1));
      expect(updates[0]).toEqual(
        expect.objectContaining({
          executionId,
          sequence: 1,
          patch: [{ op: 'replace', path: '/count', value: 1 }],
          value: { count: 1 },
        }),
      );
    } finally {
      offUpdated();
    }
  });

  it('rejects declared workflow state values that do not match the state schema', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const invalidInitialWorkflow = {
      ...createWorkflowDefinition({
        id: 'public-state-invalid-initial',
        name: 'Public State Invalid Initial',
        root: { id: 'public-state-invalid-initial-root', type: 'sequence', nodes: [] },
      }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 'invalid' },
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow: invalidInitialWorkflow });
    await expect(MakaioBus.request(WorkflowSubjects.start, { workflowId: invalidInitialWorkflow.id })).rejects.toThrow(
      'initial state does not match workflow state schema',
    );

    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-state-invalid-update',
        name: 'Public State Invalid Update',
        root: { id: 'public-state-invalid-update-root', type: 'sequence', nodes: [] },
      }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(
      MakaioBus.request(WorkflowSubjects.state.patch, {
        executionId,
        expectedSequence: 0,
        patch: [{ op: 'replace', path: '/count', value: 'invalid' }],
        nextValue: { count: 'invalid' },
      }),
    ).rejects.toThrow('next state does not match workflow state schema');
  });

  it('preserves an explicit null initial workflow state value', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-state-null-initial',
        name: 'Public State Null Initial',
        root: { id: 'public-state-null-initial-root', type: 'sequence', nodes: [] },
      }),
      state: {
        schema: { type: 'null' },
        initial: null,
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    const { state } = await MakaioBus.request(WorkflowStorageSubjects.getState, { executionId });

    expect(state).toEqual({ executionId, sequence: 0, value: null });
    await expect(
      MakaioBus.request(WorkflowSubjects.state.patch, {
        executionId,
        expectedSequence: 0,
        patch: [],
        nextValue: null,
      }),
    ).resolves.toEqual({ executionId, sequence: 1, value: null });
  });

  it('reuses state schema validators for persisted snapshots with JSON Schema ids', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-state-schema-id',
        name: 'Public State Schema Id',
        root: { id: 'public-state-schema-id-root', type: 'sequence', nodes: [] },
      }),
      state: {
        schema: {
          $id: 'https://schemas.makaio.dev/tests/public-state-schema-id.json',
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(
      MakaioBus.request(WorkflowSubjects.state.patch, {
        executionId,
        expectedSequence: 0,
        patch: [{ op: 'replace', path: '/count', value: 1 }],
        nextValue: { count: 1 },
      }),
    ).resolves.toEqual({ executionId, sequence: 1, value: { count: 1 } });
  });

  it('reuses state schema validators for equivalent JSON Schema ids with reordered keys', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const schemaId = 'https://schemas.makaio.dev/tests/public-state-schema-id-reordered.json';
    const firstWorkflow = {
      ...createWorkflowDefinition({
        id: 'public-state-schema-id-order-a',
        name: 'Public State Schema Id Order A',
        root: { id: 'public-state-schema-id-order-a-root', type: 'sequence', nodes: [] },
      }),
      state: {
        schema: {
          $id: schemaId,
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    };
    const secondWorkflow = {
      ...createWorkflowDefinition({
        id: 'public-state-schema-id-order-b',
        name: 'Public State Schema Id Order B',
        root: { id: 'public-state-schema-id-order-b-root', type: 'sequence', nodes: [] },
      }),
      state: {
        schema: {
          additionalProperties: false,
          required: ['count'],
          properties: { count: { type: 'number' } },
          type: 'object',
          $id: schemaId,
        },
        initial: { count: 0 },
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow: firstWorkflow });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow: secondWorkflow });

    await MakaioBus.request(WorkflowSubjects.start, { workflowId: firstWorkflow.id });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: secondWorkflow.id });

    await expect(
      MakaioBus.request(WorkflowSubjects.state.patch, {
        executionId,
        expectedSequence: 0,
        patch: [{ op: 'replace', path: '/count', value: 1 }],
        nextValue: { count: 1 },
      }),
    ).resolves.toEqual({ executionId, sequence: 1, value: { count: 1 } });
  });

  it('initializes state from the loaded file workflow definition before running stations', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const readStateNode: WorkflowStationNode = { id: 'read-state', type: 'station', prompt: 'Read state' };
    const workflow = {
      ...createWorkflowDefinition({
        id: 'file-state-lifecycle',
        name: 'File State Lifecycle',
        root: {
          id: 'file-state-lifecycle-root',
          type: 'sequence',
          nodes: [readStateNode],
        },
      }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    };
    let observedState: unknown;
    const readState: StationHandler = async (ctx) => {
      observedState = await ctx.state?.get();
      return { ok: true };
    };
    const workflowRunner: IWorkflowRunner = {
      run(config, signal) {
        return runWorkflowOrchestrator({
          config,
          loaded: {
            definition: workflow,
            runtimeHandlers: new Map([['read-state', readState]]),
          },
          bus: MakaioBus,
          signal,
        });
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.runFile, {
      filePath: '/workspace/workflows/file-state.ts',
    });
    await expect(completedPromise).resolves.toBe(executionId);

    const { state } = await MakaioBus.request(WorkflowStorageSubjects.getState, { executionId });
    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });

    expect(observedState).toEqual({ count: 0 });
    expect(state).toEqual({ executionId, sequence: 0, value: { count: 0 } });
    expect(runContext?.definitionSnapshot?.state).toEqual(workflow.state);
  });

  it('does not pre-seed path-sourced definition runs from stored workflow state', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const readStateNode: WorkflowStationNode = { id: 'read-path-state', type: 'station', prompt: 'Read state' };
    const storedWorkflow = {
      ...createWorkflowDefinition({
        id: 'path-sourced-definition-state',
        name: 'Path Sourced Definition State',
        root: { id: 'path-sourced-definition-state-root', type: 'sequence', nodes: [] },
      }),
      executionHints: {
        source: { kind: 'path' as const, path: '.makaio/workflows/path-state.ts' },
      },
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: -1 },
      },
    };
    const loadedWorkflow = {
      ...storedWorkflow,
      root: {
        id: 'path-sourced-definition-state-loaded-root',
        type: 'sequence' as const,
        nodes: [readStateNode],
      },
      state: {
        ...storedWorkflow.state,
        initial: { count: 7 },
      },
    };
    let observedState: unknown;
    const readState: StationHandler = async (ctx) => {
      observedState = await ctx.state?.get();
      return { ok: true };
    };
    const workflowRunner: IWorkflowRunner = {
      run(config, signal) {
        return runWorkflowOrchestrator({
          config,
          loaded: {
            definition: loadedWorkflow,
            runtimeHandlers: new Map([['read-path-state', readState]]),
          },
          bus: MakaioBus,
          signal,
        });
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow: storedWorkflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: storedWorkflow.id });
    await expect(completedPromise).resolves.toBe(executionId);

    const { state } = await MakaioBus.request(WorkflowStorageSubjects.getState, { executionId });
    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });

    expect(observedState).toEqual({ count: 7 });
    expect(state).toEqual({ executionId, sequence: 0, value: { count: 7 } });
    expect(runContext?.source).toEqual({
      kind: 'path',
      path: resolve(process.cwd(), '.makaio/workflows/path-state.ts'),
    });
    expect(runContext?.definitionSnapshot?.state).toEqual(loadedWorkflow.state);
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
        if (returnedStatus === 'failed') {
          return {
            executionId: config.executionId,
            workflowId: config.workflowId,
            status: 'failed',
            error: `${returnedStatus} by remote runner`,
          };
        }
        if (returnedStatus === 'cancelled') {
          return {
            executionId: config.executionId,
            workflowId: config.workflowId,
            status: 'cancelled',
            reason: `${returnedStatus} by remote runner`,
          };
        }
        return {
          executionId: config.executionId,
          workflowId: config.workflowId,
          status: 'completed',
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

    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
    expect(execution?.artifactRef).toEqual(artifactRef);
  });

  it('emits artifactRef on execution.started and filters listExecutions by artifactRef', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-artifact-ref-filter',
      name: 'Artifact Ref Filter',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const artifactRef = { kind: 'workpiece', id: 'wp-filter-1' };
    const startedRefs: Array<unknown> = [];
    const unsub = MakaioBus.on(WorkflowSubjects.execution.started, (ctx) => {
      startedRefs.push(ctx.payload.artifactRef);
    });
    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        artifactRef,
      });
      await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id }); // no ref — must not match

      const { executions } = await MakaioBus.request(WorkflowSubjects.listExecutions, { artifactRef });

      expect(executions.map((execution) => execution.id)).toEqual([executionId]);
      expect(startedRefs).toContainEqual(artifactRef);
    } finally {
      unsub();
    }
  });

  it('batch-fetches executions by artifact refs via public subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-batch-artifact-ref',
      name: 'Batch Artifact Ref',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const refA = { kind: 'workpiece', id: 'wp-batch-a' };
    const refB = { kind: 'workpiece', id: 'wp-batch-b' };
    const refMiss = { kind: 'workpiece', id: 'wp-batch-miss' };

    const { executionId: idA } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef: refA,
    });
    const { executionId: idB } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      artifactRef: refB,
    });

    const { executionsByRef } = await MakaioBus.request(WorkflowSubjects.listExecutionsByArtifactRefs, {
      refs: [refA, refB, refMiss],
      limitPerRef: 10,
    });

    expect(executionsByRef[serializeArtifactRef(refA)]?.map((e) => e.id)).toEqual([idA]);
    expect(executionsByRef[serializeArtifactRef(refB)]?.map((e) => e.id)).toEqual([idB]);
    expect(executionsByRef[serializeArtifactRef(refMiss)]).toBeUndefined();
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

  it('emits frame.sessionLinked when a delegate-role node creates a child session', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
        });
      }),
    );

    const delegateRole: WorkflowDelegateRoleNode = {
      id: 'linked-review-delegate',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review linked session',
      completion: 'turn',
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
    const { workflow: storedWorkflow } = await MakaioBus.request(WorkflowSubjects.getDefinition, { id: workflow.id });
    expect(storedWorkflow?.root.nodes[0]).toMatchObject({ completion: 'turn' });

    const sessionLinks: Array<{ frameId: string; sessionId: string }> = [];
    const cleanupLinks = MakaioBus.on(WorkflowSubjects.frame.sessionLinked, (ctx) => {
      sessionLinks.push({ frameId: ctx.payload.frameId, sessionId: ctx.payload.sessionId });
    });

    const terminalPromise = new Promise<{ executionId: string; status: 'completed' | 'failed'; error?: string }>(
      (resolve) => {
        const unsubscribers = [
          MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            resolve({ executionId: ctx.payload.executionId, status: 'completed' });
          }),
          MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            resolve({ executionId: ctx.payload.executionId, status: 'failed', error: ctx.payload.error });
          }),
          MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            resolve({ executionId: ctx.payload.executionId, status: 'failed', error: 'cancelled' });
          }),
        ];
      },
    );

    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
      });

      const terminal = await terminalPromise;
      expect(terminal.executionId).toBe(executionId);
      if (terminal.error !== undefined) {
        throw new Error(terminal.error);
      }
      expect(terminal.status).toBe('completed');

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
        autoAction: 'reject',
        timeoutMs: null,
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

  it('round-trips execution links through the public link subjects', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-execution-links',
      name: 'Public Execution Links',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId: sourceExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
    });
    const { executionId: targetExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
    });

    const link = {
      sourceExecutionId,
      targetExecutionId,
      linkType: 'triggered-by' as const,
      metadata: { reason: 'test' },
    };
    const { id } = await MakaioBus.request(WorkflowSubjects.setExecutionLink, { link });
    expect(id).toBe(`${sourceExecutionId}:${targetExecutionId}`);

    const { links } = await MakaioBus.request(WorkflowSubjects.listExecutionLinks, { sourceExecutionId });
    expect(links).toEqual([link]);
  });

  it('reruns an execution from its stored definition snapshot', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const originalWorkflow = createWorkflowDefinition({
      id: 'public-rerun-snapshot',
      name: 'Public Rerun Snapshot v1',
      root: {
        id: 'public-rerun-snapshot-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow: originalWorkflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: originalWorkflow.id,
      input: { value: 'original' },
      config: { strict: true },
    });

    await MakaioBus.request(WorkflowSubjects.setDefinition, {
      workflow: {
        ...originalWorkflow,
        name: 'Public Rerun Snapshot v2',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
      reason: 'verify original topology',
    });

    expect(rerunExecutionId).not.toBe(originalExecutionId);

    const { runContext: rerunRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });
    expect(rerunRunContext?.workflowId).toBe(originalWorkflow.id);
    expect(rerunRunContext?.definitionSnapshot?.name).toBe('Public Rerun Snapshot v1');
    expect(rerunRunContext?.inputs).toEqual({ value: 'original' });
    expect(rerunRunContext?.config).toEqual({ strict: true });

    const { links } = await MakaioBus.request(WorkflowSubjects.listExecutionLinks, {
      sourceExecutionId: originalExecutionId,
    });
    expect(links).toEqual([
      {
        sourceExecutionId: originalExecutionId,
        targetExecutionId: rerunExecutionId,
        linkType: 'rerun-of',
        metadata: {
          mode: 'snapshot',
          reason: 'verify original topology',
        },
      },
    ]);
  });

  it('inherits and overrides rerun run context fields from the original persisted context', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-context-fields',
      name: 'Public Rerun Context Fields',
      root: {
        id: 'public-rerun-context-fields-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const originalScope = {
      type: 'external',
      kind: 'project',
      id: 'rerun-context-original',
    } satisfies WorkflowExecutionScope;
    const originalArtifactRef = { kind: 'workpiece', id: 'rerun-context-original' };
    const originalExecutionHints = {
      providers: { piscina: { maxWorkers: 1 } },
    };
    const originalTriggerPayload = { source: 'original-trigger', count: 1 };

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: originalScope,
      artifactRef: originalArtifactRef,
      executionHints: originalExecutionHints,
      triggerPayload: originalTriggerPayload,
    });

    const { executionId: inheritedRerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });
    const { runContext: inheritedRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: inheritedRerunExecutionId,
    });
    expect(inheritedRunContext?.scope).toEqual(originalScope);
    expect(inheritedRunContext?.artifactRef).toEqual(originalArtifactRef);
    expect(inheritedRunContext?.executionHints).toEqual(originalExecutionHints);
    expect(inheritedRunContext?.triggerPayload).toEqual(originalTriggerPayload);

    const overrideScope = { type: 'session', id: 'rerun-context-override' } satisfies WorkflowExecutionScope;
    const overrideArtifactRef = { kind: 'implementation-plan', id: 'rerun-context-override' };
    const overrideExecutionHints = {
      providers: { 'github-actions': { pool: 'large' } },
    };
    const overrideTriggerPayload = { source: 'override-trigger', count: 2 };

    const { executionId: overrideRerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
      scope: overrideScope,
      artifactRef: overrideArtifactRef,
      executionHints: overrideExecutionHints,
      triggerPayload: overrideTriggerPayload,
    });
    const { runContext: overrideRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: overrideRerunExecutionId,
    });
    expect(overrideRunContext?.scope).toEqual(overrideScope);
    expect(overrideRunContext?.artifactRef).toEqual(overrideArtifactRef);
    expect(overrideRunContext?.executionHints).toEqual(overrideExecutionHints);
    expect(overrideRunContext?.triggerPayload).toEqual(overrideTriggerPayload);
  });

  it('reruns from persisted run context without requiring a completed source execution', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-any-persisted-context',
      name: 'Public Rerun Any Persisted Context',
      root: {
        id: 'public-rerun-any-persisted-context-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { source: 'non-completed-status' },
    });
    await expectExecutionStatus(originalExecutionId, 'completed');
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: originalExecutionId,
    });
    if (execution === null) {
      throw new Error('Expected original execution to be persisted before rerun.');
    }
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: {
        ...execution,
        status: 'failed',
        error: 'forced non-completed status for rerun contract',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });
    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });

    expect(runContext?.inputs).toEqual({ source: 'non-completed-status' });
  });

  it('uses the loaded snapshot definition id when rerunning file-backed executions', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const loadedWorkflow = createWorkflowDefinition({
      id: 'public-rerun-file-snapshot-logical-id',
      name: 'Public Rerun File Snapshot Logical Id',
      root: {
        id: 'public-rerun-file-snapshot-logical-id-root',
        type: 'sequence',
        nodes: [],
      },
    });
    const capturedConfigs: WorkflowWorkerConfig[] = [];
    let runCount = 0;
    const workflowRunner: IWorkflowRunner = {
      run(config, signal) {
        capturedConfigs.push(config);
        runCount += 1;
        if (runCount > 1) {
          return waitForRunnerAbort(config, signal);
        }
        return runWorkflowOrchestrator({
          config,
          loaded: {
            definition: loadedWorkflow,
            runtimeHandlers: new Map(),
          },
          bus: MakaioBus,
          signal,
        });
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const filePath = '/workspace/workflows/public-rerun-file-snapshot.ts';
    const originalCompletedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.runFile, { filePath });
    await expect(originalCompletedPromise).resolves.toBe(originalExecutionId);

    const { runContext: originalRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: originalExecutionId,
    });
    expect(originalRunContext?.workflowId).toBe(originalExecutionId);
    expect(originalRunContext?.source).toEqual({ kind: 'path', path: filePath });
    expect(originalRunContext?.definitionSnapshot?.id).toBe(loadedWorkflow.id);

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });

    const rerunConfig = capturedConfigs.at(1);
    expect(rerunConfig?.executionId).toBe(rerunExecutionId);
    expect(rerunConfig?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunConfig?.source).toEqual({ kind: 'path', path: filePath });

    const { runContext: rerunRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });
    expect(rerunRunContext?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunRunContext?.source).toEqual({ kind: 'path', path: filePath });
    expect(rerunRunContext?.definitionSnapshot?.id).toBe(loadedWorkflow.id);
  });

  it('reruns an execution from the current workflow definition', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-current',
      name: 'Public Rerun Current v1',
      root: {
        id: 'public-rerun-current-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { value: 'original' },
    });

    await MakaioBus.request(WorkflowSubjects.setDefinition, {
      workflow: {
        ...workflow,
        name: 'Public Rerun Current v2',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'current',
      input: { value: 'override' },
    });

    const { runContext: rerunRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });
    expect(rerunRunContext?.definitionSnapshot?.name).toBe('Public Rerun Current v2');
    expect(rerunRunContext?.inputs).toEqual({ value: 'override' });
  });

  it('fails snapshot rerun when the original execution has no definition snapshot', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-missing-snapshot',
      name: 'Missing Snapshot',
      root: {
        id: 'public-rerun-missing-snapshot-root',
        type: 'sequence',
        nodes: [],
      },
    });
    // Add executionHints with a path source so the executor does NOT store a definition snapshot
    await MakaioBus.request(WorkflowSubjects.setDefinition, {
      workflow: {
        ...workflow,
        executionHints: {
          source: { kind: 'path', path: '/repo/not-loaded-by-in-process-runner.mjs' },
        },
      },
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
    });

    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(runContext?.source).toEqual({
      kind: 'path',
      path: '/repo/not-loaded-by-in-process-runner.mjs',
    });
    expect(runContext?.definitionSnapshot).toBeUndefined();

    const error = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId,
      mode: 'snapshot',
    }).catch((value: unknown) => value);

    expectRequestErrorCause(
      error,
      WorkflowErrorCode.SNAPSHOT_UNAVAILABLE,
      `Workflow execution '${executionId}' does not have a definition snapshot.`,
    );
  });

  it('fails rerun with a typed code when the original run context is missing', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const error = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: 'wfx-missing-run-context',
      mode: 'snapshot',
    }).catch((value: unknown) => value);

    expectRequestErrorCause(
      error,
      WorkflowErrorCode.RUN_CONTEXT_NOT_FOUND,
      "Run context not found for workflow execution 'wfx-missing-run-context'.",
    );
  });

  it('returns execution frames through the public listFrames subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    // An empty sequence run persists no frames, so use a station node that
    // starts a frame in the primitive runtime before failing on the missing
    // in-process handler — the frame rows are persisted either way.
    const workflow = createWorkflowDefinition({
      id: 'public-list-frames',
      name: 'Public List Frames',
      root: {
        id: 'public-list-frames-root',
        type: 'sequence',
        nodes: [
          {
            id: 'frame-producing-station',
            type: 'station',
            prompt: 'This node fails after frame start in the primitive runtime',
          } as WorkflowStationNode,
        ],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    // Wait for the in-process run to finish so the runtime frame store has
    // flushed its persistence tasks before the public read.
    const failedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await expect(failedPromise).resolves.toBe(executionId);

    const { frames } = await MakaioBus.request(WorkflowSubjects.listFrames, { executionId });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.frameId).toBeDefined();
    expect(frames.every((frame) => frame.path.length > 0)).toBe(true);
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
