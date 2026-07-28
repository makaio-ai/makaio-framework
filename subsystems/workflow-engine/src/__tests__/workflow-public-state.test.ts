import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  type IWorkflowRunner,
  type StationHandler,
  type WorkflowRunnerCompletion,
  type WorkflowStationNode,
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

/**
 * Register the host seam required to freeze a path-backed test execution.
 * @param setup - Initialized workflow executor test fixture.
 * @param snapshotId - Stable snapshot identity asserted by the test.
 * @param sourcePath - Workspace-relative workflow source path.
 */
function registerWorkspaceSnapshotResolver(
  setup: WorkflowExecutorTestSetup,
  snapshotId: string,
  sourcePath: string,
): void {
  setup.workflowExecutor.registerWorkflowMaterializationSpecResolver({
    resolve: async () => ({
      kind: 'workspace-snapshot',
      snapshotId,
      digest: `sha256:${snapshotId}`,
      sourcePath,
    }),
  });
}

describe('workflow public state subjects', () => {
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
      async run(config, signal): Promise<WorkflowRunnerCompletion> {
        const result = await runWorkflowOrchestrator({
          config,
          loaded: {
            definition: workflow,
            runtimeHandlers: new Map([['read-state', readState]]),
          },
          bus: MakaioBus,
          signal,
        });
        return { state: 'uncommitted', result };
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });
    registerWorkspaceSnapshotResolver(setup, 'file-state-workspace', 'workflows/file-state.ts');

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
    expect(runContext?.source).toEqual({ kind: 'path', path: 'workflows/file-state.ts' });
    expect(runContext?.materializationSpec).toEqual({
      kind: 'workspace-snapshot',
      snapshotId: 'file-state-workspace',
      digest: 'sha256:file-state-workspace',
      sourcePath: 'workflows/file-state.ts',
    });
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
      executableSource: {
        kind: 'path' as const,
        path: '.makaio/workflows/path-state.ts',
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
      async run(config, signal): Promise<WorkflowRunnerCompletion> {
        const result = await runWorkflowOrchestrator({
          config,
          loaded: {
            definition: loadedWorkflow,
            runtimeHandlers: new Map([['read-path-state', readState]]),
          },
          bus: MakaioBus,
          signal,
        });
        return { state: 'uncommitted', result };
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });
    registerWorkspaceSnapshotResolver(setup, 'path-state-workspace', '.makaio/workflows/path-state.ts');
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
      path: '.makaio/workflows/path-state.ts',
    });
    expect(runContext?.materializationSpec).toEqual({
      kind: 'workspace-snapshot',
      snapshotId: 'path-state-workspace',
      digest: 'sha256:path-state-workspace',
      sourcePath: '.makaio/workflows/path-state.ts',
    });
    expect(runContext?.definitionSnapshot?.state).toEqual(loadedWorkflow.state);
  });
});
