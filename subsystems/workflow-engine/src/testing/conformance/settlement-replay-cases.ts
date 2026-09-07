import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeEvidence, makeTestAllocationRef, makeTestWorkflowResult } from '../attempt-fixtures.js';
import { nextIds, startAttempt } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register settlement preservation requirements for attempts that retain allocations.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerSettlementReplayCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('preserves an allocated outcome settlement through abandonment replays', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    expect(await harness.repository.recordAllocation({ claim, allocationRef })).toEqual({ kind: 'recorded' });
    await expectLiveAllocation(harness, ids.executionAttemptId, allocationRef);
    const outcome = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));

    const accepted = await harness.repository.commitOutcome({ ...ids, result: outcome });
    if (accepted.kind !== 'accepted') throw new Error(`Expected outcome acceptance, got '${accepted.kind}'`);
    expect(accepted).toEqual({ kind: 'accepted', outcome: outcome.outcome, text: outcome.text });
    await assertSettlementUnchanged(harness, ids, allocationRef, 'outcome', async () => {
      expect(await harness.peer.commitOutcome({ ...ids, result: outcome })).toEqual({
        kind: 'duplicate',
        outcome: accepted.outcome,
        text: accepted.text,
      });
    });
  });

  it('preserves an allocated infrastructure settlement through abandonment replays', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    expect(await harness.repository.recordAllocation({ claim, allocationRef })).toEqual({ kind: 'recorded' });
    await expectLiveAllocation(harness, ids.executionAttemptId, allocationRef);
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.peer.recordInfrastructureFailure({ claim, executionId: ids.executionId })).toEqual({
      kind: 'recorded',
    });

    await assertSettlementUnchanged(harness, ids, allocationRef, 'infrastructure-failure');
  });
}

async function expectLiveAllocation(
  harness: ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
  executionAttemptId: string,
  allocationRef: ReturnType<typeof makeTestAllocationRef>,
): Promise<void> {
  expect(await harness.repository.recovery.getAttemptWithAllocation(executionAttemptId)).toMatchObject({
    status: 'allocated',
    settlementKind: null,
    allocationRef,
  });
}

async function assertSettlementUnchanged(
  harness: ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  allocationRef: ReturnType<typeof makeTestAllocationRef>,
  settlementKind: 'outcome' | 'infrastructure-failure',
  verify?: () => Promise<void>,
): Promise<void> {
  const settled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
  if (settled === null) throw new Error('Expected a settled attempt');
  expect(settled).toMatchObject({ status: 'settled', settlementKind, allocationRef });
  const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);
  if (operation === null) throw new Error('Expected a settled provider operation');
  const attemptSnapshot = structuredClone(settled);
  const operationSnapshot = structuredClone(operation);

  for (const repository of [harness.repository, harness.peer]) {
    expect(await repository.recovery.getRecoverableAttempts(ids.executionId)).toEqual([]);
  }
  for (const repository of [harness.repository, harness.peer]) {
    expect(await repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId)).toEqual({
      kind: 'already-settled',
    });
    expect(await repository.recovery.getRecoverableAttempts(ids.executionId)).toEqual([]);
  }
  await verify?.();

  for (const repository of [harness.repository, harness.peer]) {
    expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(attemptSnapshot);
    expect(await repository.getProviderOperation(ids.executionAttemptId)).toEqual(operationSnapshot);
  }
}
