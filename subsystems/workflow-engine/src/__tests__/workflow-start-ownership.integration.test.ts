import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import {
  WorkerNamespace,
  WorkerSubjects,
  type IWorkflowRunner,
  type StoredWorkflowRunContext,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('workflow start terminal ownership', () => {
  let setup: WorkflowExecutorTestSetup | undefined;
  afterEach(async () => {
    if (setup) await teardownWorkflowExecutorTest(setup);
    setup = undefined;
  });

  it.each([
    { source: 'file', terminalAuthority: 'authority' },
    { source: 'file', terminalAuthority: undefined },
    { source: 'definition', terminalAuthority: 'authority' },
    { source: 'definition', terminalAuthority: undefined },
  ] as const)('persists $terminalAuthority before invoking the selected $source runner', async ({
    source,
    terminalAuthority,
  }) => {
    const observed = Promise.withResolvers<StoredWorkflowRunContext>();
    const runner: IWorkflowRunner = {
      ...(terminalAuthority !== undefined ? { terminalAuthority } : {}),
      async run(call, config) {
        const { runContext } = await MakaioBus.request(call, WorkflowStorageSubjects.getRunContext, {
          executionId: config.executionId,
        });
        if (!runContext) throw new Error('Owner context was not persisted before runner invocation');
        observed.resolve(runContext);
        throw new Error('Test runner stops after observing the persisted launch contract');
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner: runner });
    const selectRunner = vi.fn(() => undefined);
    setup.cleanupFns.push(setup.workflowExecutor.registerWorkflowRunnerSelector(selectRunner));
    setup.workflowExecutor.registerWorkflowMaterializationSpecResolver({
      resolve: async () => ({
        kind: 'workspace-snapshot',
        snapshotId: 'test-source',
        digest: 'test-digest',
        sourcePath: 'workflow.ts',
      }),
    });
    if (source === 'file') {
      await MakaioBus.request(createTestCall(), WorkflowSubjects.runFile, { filePath: '/repo/workflow.ts' });
    } else {
      const workflow = createWorkflowDefinition({
        id: 'configured-runner',
        root: { type: 'sequence', id: 'root', nodes: [] },
      });
      await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.set, { workflow });
      await MakaioBus.request(createTestCall(), WorkflowSubjects.start, { workflowId: workflow.id });
    }
    expect((await observed.promise).terminalAuthority).toBe(terminalAuthority);
    expect(selectRunner).toHaveBeenCalledTimes(source === 'file' ? 0 : 1);
  });

  it('completes a local definition run without a worker outcome endpoint', async () => {
    setup = await setupWorkflowExecutorTest();
    MakaioBus.registerNamespace(WorkerNamespace);
    const workflow = createWorkflowDefinition({
      id: 'local-run',
      root: { type: 'sequence', id: 'root', nodes: [] },
    });
    const call = createTestCall();
    await MakaioBus.request(call, WorkflowStorageSubjects.set, { workflow });
    const started = await MakaioBus.request(call, WorkflowSubjects.start, { workflowId: workflow.id });
    if ('error' in started) throw new Error(String(started.error));
    const { executionId } = started;

    await expect
      .poll(() => MakaioBus.request(call, WorkflowStorageSubjects.getExecution, { executionId }))
      .toMatchObject({ execution: { id: executionId, status: 'completed' } });
    await expect(
      MakaioBus.requestOptional(call, WorkerSubjects.control.outcome.submit, {
        executionId,
        result: { executionId, workflowId: workflow.id, status: 'completed' },
      }),
    ).resolves.toEqual({ handled: false });
  });

  it.each([
    true,
    false,
  ])('derives ownership from the registered selector (requirements: %s)', async (requiresWorker) => {
    const observed: { context?: StoredWorkflowRunContext } = {};
    const observe: IWorkflowRunner['run'] = async (call, config) => {
      const { runContext } = await MakaioBus.request(call, WorkflowStorageSubjects.getRunContext, {
        executionId: config.executionId,
      });
      if (!runContext) throw new Error('Owner context missing at runner invocation');
      observed.context = runContext;
      throw new Error('Test runner stops after observing the persisted launch contract');
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner: { run: observe } });
    setup.cleanupFns.push(
      setup.workflowExecutor.registerWorkflowRunnerSelector((_call, { requirements }) =>
        requirements === undefined ? undefined : { terminalAuthority: 'authority', run: observe },
      ),
    );
    const workflow = {
      ...createWorkflowDefinition({
        id: 'requirements-selected',
        root: { type: 'sequence' as const, id: 'root', nodes: [] },
      }),
      ...(requiresWorker ? { requirements: { customCapabilities: ['test-worker'] } } : {}),
    };
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.set, { workflow });
    const started = await MakaioBus.request(createTestCall(), WorkflowSubjects.start, { workflowId: workflow.id });
    if ('error' in started) throw new Error(String(started.error));
    const stored = await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getRunContext, {
      executionId: started.executionId,
    });
    expect(stored.runContext?.terminalAuthority).toBe(requiresWorker ? 'authority' : undefined);
    await expect
      .poll(
        async () =>
          (
            await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getExecution, {
              executionId: started.executionId,
            })
          ).execution?.status,
      )
      .toBe('failed');
    const stopped = await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getExecution, {
      executionId: started.executionId,
    });
    expect(observed.context, stopped.execution?.error?.replaceAll('\n', ' ')).toBeDefined();
    expect(observed.context?.terminalAuthority).toBe(requiresWorker ? 'authority' : undefined);
  });
});
