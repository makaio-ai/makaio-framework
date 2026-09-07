import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkerNamespace, WorkerSubjects, type IWorkflowRunner, type WorkflowRunContext } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { workflowAttemptOutcomeCodec } from '../workflow-attempt-outcome.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
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
    const observed = Promise.withResolvers<WorkflowRunContext>();
    const runner: IWorkflowRunner = {
      ...(terminalAuthority !== undefined ? { terminalAuthority } : {}),
      async run(config) {
        const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
          executionId: config.executionId,
        });
        if (!runContext) throw new Error('Owner context was not persisted before runner invocation');
        observed.resolve(runContext);
        throw new Error('Test runner stops after observing the persisted launch contract');
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner: runner });
    setup.workflowExecutor.registerWorkflowMaterializationSpecResolver({
      resolve: async () => ({
        kind: 'workspace-snapshot',
        snapshotId: 'test-source',
        digest: 'test-digest',
        sourcePath: 'workflow.ts',
      }),
    });
    if (source === 'file') {
      await MakaioBus.request(WorkflowSubjects.runFile, { filePath: '/repo/workflow.ts' });
    } else {
      const workflow = createWorkflowDefinition({
        id: 'configured-runner',
        root: { type: 'sequence', id: 'root', nodes: [] },
      });
      await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
      await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    }
    expect((await observed.promise).terminalAuthority).toBe(terminalAuthority);
  });

  it.each([
    true,
    false,
  ])('derives ownership from actual selection, not Authority presence (requirements: %s)', async (requiresWorker) => {
    const observed: { context?: WorkflowRunContext } = {};
    const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowAttemptOutcomeCodec), {
      bootstrapTimeoutMs: 60_000,
    });
    setup = await setupWorkflowExecutorTest({ initExecutor: false });
    await setup.workflowExecutor.destroy();
    setup.workflowExecutor = new WorkflowExecutor(
      MakaioBus,
      undefined,
      {
        run: async (config) => {
          if (requiresWorker) throw new Error('Fallback runner must not be selected');
          const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
            executionId: config.executionId,
          });
          if (!runContext) throw new Error('Owner context missing at fallback invocation');
          observed.context = runContext;
          throw new Error('Test runner stops after observing the persisted fallback contract');
        },
      },
      authority,
    );
    MakaioBus.registerNamespace(WorkerNamespace);
    await setup.workflowExecutor.init();
    setup.cleanupFns.push(
      MakaioBus.on(WorkerSubjects.dispatch, async (ctx) => {
        const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
          executionId: ctx.payload.config.executionId,
        });
        if (!runContext) throw new Error('Owner context missing at dispatch');
        observed.context = runContext;
        throw new Error('Test provider stops after observing the persisted dispatch contract');
      }),
    );
    const workflow = {
      ...createWorkflowDefinition({
        id: 'requirements-selected',
        root: { type: 'sequence' as const, id: 'root', nodes: [] },
      }),
      ...(requiresWorker ? { requirements: { customCapabilities: ['test-worker'] } } : {}),
    };
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const started = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    if ('error' in started) throw new Error(String(started.error));
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: started.executionId,
    });
    expect(stored.runContext?.terminalAuthority).toBe(requiresWorker ? 'authority' : undefined);
    await expect
      .poll(
        async () =>
          (await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: started.executionId }))
            .execution?.status,
      )
      .toBe('failed');
    const stopped = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: started.executionId,
    });
    expect(observed.context, stopped.execution?.error?.replaceAll('\n', ' ')).toBeDefined();
    expect(observed.context?.terminalAuthority).toBe(requiresWorker ? 'authority' : undefined);
  });
});
