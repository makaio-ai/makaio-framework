import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import {
  makeEvidence,
  makeTestAllocationRef,
  makeTestInstruction,
  makeTestWorkflowResult,
} from '../attempt-fixtures.js';
import { nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register cross-controller terminal compare-and-set requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerTerminalAtomicityCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('keeps one canonical winner when two distinct outcomes race across controllers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const first = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed'));
    const second = harness.peer.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'failed'));
    const decisions = await Promise.all([
      harness.repository.commitOutcome({ ...ids, result: first }),
      harness.peer.commitOutcome({ ...ids, result: second }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['accepted', 'conflict']);
    const winner = decisions[0]?.kind === 'accepted' ? first : second;
    expect(decisions.find((decision) => decision.kind === 'accepted')).toEqual({
      kind: 'accepted',
      outcome: winner.outcome,
      text: winner.text,
    });
    expect(await harness.peer.commitOutcome({ ...ids, result: winner })).toEqual({
      kind: 'duplicate',
      outcome: winner.outcome,
      text: winner.text,
    });
    expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      status: 'settled',
      settlementKind: 'outcome',
    });
  });

  it('keeps the actual winner stable when an outcome races confirmed infrastructure failure', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    const outcome = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    const [outcomeDecision, infrastructureDecision] = await Promise.all([
      harness.repository.commitOutcome({ ...ids, result: outcome }),
      harness.peer.recordInfrastructureFailure({ claim, executionId: ids.executionId }),
    ]);
    const primaryRead = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const peerRead = await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId);

    expect(peerRead).toEqual(primaryRead);
    if (outcomeDecision.kind === 'accepted') {
      expect(outcomeDecision).toEqual({ kind: 'accepted', outcome: outcome.outcome, text: outcome.text });
      expect(infrastructureDecision).toEqual({ kind: 'resolved' });
      expect(primaryRead).toMatchObject({ status: 'settled', settlementKind: 'outcome' });
      expect(await harness.peer.commitOutcome({ ...ids, result: outcome })).toEqual({
        kind: 'duplicate',
        outcome: outcome.outcome,
        text: outcome.text,
      });
      return;
    }

    expect(outcomeDecision).toEqual({ kind: 'conflict' });
    expect(infrastructureDecision).toEqual({ kind: 'recorded' });
    expect(primaryRead).toMatchObject({ status: 'settled', settlementKind: 'infrastructure-failure' });
    expect(await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId })).toEqual({
      kind: 'resolved',
    });
  });
}
