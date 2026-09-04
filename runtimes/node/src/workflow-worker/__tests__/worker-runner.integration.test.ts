import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNamespace } from '@makaio/contracts';
import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '@makaio/subsystem-workflow-engine';
import { WorkerRunner } from '../worker-runner.js';
import {
  createInMemoryAttemptRepository,
  workflowRunResultOutcomeCodec,
} from '@makaio/subsystem-workflow-engine/testing';
import { makeWorkerConfig } from './fixtures.js';

const TEST_ALLOCATION_REF: ProviderAllocationRef = {
  version: 1,
  providerId: 'test-provider',
  providerData: {},
};

describe('WorkerRunner integration', () => {
  it('creates attempt, forwards requirements, dispatches through bus, and returns authority-committed on cancellation', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);

    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository);

    let dispatchStarted!: () => void;
    const dispatchStartedPromise = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });

    const runner = new WorkerRunner({
      dispatch: async (request, signal) => {
        dispatchStarted();
        if (signal === undefined) throw new Error('WorkerRunner did not forward its cancellation signal');

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
        const decision = await authority.commitOutcome(
          request.executionAttemptId,
          request.config.executionId,
          authority.canonicalizeOutcome(result),
        );
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
