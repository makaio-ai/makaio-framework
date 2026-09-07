import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeEvidence, makeTestAllocationRef, TEST_PROVIDER_ID } from '../attempt-fixtures.js';
import { nextIds, startAttempt } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register cross-controller provider-operation atomicity requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerProviderAtomicityCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('grants an expired provider operation to exactly one of two competing controllers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const evidence = makeEvidence({ summary: 'provider lookup is still inconclusive' });
    expect(await harness.repository.recordProviderOperationUncertainty({ claim, evidence })).toEqual({
      kind: 'recorded',
    });
    const observedAt = new Date(Date.parse(claim.leaseExpiresAt) + 1).toISOString();
    const leaseExpiresAt = new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString();
    const primary = {
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'provider-atomicity-primary',
      observedAt,
      leaseExpiresAt,
    };
    const peer = { ...primary, ownerId: 'provider-atomicity-peer' };
    const decisions = await Promise.all([
      harness.repository.takeOverProviderOperation(primary),
      harness.peer.takeOverProviderOperation(peer),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['claimed', 'stale']);
    const winner = decisions.find((decision) => decision.kind === 'claimed');
    if (!winner || winner.kind !== 'claimed') throw new Error('Expected one takeover claim');
    expect(winner.claim).toMatchObject({
      executionAttemptId: ids.executionAttemptId,
      generation: claim.generation + 1,
      leaseExpiresAt,
    });
    expect(winner.claim.ownerId).toBe(decisions[0]?.kind === 'claimed' ? primary.ownerId : peer.ownerId);
    expect(winner.claim.token).not.toBe(claim.token);
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
        ...winner.claim,
        obligation: 'provisioning-resolution',
        failureCount: 1,
        lastFailure: evidence,
      });
    }
  });

  it('retains one actual discovered allocation when distinct same-provider discoveries race', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const primary = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'discovery-race-primary' });
    const peer = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'discovery-race-peer' });
    const decisions = await Promise.all([
      harness.repository.recovery.recordDiscoveredAllocation({ claim, allocationRef: primary }),
      harness.peer.recovery.recordDiscoveredAllocation({ claim, allocationRef: peer }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['conflict', 'recorded']);
    const winner = decisions[0]?.kind === 'recorded' ? primary : peer;
    expect(decisions.find((decision) => decision.kind === 'conflict')).toEqual({
      kind: 'conflict',
      allocationRef: winner,
    });
    const primaryRead = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const peerRead = await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(peerRead).toEqual(primaryRead);
    expect(primaryRead).toMatchObject({ status: 'allocated', allocationRef: winner });
    expect(primaryRead?.claimable ?? false).toBe(false);
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
        obligation: 'allocation-control',
      });
    }
  });
}
