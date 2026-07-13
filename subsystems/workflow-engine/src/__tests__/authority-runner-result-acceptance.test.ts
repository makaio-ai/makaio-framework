import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createWorkflowFinalizerNamespace, type WorkflowRunResult } from '@makaio/contracts';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

describe('authority runner result acceptance', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) await teardownWorkflowExecutorTest(setup);
    setup = undefined;
  });

  async function seedAuthorityExecution(options: {
    executionId: string;
    finalizerId?: string;
    authority?: 'authority' | 'worker';
  }) {
    const workflow = {
      ...createWorkflowDefinition({
        id: `workflow-${options.executionId}`,
        root: { id: `root-${options.executionId}`, type: 'sequence' as const, nodes: [] },
      }),
      ...(options.finalizerId === undefined ? {} : { successFinalizerId: options.finalizerId }),
    };
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({ id: options.executionId, workflowId: workflow.id }),
      runContext: {
        executionId: options.executionId,
        workflowId: workflow.id,
        source: { kind: 'definition' as const, workflowId: workflow.id },
        definitionSnapshot: workflow,
        workerManifest: { packages: [] },
        inputs: {},
        scope: { type: 'global' as const },
        triggerPayload: {},
        coordinatorSessionId: `session-${options.executionId}`,
        cancelSubject: `workflow.${options.executionId}.cancel`,
        context: { repoPath: '/tmp', makaioHome: '/tmp', os: 'linux' as const, arch: 'x64' },
        env: {},
        createdAt: Date.now(),
        suspensionStrategy: 'wait-in-process' as const,
        terminalAuthority: options.authority ?? 'authority',
      },
    });
    return workflow;
  }

  it.each([
    { status: 'completed' as const },
    { status: 'failed' as const, error: 'runner failed' },
    { status: 'cancelled' as const, reason: 'runner cancelled' },
  ])('adopts a durable execution and idempotently accepts a $status result', async (terminal) => {
    if (!setup) throw new Error('Workflow executor test setup did not initialize.');
    const executionId = `authority-${terminal.status}`;
    const workflow = await seedAuthorityExecution({ executionId });
    const result = { executionId, workflowId: workflow.id, ...terminal } as WorkflowRunResult;

    await expect(setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, result)).resolves.toEqual({
      accepted: true,
      status: terminal.status,
    });
    await expect(setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, result)).resolves.toEqual({
      accepted: true,
      status: terminal.status,
    });
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution).toEqual(expect.objectContaining({ status: terminal.status }));
  });

  it('rejects missing, mismatched, non-terminal, and worker-owned results', async () => {
    if (!setup) throw new Error('Workflow executor test setup did not initialize.');
    const executionId = 'authority-invalid';
    const workflow = await seedAuthorityExecution({ executionId, authority: 'worker' });

    await expect(
      setup.workflowExecutor.acceptAuthorityRunnerResult('missing', {
        executionId: 'missing',
        workflowId: workflow.id,
        status: 'completed',
      }),
    ).rejects.toThrow('not found');
    await expect(
      setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, {
        executionId: 'different',
        workflowId: workflow.id,
        status: 'completed',
      }),
    ).rejects.toThrow('execution identity mismatch');
    await expect(
      setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, {
        executionId,
        workflowId: workflow.id,
        status: 'paused',
        pausedAtGateId: 'gate',
        pausedAtFrameId: 'frame',
      }),
    ).rejects.toThrow('must be terminal');
    await expect(
      setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, {
        executionId,
        workflowId: workflow.id,
        status: 'completed',
      }),
    ).rejects.toThrow('terminalAuthority=authority');
  });

  it('preserves a success-finalizer claim and retries delivery idempotently', async () => {
    if (!setup) throw new Error('Workflow executor test setup did not initialize.');
    const executionId = 'authority-finalizer-retry';
    const finalizerId = 'test.authority-retry';
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    MakaioBus.registerNamespace(namespace);
    const workflow = await seedAuthorityExecution({ executionId, finalizerId });
    const result: WorkflowRunResult = { executionId, workflowId: workflow.id, status: 'completed' };

    const offFailure = MakaioBus.on(subjects.finalize, () => {
      throw new Error('transient finalizer failure');
    });
    await expect(setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, result)).rejects.toThrow(
      'transient finalizer failure',
    );
    offFailure();
    const intermediate = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(intermediate.execution?.status).toBe('finalizing');

    MakaioBus.on(subjects.finalize, async (ctx) => {
      await MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId: ctx.payload.executionId,
        claimToken: ctx.payload.claimToken,
        settledAt: Date.now(),
      });
      ctx.setResult({ accepted: true });
    });
    await expect(setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, result)).resolves.toEqual({
      accepted: true,
      status: 'completed',
    });
  });

  it('accepts an asynchronous success finalizer while durable settlement remains pending', async () => {
    if (!setup) throw new Error('Workflow executor test setup did not initialize.');
    const executionId = 'authority-finalizer-delayed-ack';
    const finalizerId = 'test.authority-delayed-ack';
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    MakaioBus.registerNamespace(namespace);
    const workflow = await seedAuthorityExecution({ executionId, finalizerId });
    const result: WorkflowRunResult = { executionId, workflowId: workflow.id, status: 'completed' };
    let claimToken: string | undefined;

    MakaioBus.on(subjects.finalize, (ctx) => {
      claimToken = ctx.payload.claimToken;
      ctx.setResult({ accepted: true });
    });

    await expect(setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, result)).resolves.toEqual({
      accepted: true,
      status: 'finalizing',
    });
    await expect(setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, result)).resolves.toEqual({
      accepted: true,
      status: 'finalizing',
    });
    if (!claimToken) throw new Error('Success finalizer delivery did not expose a claim token.');

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId,
        claimToken,
        settledAt: Date.now(),
      }),
    ).resolves.toEqual({ acknowledged: true });
    await expect(setup.workflowExecutor.acceptAuthorityRunnerResult(executionId, result)).resolves.toEqual({
      accepted: true,
      status: 'completed',
    });
  });
});
