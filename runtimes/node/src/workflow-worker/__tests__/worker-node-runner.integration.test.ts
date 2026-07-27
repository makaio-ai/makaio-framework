import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNodeNamespace } from '@makaio/contracts';
import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '@makaio/subsystem-workflow-engine';
import type { ExecutionAttemptRepository } from '@makaio/subsystem-workflow-engine';
import { WorkerNodeRunner } from '../worker-node-runner.js';
import { makeWorkerConfig } from './fixtures.js';

const TEST_ALLOCATION_REF: ProviderAllocationRef = {
  version: 1,
  providerId: 'test-provider',
  providerData: {},
};

/**
 * Minimal in-memory repository for integration tests.
 */
function createIntegrationRepository(): ExecutionAttemptRepository {
  const attempts = new Map<string, { executionAttemptId: string; executionId: string }>();
  const outcomes = new Map<string, WorkflowRunResult>();
  const active = new Map<string, string>();

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
    async recordAllocation() {
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
    async abandonPendingAttempt() {
      return { kind: 'abandoned' as const };
    },
    async recordInfrastructureFailure() {
      return { kind: 'recorded' as const };
    },
  };
}

describe('WorkerNodeRunner integration', () => {
  it('creates attempt, forwards requirements, dispatches through bus, and returns authority-committed on cancellation', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNodeNamespace);

    const repository = createIntegrationRepository();
    const authority = new ExecutionAttemptAuthority(repository);

    let dispatchStarted!: () => void;
    const dispatchStartedPromise = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });

    const runner = new WorkerNodeRunner({
      dispatch: async (request, signal) => {
        dispatchStarted();
        if (signal === undefined) throw new Error('WorkerNodeRunner did not forward its cancellation signal');

        expect(request.executionAttemptId).toBeTruthy();
        expect(request.requirements).toEqual({ customCapabilities: ['workflow.remote-reader'] });

        const aborted = signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

        await aborted;

        const result: WorkflowRunResult = {
          executionId: request.config.executionId,
          workflowId: request.config.workflowId,
          status: 'cancelled' as const,
          reason: 'integration cancellation',
        };

        // Commit the outcome through the Authority (simulates worker outcome submission)
        const decision = await authority.commitOutcome(request.executionAttemptId, request.config.executionId, result);
        authority.settleOutcome(request.executionAttemptId, decision);

        return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
      },
      authority,
      requirements: { customCapabilities: ['workflow.remote-reader'] },
    });

    const controller = new AbortController();

    const resultPromise = runner.run(makeWorkerConfig(), controller.signal);
    await dispatchStartedPromise;
    controller.abort();

    const completion = await resultPromise;

    expect(completion.state).toBe('authority-committed');
    expect(completion.result).toEqual({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'cancelled',
      reason: 'integration cancellation',
    });
  });
});
