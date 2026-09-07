import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import {
  makeEvidence,
  makeTestAllocationRef,
  makeTestInstruction,
  makeTestWorkflowResult,
} from '../attempt-fixtures.js';
import { allocateAttempt, nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register immutable bootstrap budgets and coherent historical start-state reads.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerBootstrapStartStateCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('persists the bootstrap deadline at the declared budget after its creation instant', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const record = await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: 12_345,
    });
    expect(Date.parse(record.bootstrapDeadlineAt ?? '') - Date.parse(record.createdAt)).toBe(12_345);
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toEqual(record);
  });

  it.each([
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER,
    8_640_000_000_000_000,
  ])('rejects invalid or overflowing bootstrap budget %s before moving the active pointer', async (bootstrapTimeoutMs) => {
    const harness = getHarness();
    const original = nextIds();
    const record = await harness.repository.createAttempt({
      ...original,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const invalid = { executionId: original.executionId, executionAttemptId: nextIds().executionAttemptId };
    // The port requires rejection without writes, not a backend-specific error class.
    await expect(
      harness.peer.createAttempt({ ...invalid, instruction: makeTestInstruction(), bootstrapTimeoutMs }),
    ).rejects.toThrow();
    expect(await harness.repository.getActiveAttempt(original.executionId, original.executionAttemptId)).toEqual(
      record,
    );
    expect(await harness.repository.readBootstrapStartState(invalid)).toBeNull();
    expect(await harness.peer.readBootstrapStartState(original)).toMatchObject({
      active: true,
      operationStartGate: 'open',
    });
  });

  it('reads coherent bootstrap facts through provisioning, allocation, termination and settlement', async () => {
    const harness = getHarness();
    const ids = nextIds();
    expect(await harness.repository.readBootstrapStartState(ids)).toBeNull();
    const claim = await startAttempt(harness.repository, ids);
    const pending = await harness.peer.readBootstrapStartState(ids);
    expect(pending).toEqual({
      settled: false,
      active: true,
      allocated: false,
      allocationTerminated: false,
      operationStartGate: 'open',
      bootstrapDeadlineAt: expect.any(String),
    });
    expect(await harness.peer.readBootstrapStartState({ ...ids, executionId: 'wrong-owner' })).toBeNull();
    await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({ ...pending, allocated: true });
    await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({
      ...pending,
      allocated: true,
      allocationTerminated: true,
    });
    await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({
      ...pending,
      allocated: true,
      allocationTerminated: true,
      settled: true,
      operationStartGate: 'closed',
    });
  });

  it('reports supersession without hiding the historical allocation or changing its deadline', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const previous = await harness.peer.readBootstrapStartState(ids);
    const replacement = { executionId: ids.executionId, executionAttemptId: nextIds().executionAttemptId };
    await harness.repository.createAttempt({
      ...replacement,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: 1,
    });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({
      ...previous,
      active: false,
      operationStartGate: 'closed',
    });
    expect(await harness.peer.readBootstrapStartState(replacement)).toMatchObject({
      active: true,
      allocated: false,
      operationStartGate: 'open',
    });
  });

  it.each([
    'pending',
    'allocated',
    'settled',
  ] as const)('keeps legacy %s attempts readable without extending bootstrap', async (status) => {
    const harness = getHarness();
    const ids = nextIds();
    if (status === 'pending') {
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
    } else {
      await allocateAttempt(harness.repository, ids);
    }
    if (status === 'settled') {
      await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
      });
    }
    await harness.clearStoredBootstrapDeadline(ids.executionAttemptId);
    expect(await harness.peer.readBootstrapStartState(ids)).toMatchObject({
      bootstrapDeadlineAt: null,
      settled: status === 'settled',
      allocated: status !== 'pending',
    });
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      bootstrapDeadlineAt: null,
      status,
    });
    expect(await harness.peer.getInstruction(ids)).toEqual(makeTestInstruction());
    if (status === 'allocated') {
      expect(
        (await harness.peer.recovery.getRecoverableAttempts(ids.executionId)).find(
          (attempt) => attempt.executionAttemptId === ids.executionAttemptId,
        ),
      ).toMatchObject({ bootstrapDeadlineAt: null });
    }
  });
}
