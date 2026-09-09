import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNamespace } from '@makaio/contracts';
import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  submitAttemptOutcome,
  workflowAttemptOutcomeCodec,
} from '@makaio/subsystem-workflow-engine';
import { WorkerRunner } from '../worker-runner.js';
import { createInMemoryAttemptRepository } from '@makaio/subsystem-workflow-engine/testing';
import { makeWorkerConfig } from './fixtures.js';

const TEST_ALLOCATION_REF: ProviderAllocationRef = {
  version: 1,
  providerId: 'test-provider',
  providerData: {},
};

describe('WorkerRunner integration', () => {
  it('returns the canonical recorded-only fact without manufacturing a cancellation result', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 120_000 });
    const outcome: WorkflowRunResult = { executionId: 'wfx-1', workflowId: 'workflow-1', status: 'completed' };
    const runner = new WorkerRunner({
      authority,
      dispatch: async (request) => {
        await submitAttemptOutcome(
          { authority, convergence: { converge: async () => 'recorded-only' } },
          {
            executionAttemptId: request.executionAttemptId,
            executionId: request.config.executionId,
            outcome,
          },
        );
        return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
      },
    });
    const completion = await runner.run(
      makeWorkerConfig({ source: { kind: 'source', filename: 'workflow.ts', source: 'export default workflow;' } }),
      new AbortController().signal,
    );
    expect(completion).toEqual({
      state: 'authority-recorded-only',
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      acceptedOutcome: {
        outcome,
        acceptance: 'recorded-only',
        controlObservation: { controlRevision: 0, cancellation: null },
      },
    });
    expect(completion).not.toHaveProperty('result');
    expect([...repository.committedOutcomes.values()]).toEqual([JSON.stringify(outcome)]);
  });
  it('creates attempt, forwards requirements, dispatches through bus, and returns authority-committed on cancellation', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 120_000 });

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
        authority.settleOutcome(
          request.executionAttemptId,
          decision.kind === 'accepted' || decision.kind === 'duplicate'
            ? { ...decision, acceptance: 'projected' }
            : decision,
        );

        return { executionAttemptId: request.executionAttemptId, allocationRef: TEST_ALLOCATION_REF };
      },
      authority,
      requirements: { customCapabilities: ['workflow.remote-reader'] },
    });

    const controller = new AbortController();

    const resultPromise = runner.run(
      makeWorkerConfig({
        definition: {
          id: 'workflow-1',
          name: 'Test workflow',
          root: { id: 'root', type: 'sequence', nodes: [] },
          scope: { type: 'global' },
        },
      }),
      controller.signal,
    );
    await dispatchStartedPromise;
    controller.abort();

    const completion = await resultPromise;

    expect(completion.state).toBe('authority-committed');
    if (completion.state !== 'authority-committed') throw new Error('Expected projected completion');
    expect(completion.result).toEqual({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'cancelled',
      reason: 'integration cancellation',
    });
  });
});
