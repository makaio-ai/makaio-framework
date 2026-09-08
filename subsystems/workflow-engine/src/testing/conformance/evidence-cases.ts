import { expect, it } from 'vitest';
import { RECOVERY_EVIDENCE_LIMITS, type WorkflowRunResult } from '@makaio/contracts';
import {
  TEST_PROVISIONER_INCARNATION_ID,
  leaseAt,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
} from '../attempt-fixtures.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';
import { nextIds, startAttempt } from './attempt-helpers.js';

/**
 * Register the evidence requirements of the repository port.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerEvidenceCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('completes pre-allocation debt only on proof naming the attempt own provisioner', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId: 'provisioner-A',
    });

    // Proof about some other process says nothing about this attempt, however
    // convincing it is about that process.
    const foreign = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof('provisioner-B'),
    });
    const stillOpen = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);

    const ownProof = makeProcessLossProof('provisioner-A');
    const own = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: ownProof,
    });
    const settled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const closed = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(foreign).toEqual({ kind: 'incarnation-mismatch', provisionerIncarnationId: 'provisioner-A' });
    expect(stillOpen?.settlementKind ?? null).toBeNull();
    expect(own).toEqual({ kind: 'recorded' });
    // No allocation was ever recorded, so the attempt ends `abandoned` rather
    // than as an infrastructure failure it could not have suffered.
    expect(settled?.status).toBe('settled');
    expect(settled?.settlementKind).toBe('abandoned');
    expect(settled?.allocationRef).toBeNull();
    expect(settled?.claimable ?? false).toBe(false);
    // The proof positively completes the operation. Completion retains the
    // authorizing claim as provenance; a cleared claim would instead mean a
    // handoff that another controller could take over.
    expect(closed?.ownerId).toBe(claim.ownerId);
    expect(closed?.token).toBe(claim.token);
    expect(closed?.leaseExpiresAt).toBe(claim.leaseExpiresAt);
    expect(closed?.completionEvidence).toEqual(ownProof.evidence);
    // Nothing was ever allocated, so the obligation never advances either.
    expect(closed?.obligation).toBe('provisioning-resolution');
  });

  it('refuses a loss proof for an attempt whose allocation outlives its provisioner', async () => {
    const harness = getHarness();
    const ids = nextIds();
    // The fixture default lifetime is `provider-managed`: such an allocation
    // survives the provisioning process, so losing that process proves nothing.
    const claim = await startAttempt(harness.repository, ids);

    const refusal = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof(TEST_PROVISIONER_INCARNATION_ID),
    });

    expect(refusal).toEqual({ kind: 'not-process-bound', allocationLifetime: 'provider-managed' });
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.settlementKind ?? null).toBeNull();
    expect(stored?.status).toBe('provisioning');
  });

  it('refuses a loss proof once the attempt owns an allocation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId: 'provisioner-A',
    });
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });

    const refusal = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof('provisioner-A'),
    });

    // A known allocation is converged by terminating it, not by closing the
    // attempt out from under the reference the operation still owns.
    expect(refusal).toEqual({ kind: 'allocated', allocationRef });
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.settlementKind ?? null).toBeNull();
    expect(stored?.allocationRef).toEqual(allocationRef);
  });

  it.each([
    'overlong summary',
    'forbidden credentials field',
  ])('rejects evidence with a %s before it consults ownership', async (malformation) => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // Fence the claim, so the ownership guard alone would answer `stale` for
    // every write below. Whichever guard runs first is therefore observable.
    const takeover = await harness.repository.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'parity-remediator',
      observedAt: leaseAt(3_600_000),
      leaseExpiresAt: leaseAt(7_200_000),
    });
    expect(takeover.kind).toBe('claimed');
    if (takeover.kind !== 'claimed') throw new Error('Expected takeover to fence the evidence writer');

    // Both bounded size and strict shape must be checked before claim ownership.
    const malformed =
      malformation === 'overlong summary'
        ? makeEvidence({ summary: 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary + 1) })
        : { ...makeEvidence(), credentials: 'synthetic-conformance-sentinel' };
    const { executionId } = ids;

    await expect(
      harness.repository.recordProvisioningAbsent({ claim, executionId, evidence: malformed }),
    ).rejects.toThrow();
    await expect(
      harness.repository.recordProviderOperationUncertainty({ claim, evidence: malformed }),
    ).rejects.toThrow();
    await expect(harness.repository.recordAllocationTerminated({ claim, evidence: malformed })).rejects.toThrow();
    await expect(harness.repository.handoffProviderOperation({ claim, evidence: malformed })).rejects.toThrow();
    await expect(
      harness.repository.recordProvisionerIncarnationLost({
        claim,
        executionId,
        proof: makeProcessLossProof(TEST_PROVISIONER_INCARNATION_ID, malformed),
      }),
    ).rejects.toThrow();

    // The same stale claim with contract-valid evidence is answered rather
    // than thrown, which is what makes the rejections above about the payload.
    expect(await harness.repository.recordProvisioningAbsent({ claim, executionId, evidence: makeEvidence() })).toEqual(
      {
        kind: 'stale',
      },
    );
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...takeover.claim,
      obligation: 'provisioning-resolution',
      failureCount: 0,
      lastFailure: null,
    });
    const untouched = await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(untouched).toMatchObject({ status: 'provisioning', allocationRef: null });
    expect(untouched?.settlementKind ?? null).toBeNull();
  });

  it('preserves an evidence timestamp verbatim while canonicalizing a future offset-form lease renewal', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // A provider in a different zone reports the instant it observed, in the
    // offset form the evidence contract accepts on purpose.
    const observedAt = '2026-07-27T12:00:00.000+02:00';
    // Renewal must extend the lease the repository actually issued, rather
    // than merely happen to be later than a fixture default. Spell that future
    // instant in the provider's offset form so canonicalization remains under
    // test rather than silently falling back to UTC input.
    const renewalInstant = new Date(Date.parse(claim.leaseExpiresAt) + 60_000);
    const leaseExpiresAt = new Date(renewalInstant.getTime() + 2 * 60 * 60 * 1_000)
      .toISOString()
      .replace('Z', '+02:00');
    const canonicalLeaseExpiresAt = renewalInstant.toISOString();

    await harness.repository.recordProviderOperationUncertainty({ claim, evidence: makeEvidence({ observedAt }) });
    const renewal = await harness.repository.renewProviderOperationClaim({ claim, leaseExpiresAt });
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    // Evidence is a public contract value its producer authored: the port
    // retains and reports it, and never orders by it, so rewriting the field
    // would change what the provider said for no benefit.
    expect(operation?.lastFailure?.observedAt).toBe(observedAt);
    // A lease deadline is the opposite: the port compares it, so it is stored
    // as the canonical instant regardless of how the caller spelled it.
    expect(operation?.leaseExpiresAt).toBe(canonicalLeaseExpiresAt);
    expect(renewal.kind === 'claimed' ? renewal.claim.leaseExpiresAt : null).toBe(canonicalLeaseExpiresAt);
  });
}
