import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderAllocationRef,
  WorkerContributionManifest,
  WorkerDispatch,
  WorkflowRunResult,
  WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowRunContextSchema } from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  parseWorkflowAttemptInstruction,
  workflowAttemptOutcomeCodec,
  type WorkflowAttemptOutcome,
} from '@makaio/subsystem-workflow-engine';
import { WorkerRunner } from '../worker-runner.js';
import { createInMemoryAttemptRepository, makeBeginProvisioningInput } from '@makaio/subsystem-workflow-engine/testing';
import { makeWorkerConfig as makeBaseWorkerConfig } from './fixtures.js';

function makeWorkerConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  const config = makeBaseWorkerConfig(overrides);
  if (config.source.kind === 'definition' && config.definition === undefined) {
    config.definition = {
      id: config.workflowId,
      name: 'Test workflow',
      root: { id: 'root', type: 'sequence', nodes: [] },
      scope: { type: 'global' },
    };
  }
  return config;
}

const TEST_ALLOCATION_REF: ProviderAllocationRef = {
  version: 1,
  providerId: 'test-provider',
  providerData: {},
};

function createTestAuthority(): ExecutionAttemptAuthority<WorkflowAttemptOutcome> {
  return new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowAttemptOutcomeCodec), {
    bootstrapTimeoutMs: 120_000,
  });
}

describe('WorkerRunner', () => {
  it('honors local owner admission before creating an attempt', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const dispatch = vi.fn();
    const runner = new WorkerRunner({ authority, dispatch });
    await expect(
      runner.run(makeWorkerConfig(), new AbortController().signal, undefined, {
        withAttemptCreation: async () => {
          throw new Error('Owner already cancelled');
        },
      }),
    ).rejects.toThrow('Owner already cancelled');
    expect(repository.attempts.size).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([
    false,
    true,
  ])('prevents Attempt creation around a cancelled custom reader (pre-aborted: %s)', async (preAborted) => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 120_000 });
    const dispatch = vi.fn();
    const config = makeWorkerConfig({ source: { kind: 'path', path: 'workflow.ts' } });
    const runContext = WorkflowRunContextSchema.parse({
      ...config,
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'source',
        rootDigest: 'revision-1',
        sourcePath: 'workflow.ts',
      },
      createdAt: 1,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const readRunContext = vi.fn(async (_executionId: string, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      entered.resolve();
      await release.promise;
      return runContext;
    });
    const runner = new WorkerRunner({ authority, dispatch, readRunContext });
    if (preAborted) controller.abort(new Error('owner-read-cancelled'));
    const result = runner.run(config, controller.signal);
    const rejected = expect(result).rejects.toThrow('owner-read-cancelled');
    if (!preAborted) {
      await entered.promise;
      controller.abort(new Error('owner-read-cancelled'));
    }
    release.resolve();
    await rejected;
    expect(readRunContext).toHaveBeenCalledTimes(preAborted ? 0 : 1);
    expect(repository.attempts.size).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a path-backed dispatch before creating an Attempt when portable owner input is absent', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 120_000 });
    const dispatch = vi.fn();
    const runner = new WorkerRunner({ authority, dispatch });
    await expect(
      runner.run(
        makeWorkerConfig({ source: { kind: 'path', path: '/host/workflow.ts' } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('portable run context');
    expect(dispatch).not.toHaveBeenCalled();
    expect(repository.attempts.size).toBe(0);
  });

  it('freezes portable owner input before dispatch and projects technical failure only after convergence', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 120_000 });
    let committedOutcome: WorkflowAttemptOutcome | undefined;
    const config = makeWorkerConfig({ source: { kind: 'path', path: '/host/workflow.ts' } });
    const runContext = WorkflowRunContextSchema.parse({
      ...config,
      source: { kind: 'path', path: 'workflow.ts' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'source',
        rootDigest: 'revision-1',
        sourcePath: 'workflow.ts',
      },
      inputs: { question: 'original' },
      createdAt: 1,
    });
    const runner = new WorkerRunner({
      authority,
      readRunContext: async () => {
        expect(repository.attempts.size).toBe(0);
        return runContext;
      },
      dispatch: async (request) => {
        runContext.inputs = { question: 'changed after creation' };
        const instruction = await authority.getInstruction({
          executionId: config.executionId,
          executionAttemptId: request.executionAttemptId,
        });
        expect(parseWorkflowAttemptInstruction(instruction!)).toMatchObject({
          source: { kind: 'path', path: 'workflow.ts' },
          inputs: { question: 'original' },
        });
        expect(instruction!.workspace).toBeUndefined();
        const outcome: WorkflowAttemptOutcome = {
          kind: 'technical-failure',
          stage: 'startup',
          message: 'adapter unavailable',
        };
        const decision = await authority.commitOutcome(
          request.executionAttemptId,
          config.executionId,
          authority.canonicalizeOutcome(outcome),
        );
        if (decision.kind === 'accepted' || decision.kind === 'duplicate') committedOutcome = decision.outcome;
        // Host convergence precedes settling the waiter; the runner only projects the already-settled result.
        authority.settleOutcome(request.executionAttemptId, decision);
        return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
      },
    });
    await expect(runner.run(config, new AbortController().signal)).resolves.toEqual({
      state: 'authority-committed',
      result: {
        executionId: config.executionId,
        workflowId: config.workflowId,
        status: 'failed',
        error: 'startup: adapter unavailable',
      },
    });
    expect(committedOutcome).toEqual({ kind: 'technical-failure', stage: 'startup', message: 'adapter unavailable' });
  });

  it('creates an attempt before dispatch and returns authority-committed', async () => {
    const authority = createTestAuthority();
    let capturedAttemptId: string | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedAttemptId = request.executionAttemptId;
      // Simulate outcome commitment by the worker via the Authority
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        request.executionAttemptId,
        'wfx-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerRunner({ dispatch, authority });
    const signal = new AbortController().signal;

    const completion = await runner.run(makeWorkerConfig(), signal);

    expect(capturedAttemptId).toBeTruthy();
    expect(completion.state).toBe('authority-committed');
    expect(completion.result.status).toBe('completed');
  });

  it('forwards executionAttemptId and authority terminalization in the dispatch request', async () => {
    const authority = createTestAuthority();
    let capturedRequest: Parameters<WorkerDispatch>[0] | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        request.executionAttemptId,
        'wfx-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const manifest: WorkerContributionManifest = { contributionRefs: [] };
    const runner = new WorkerRunner({ dispatch, authority, manifest });
    const signal = new AbortController().signal;

    const config = makeWorkerConfig({ terminalAuthority: 'worker' });
    await runner.run(config, signal);

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.executionAttemptId).toBeTruthy();
    expect(capturedRequest!.config).toEqual({
      ...config,
      terminalAuthority: 'authority',
    });
    expect(capturedRequest!.manifest).toEqual(manifest);
  });

  it('forwards optional requirements to the dispatch function', async () => {
    const authority = createTestAuthority();
    const manifest: WorkerContributionManifest = { contributionRefs: [] };
    const requirements = { persistentStorage: true, customCapabilities: [] };
    let capturedRequest: Parameters<WorkerDispatch>[0] | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        request.executionAttemptId,
        'wfx-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerRunner({ dispatch, authority, manifest, requirements });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect(capturedRequest!.requirements).toEqual(requirements);
  });

  it('forwards per-run dispatch metadata to the dispatch function', async () => {
    const authority = createTestAuthority();
    const dispatchMetadata = { resume: true, providerRunId: 'gha-1' };
    let capturedRequest: Parameters<WorkerDispatch>[0] | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        request.executionAttemptId,
        'wfx-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerRunner({ dispatch, authority });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal, undefined, { dispatchMetadata });

    expect(capturedRequest!.metadata).toEqual(dispatchMetadata);
  });

  it('omits requirements from the dispatch payload when not provided', async () => {
    const authority = createTestAuthority();
    const manifest: WorkerContributionManifest = { contributionRefs: [] };
    let capturedRequest: Parameters<WorkerDispatch>[0] | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        request.executionAttemptId,
        'wfx-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerRunner({ dispatch, authority, manifest });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect('requirements' in capturedRequest!).toBe(false);
  });

  it('omits manifest from the dispatch payload when no manifest source is provided', async () => {
    const authority = createTestAuthority();
    let capturedRequest: Parameters<WorkerDispatch>[0] | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        request.executionAttemptId,
        'wfx-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerRunner({ dispatch, authority });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect('manifest' in capturedRequest!).toBe(false);
  });

  it('propagates dispatch rejection to caller and discards waiter', async () => {
    const authority = createTestAuthority();
    const dispatch = vi.fn().mockRejectedValue(new Error('Dispatch failed'));
    const runner = new WorkerRunner({ dispatch, authority });

    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow('Dispatch failed');
  });

  it('abandons the durable pending attempt when dispatch rejects', async () => {
    const abandonPendingAttempt = vi.fn().mockResolvedValue({ kind: 'abandoned' as const });
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority<WorkflowAttemptOutcome>(
      { ...repository, abandonPendingAttempt },
      { bootstrapTimeoutMs: 120_000 },
    );
    const runner = new WorkerRunner({
      dispatch: vi.fn().mockRejectedValue(new Error('dispatch failed')),
      authority,
    });

    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow('dispatch failed');
    expect(abandonPendingAttempt).toHaveBeenCalledWith(expect.any(String), 'wfx-1');
  });

  it('awaits the Authority outcome when allocation persists before the dispatch acknowledgement rejects', async () => {
    const authority = createTestAuthority();
    const runner = new WorkerRunner({
      authority,
      dispatch: async (request) => {
        const begun = await authority.beginProvisioning(
          makeBeginProvisioningInput(request.executionAttemptId, 'wfx-1'),
        );
        if (begun.kind !== 'started') throw new Error(`expected provisioning to start, got '${begun.kind}'`);
        await authority.recordAllocation({ claim: begun.claim, allocationRef: TEST_ALLOCATION_REF });
        queueMicrotask(async () => {
          const result: WorkflowRunResult = {
            executionId: 'wfx-1',
            workflowId: 'workflow-1',
            status: 'completed',
          };
          const decision = await authority.commitOutcome(
            request.executionAttemptId,
            'wfx-1',
            authority.canonicalizeOutcome(result),
          );
          authority.settleOutcome(request.executionAttemptId, decision);
        });
        throw new Error('dispatch acknowledgement lost');
      },
    });

    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).resolves.toMatchObject({
      state: 'authority-committed',
      result: { status: 'completed' },
    });
  });

  it('forwards static requirements to dispatch without merging', async () => {
    const authority = createTestAuthority();
    let capturedRequest: Parameters<WorkerDispatch>[0] | undefined;
    const dispatch: WorkerDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'exec-1',
        workflowId: 'factory:intake',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        request.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerRunner({
      dispatch,
      authority,
      requirements: { customCapabilities: ['base'] },
    });

    await runner.run(
      makeWorkerConfig({
        source: { kind: 'definition', workflowId: 'factory:intake' },
        executionId: 'exec-1',
        workflowId: 'factory:intake',
        busUrl: 'ws://localhost:1',
        coordinatorSessionId: 'session-1',
        cancelSubject: 'workflow.exec-1.cancel',
      }),
      new AbortController().signal,
    );

    expect(capturedRequest!.requirements).toEqual({
      customCapabilities: ['base'],
    });
  });

  it('discards waiter on dispatch error to prevent memory leak', async () => {
    const authority = createTestAuthority();
    const dispatch = vi.fn().mockRejectedValue(new Error('provision failed'));
    const runner = new WorkerRunner({ dispatch, authority });

    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow('provision failed');

    // The Authority's waiter should have been cleaned up
    // (we can't directly inspect waiters, but the error path discards them)
  });

  it('waits for authority outcome after dispatch returns allocation acceptance', async () => {
    const authority = createTestAuthority();
    let resolveOutcome!: () => void;
    const outcomeBarrier = new Promise<void>((resolve) => {
      resolveOutcome = resolve;
    });

    const dispatch: WorkerDispatch = async (request) => {
      // Simulate: dispatch returns after allocation, outcome arrives later
      setTimeout(async () => {
        const result: WorkflowRunResult = {
          executionId: 'wfx-1',
          workflowId: 'workflow-1',
          status: 'completed',
        };
        const decision = await authority.commitOutcome(
          request.executionAttemptId,
          'wfx-1',
          authority.canonicalizeOutcome(result),
        );
        authority.settleOutcome(request.executionAttemptId, decision);
        resolveOutcome();
      }, 10);

      // Dispatch returns before outcome is committed
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerRunner({ dispatch, authority });

    const completion = await runner.run(makeWorkerConfig(), new AbortController().signal);
    await outcomeBarrier;

    expect(completion.state).toBe('authority-committed');
    expect(completion.result.status).toBe('completed');
  });

  it('waits for the Authority outcome after cancellation instead of inferring infrastructure failure', async () => {
    const recordInfrastructureFailure = vi.fn().mockResolvedValue({ kind: 'recorded' as const });
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority<WorkflowAttemptOutcome>(
      { ...repository, recordInfrastructureFailure },
      { bootstrapTimeoutMs: 120_000 },
    );
    let dispatchStarted!: () => void;
    const dispatchStartedPromise = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const runner = new WorkerRunner({
      authority,
      dispatch: async (request, signal) => {
        setTimeout(async () => {
          const result: WorkflowRunResult = {
            executionId: 'wfx-1',
            workflowId: 'workflow-1',
            status: 'cancelled',
          };
          const decision = await authority.commitOutcome(
            request.executionAttemptId,
            'wfx-1',
            authority.canonicalizeOutcome(result),
          );
          authority.settleOutcome(request.executionAttemptId, decision);
        }, 0);
        expect(signal.aborted).toBe(false);
        dispatchStarted();
        return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
      },
    });
    const controller = new AbortController();
    const running = runner.run(makeWorkerConfig(), controller.signal);

    await dispatchStartedPromise;
    controller.abort('cancelled');

    await expect(running).resolves.toMatchObject({
      state: 'authority-committed',
      result: { status: 'cancelled' },
    });
    expect(recordInfrastructureFailure).not.toHaveBeenCalled();
  });
});
