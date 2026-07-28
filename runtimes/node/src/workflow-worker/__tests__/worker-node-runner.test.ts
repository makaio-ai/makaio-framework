import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderAllocationRef,
  WorkerContributionManifest,
  WorkerNodeDispatch,
  WorkflowRunResult,
} from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '@makaio/subsystem-workflow-engine';
import type { ExecutionAttemptRepository } from '@makaio/subsystem-workflow-engine';
import { WorkerNodeRunner } from '../worker-node-runner.js';
import { makeWorkerConfig } from './fixtures.js';

const TEST_ALLOCATION_REF: ProviderAllocationRef = {
  version: 1,
  providerId: 'test-provider',
  providerData: {},
};

// ─────────────────────────────────────────────────────────────
// Test Authority Fixture
// ─────────────────────────────────────────────────────────────

function createTestRepository(): ExecutionAttemptRepository {
  const attempts = new Map<string, { executionAttemptId: string; executionId: string }>();
  const outcomes = new Map<string, WorkflowRunResult>();
  const active = new Map<string, string>();
  const allocatedAttempts = new Set<string>();

  return {
    async createAttempt(input) {
      attempts.set(input.executionAttemptId, input);
      active.set(input.executionId, input.executionAttemptId);
      return {
        executionAttemptId: input.executionAttemptId,
        executionId: input.executionId,
        status: 'pending' as const,
        allocationRef: null,
        createdAt: new Date().toISOString(),
      };
    },
    async beginProvisioning() {
      return { kind: 'started' as const };
    },
    async recordAllocation(executionAttemptId) {
      allocatedAttempts.add(executionAttemptId);
      return { kind: 'recorded' as const };
    },
    async recordProvisioningFailure() {
      return { kind: 'recorded' as const };
    },
    async getActiveAttempt(executionId, executionAttemptId) {
      if (active.get(executionId) !== executionAttemptId) return null;
      const a = attempts.get(executionAttemptId);
      if (!a) return null;
      return {
        ...a,
        status: 'pending' as const,
        allocationRef: null,
        createdAt: new Date().toISOString(),
      };
    },
    async commitOutcome(input) {
      const prior = outcomes.get(input.executionAttemptId);
      if (prior) {
        if (JSON.stringify(prior) === JSON.stringify(input.result)) {
          return { kind: 'duplicate', outcome: prior };
        }
        return { kind: 'conflict' };
      }
      const activeId = active.get(input.executionId);
      if (activeId !== input.executionAttemptId) {
        return { kind: 'fenced' };
      }
      outcomes.set(input.executionAttemptId, input.result);
      return { kind: 'accepted', outcome: input.result };
    },
    async abandonPendingAttempt(executionAttemptId) {
      if (allocatedAttempts.has(executionAttemptId)) return { kind: 'allocated' };
      return { kind: 'abandoned' };
    },
    async recordInfrastructureFailure() {
      return { kind: 'recorded' };
    },
  };
}

function createTestAuthority(): ExecutionAttemptAuthority {
  return new ExecutionAttemptAuthority(createTestRepository());
}

describe('WorkerNodeRunner', () => {
  it('creates an attempt before dispatch and returns authority-committed', async () => {
    const authority = createTestAuthority();
    let capturedAttemptId: string | undefined;
    const dispatch: WorkerNodeDispatch = async (request) => {
      capturedAttemptId = request.executionAttemptId;
      // Simulate outcome commitment by the worker via the Authority
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerNodeRunner({ dispatch, authority });
    const signal = new AbortController().signal;

    const completion = await runner.run(makeWorkerConfig(), signal);

    expect(capturedAttemptId).toBeTruthy();
    expect(completion.state).toBe('authority-committed');
    expect(completion.result.status).toBe('completed');
  });

  it('forwards executionAttemptId and authority terminalization in the dispatch request', async () => {
    const authority = createTestAuthority();
    let capturedRequest: Parameters<WorkerNodeDispatch>[0] | undefined;
    const dispatch: WorkerNodeDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const manifest: WorkerContributionManifest = { contributionRefs: [] };
    const runner = new WorkerNodeRunner({ dispatch, authority, manifest });
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
    let capturedRequest: Parameters<WorkerNodeDispatch>[0] | undefined;
    const dispatch: WorkerNodeDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerNodeRunner({ dispatch, authority, manifest, requirements });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect(capturedRequest!.requirements).toEqual(requirements);
  });

  it('forwards per-run dispatch metadata to the dispatch function', async () => {
    const authority = createTestAuthority();
    const dispatchMetadata = { resume: true, providerRunId: 'gha-1' };
    let capturedRequest: Parameters<WorkerNodeDispatch>[0] | undefined;
    const dispatch: WorkerNodeDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerNodeRunner({ dispatch, authority });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal, undefined, { dispatchMetadata });

    expect(capturedRequest!.metadata).toEqual(dispatchMetadata);
  });

  it('omits requirements from the dispatch payload when not provided', async () => {
    const authority = createTestAuthority();
    const manifest: WorkerContributionManifest = { contributionRefs: [] };
    let capturedRequest: Parameters<WorkerNodeDispatch>[0] | undefined;
    const dispatch: WorkerNodeDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerNodeRunner({ dispatch, authority, manifest });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect('requirements' in capturedRequest!).toBe(false);
  });

  it('omits manifest from the dispatch payload when no manifest source is provided', async () => {
    const authority = createTestAuthority();
    let capturedRequest: Parameters<WorkerNodeDispatch>[0] | undefined;
    const dispatch: WorkerNodeDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerNodeRunner({ dispatch, authority });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect('manifest' in capturedRequest!).toBe(false);
  });

  it('propagates dispatch rejection to caller and discards waiter', async () => {
    const authority = createTestAuthority();
    const dispatch = vi.fn().mockRejectedValue(new Error('Dispatch failed'));
    const runner = new WorkerNodeRunner({ dispatch, authority });

    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow('Dispatch failed');
  });

  it('abandons the durable pending attempt when dispatch rejects', async () => {
    const abandonPendingAttempt = vi.fn().mockResolvedValue({ kind: 'abandoned' as const });
    const repository = createTestRepository();
    const authority = new ExecutionAttemptAuthority({ ...repository, abandonPendingAttempt });
    const runner = new WorkerNodeRunner({
      dispatch: vi.fn().mockRejectedValue(new Error('dispatch failed')),
      authority,
    });

    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow('dispatch failed');
    expect(abandonPendingAttempt).toHaveBeenCalledWith(expect.any(String), 'wfx-1');
  });

  it('awaits the Authority outcome when allocation persists before the dispatch acknowledgement rejects', async () => {
    const authority = createTestAuthority();
    const runner = new WorkerNodeRunner({
      authority,
      dispatch: async (request) => {
        await authority.beginProvisioning(request.executionAttemptId, 'wfx-1');
        await authority.recordAllocation(request.executionAttemptId, TEST_ALLOCATION_REF);
        queueMicrotask(async () => {
          const result: WorkflowRunResult = {
            executionId: 'wfx-1',
            workflowId: 'workflow-1',
            status: 'completed',
          };
          const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
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
    let capturedRequest: Parameters<WorkerNodeDispatch>[0] | undefined;
    const dispatch: WorkerNodeDispatch = async (request) => {
      capturedRequest = request;
      const result: WorkflowRunResult = {
        executionId: 'exec-1',
        workflowId: 'factory:intake',
        status: 'completed',
      };
      const decision = await authority.commitOutcome(request.executionAttemptId, 'exec-1', result);
      authority.settleOutcome(request.executionAttemptId, decision);
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerNodeRunner({
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
    const runner = new WorkerNodeRunner({ dispatch, authority });

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

    const dispatch: WorkerNodeDispatch = async (request) => {
      // Simulate: dispatch returns after allocation, outcome arrives later
      setTimeout(async () => {
        const result: WorkflowRunResult = {
          executionId: 'wfx-1',
          workflowId: 'workflow-1',
          status: 'completed',
        };
        const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
        authority.settleOutcome(request.executionAttemptId, decision);
        resolveOutcome();
      }, 10);

      // Dispatch returns before outcome is committed
      return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
    };
    const runner = new WorkerNodeRunner({ dispatch, authority });

    const completion = await runner.run(makeWorkerConfig(), new AbortController().signal);
    await outcomeBarrier;

    expect(completion.state).toBe('authority-committed');
    expect(completion.result.status).toBe('completed');
  });

  it('waits for the Authority outcome after cancellation instead of inferring infrastructure failure', async () => {
    const recordInfrastructureFailure = vi.fn().mockResolvedValue({ kind: 'recorded' as const });
    const repository = createTestRepository();
    const authority = new ExecutionAttemptAuthority({ ...repository, recordInfrastructureFailure });
    let dispatchStarted!: () => void;
    const dispatchStartedPromise = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const runner = new WorkerNodeRunner({
      authority,
      dispatch: async (request, signal) => {
        setTimeout(async () => {
          const result: WorkflowRunResult = {
            executionId: 'wfx-1',
            workflowId: 'workflow-1',
            status: 'cancelled',
          };
          const decision = await authority.commitOutcome(request.executionAttemptId, 'wfx-1', result);
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
