import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import {
  leaseAt,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestInstruction,
  makeTestWorkflowResult,
} from '../attempt-fixtures.js';
import { nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

type HarnessAccessor = () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>;

/**
 * Register terminal-transition precedence and preservation requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerTerminalCases(getHarness: HarnessAccessor): void {
  registerAbandonmentRefusalCases(getHarness);
  registerAbandonmentRaceCases(getHarness);
  registerInfrastructureOutcomeCases(getHarness);
  registerTerminationCases(getHarness);
  registerProcessLossCases(getHarness);
}

function registerAbandonmentRefusalCases(getHarness: HarnessAccessor): void {
  it('refuses abandonment after provisioning began without discarding its provider operation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operationBefore = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(before).toMatchObject({ status: 'provisioning', settlementKind: null, allocationRef: null });
    expect(operationBefore).toMatchObject({
      generation: claim.generation,
      ownerId: claim.ownerId,
      token: claim.token,
      leaseExpiresAt: claim.leaseExpiresAt,
      obligation: 'provisioning-resolution',
    });
    expect(await harness.repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId)).toEqual({
      kind: 'provisioning',
    });

    // A refusal is not merely an answer code: the provider operation remains
    // recoverable with precisely the state it had before the attempted abandon.
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toEqual(operationBefore);
  });

  it('refuses abandonment after allocation without discarding its provider operation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operationBefore = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(before).toMatchObject({ status: 'allocated', settlementKind: null, allocationRef });
    expect(operationBefore).toMatchObject({
      generation: claim.generation,
      ownerId: claim.ownerId,
      token: claim.token,
      leaseExpiresAt: claim.leaseExpiresAt,
      obligation: 'allocation-control',
    });
    expect(await harness.repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId)).toEqual({
      kind: 'allocated',
    });

    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toEqual(operationBefore);
  });

  it('refuses pre-allocation absence after allocation without discarding the allocation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operationBefore = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(
      await harness.peer.recordProvisioningAbsent({ claim, executionId: ids.executionId, evidence: makeEvidence() }),
    ).toEqual({ kind: 'allocated', allocationRef });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toEqual(operationBefore);
  });
}

function registerAbandonmentRaceCases(getHarness: HarnessAccessor): void {
  it('settles a pending abandonment race once and closes its start gate', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    expect(await harness.peer.abandonPendingAttempt(ids.executionAttemptId, `${ids.executionId}-foreign`)).toEqual({
      kind: 'fenced',
    });
    const untouched = await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId);
    expect(untouched).toMatchObject({ status: 'pending', operationStartGate: 'open' });
    expect(untouched?.settlementKind ?? null).toBeNull();

    const decisions = await Promise.all([
      harness.repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId),
      harness.peer.abandonPendingAttempt(ids.executionAttemptId, ids.executionId),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['abandoned', 'already-abandoned']);
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
      status: 'settled',
      settlementKind: 'abandoned',
      allocationRef: null,
    });
    expect(
      (await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.claimable ?? false,
    ).toBe(false);
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
  });
}

function registerInfrastructureOutcomeCases(getHarness: HarnessAccessor): void {
  it('preserves an infrastructure settlement when a worker outcome arrives late', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    const terminationEvidence = makeEvidence({ summary: 'provider confirmed termination before worker outcome' });
    await harness.repository.recordAllocation({ claim, allocationRef });
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: terminationEvidence })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.peer.recordInfrastructureFailure({ claim, executionId: ids.executionId })).toEqual({
      kind: 'recorded',
    });

    expect(
      await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
      }),
    ).toEqual({ kind: 'conflict' });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
      status: 'settled',
      settlementKind: 'infrastructure-failure',
      allocationRef,
    });
    expect(
      (await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.claimable ?? false,
    ).toBe(false);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ownerId: claim.ownerId,
      token: claim.token,
      leaseExpiresAt: claim.leaseExpiresAt,
      obligation: 'terminal-convergence',
      lastFailure: terminationEvidence,
      completionEvidence: null,
    });
  });
}

function registerTerminationCases(getHarness: HarnessAccessor): void {
  it('keeps a confirmed termination monotonic and distinguishes it from a missing allocation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });

    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      obligation: 'terminal-convergence',
      failureCount: 0,
    });
    expect(await harness.peer.recordProviderOperationUncertainty({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      obligation: 'terminal-convergence',
      failureCount: 1,
    });

    const unallocated = nextIds();
    const unallocatedClaim = await startAttempt(harness.repository, unallocated);
    expect(
      await harness.repository.recordAllocationTerminated({ claim: unallocatedClaim, evidence: makeEvidence() }),
    ).toEqual({ kind: 'not-allocated' });
    expect(await harness.repository.getProviderOperation(unallocated.executionAttemptId)).toMatchObject({
      obligation: 'provisioning-resolution',
    });
    const takeover = await harness.peer.takeOverProviderOperation({
      executionAttemptId: unallocated.executionAttemptId,
      ownerId: 'terminal-remediator',
      observedAt: leaseAt(120_000),
      leaseExpiresAt: leaseAt(180_000),
    });
    if (takeover.kind !== 'claimed') throw new Error(`Expected takeover, got '${takeover.kind}'`);
    expect(
      await harness.repository.recordAllocationTerminated({ claim: unallocatedClaim, evidence: makeEvidence() }),
    ).toEqual({ kind: 'stale' });
    expect(await harness.repository.getProviderOperation(unallocated.executionAttemptId)).toMatchObject({
      ownerId: 'terminal-remediator',
      obligation: 'provisioning-resolution',
    });
  });
}

function registerProcessLossCases(getHarness: HarnessAccessor): void {
  it('settles exactly once when matching process-loss proofs race', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId: 'provisioner-A',
    });
    const proof = makeProcessLossProof('provisioner-A');

    const decisions = await Promise.all([
      harness.repository.recordProvisionerIncarnationLost({ claim, executionId: ids.executionId, proof }),
      harness.peer.recordProvisionerIncarnationLost({ claim, executionId: ids.executionId, proof }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['recorded', 'resolved']);
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
      status: 'settled',
      settlementKind: 'abandoned',
      allocationRef: null,
    });
    expect(
      (await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.claimable ?? false,
    ).toBe(false);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ownerId: claim.ownerId,
      token: claim.token,
      leaseExpiresAt: claim.leaseExpiresAt,
      obligation: 'provisioning-resolution',
      completionEvidence: proof.evidence,
    });
  });
}
