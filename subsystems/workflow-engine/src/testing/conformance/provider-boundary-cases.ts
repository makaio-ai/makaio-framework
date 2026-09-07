import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import {
  makeBeginProvisioningInput,
  makeEvidence,
  leaseAt,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestInstruction,
} from '../attempt-fixtures.js';
import { allocateAttempt, nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register provider authorization and owner-identity boundary requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerProviderBoundaryCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  registerBeginProvisioningRefusals(getHarness);
  registerForeignOwnerMutationRefusals(getHarness);
  registerUncertaintyAndUnknownTakeoverCases(getHarness);
}

/**
 * Register begin-provisioning refusals that must not authorize or mutate an attempt.
 * @param getHarness - Current suite realization.
 */
function registerBeginProvisioningRefusals(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('refuses begin provisioning for an allocated attempt without changing its authorization', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);
    const allocationRef = makeTestAllocationRef();

    expect(
      await harness.peer.beginProvisioning(makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId)),
    ).toEqual({ kind: 'allocated', allocationRef });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toEqual(operation);
    expect(await harness.repository.recordAllocation({ claim, allocationRef })).toEqual({
      kind: 'duplicate',
      allocationRef,
    });
  });

  it('refuses begin provisioning for a resolved attempt without changing its closed authorization', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    expect(
      await harness.repository.recordProvisioningAbsent({
        claim,
        executionId: ids.executionId,
        evidence: makeEvidence(),
      }),
    ).toEqual({ kind: 'recorded' });
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(
      await harness.peer.beginProvisioning(makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId)),
    ).toEqual({ kind: 'resolved', allocationRef: null });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toEqual(operation);
  });

  it('refuses begin provisioning for a superseded attempt without changing its authorization', async () => {
    const harness = getHarness();
    const first = nextIds();
    await startAttempt(harness.repository, first);
    await harness.peer.createAttempt({
      executionId: first.executionId,
      executionAttemptId: `${first.executionAttemptId}-replacement`,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const before = await harness.repository.recovery.getAttemptWithAllocation(first.executionAttemptId);
    const operation = await harness.repository.getProviderOperation(first.executionAttemptId);

    expect(
      await harness.peer.beginProvisioning(makeBeginProvisioningInput(first.executionAttemptId, first.executionId)),
    ).toEqual({ kind: 'fenced' });
    expect(await harness.repository.recovery.getAttemptWithAllocation(first.executionAttemptId)).toEqual(before);
    expect(await harness.peer.getProviderOperation(first.executionAttemptId)).toEqual(operation);
  });

  it('refuses begin provisioning for an unknown attempt without authorizing a provider operation', async () => {
    const harness = getHarness();
    const unknown = nextIds();

    expect(
      await harness.repository.beginProvisioning(
        makeBeginProvisioningInput(unknown.executionAttemptId, unknown.executionId),
      ),
    ).toEqual({ kind: 'not-found' });
    expect(await harness.peer.getProviderOperation(unknown.executionAttemptId)).toBeNull();
  });
}

/**
 * Register owner-identity checks for provider mutations that otherwise satisfy
 * their claim and state preconditions.
 * @param getHarness - Current suite realization.
 */
function registerForeignOwnerMutationRefusals(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('refuses provisioning absence for a different execution without changing durable state', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(
      await harness.peer.recordProvisioningAbsent({
        claim,
        executionId: `${ids.executionId}-foreign`,
        evidence: makeEvidence(),
      }),
    ).toEqual({ kind: 'not-found' });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toEqual(operation);
  });

  it('refuses provisioner loss for a different execution without changing durable state', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const provisionerIncarnationId = 'foreign-owner-process-loss';
    const claim = await startAttempt(harness.repository, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId,
    });
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(
      await harness.peer.recordProvisionerIncarnationLost({
        claim,
        executionId: `${ids.executionId}-foreign`,
        proof: makeProcessLossProof(provisionerIncarnationId),
      }),
    ).toEqual({ kind: 'not-found' });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toEqual(operation);
  });

  it('refuses infrastructure failure for a different execution without changing durable state', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(
      await harness.peer.recordInfrastructureFailure({ claim, executionId: `${ids.executionId}-foreign` }),
    ).toEqual({ kind: 'not-found' });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toEqual(operation);
  });

  it('refuses allocation reference evolution for a different execution without changing durable state', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const currentRef = makeTestAllocationRef();
    const nextRef = makeTestAllocationRef(currentRef.providerId, { runId: 1, jobId: 'foreign-owner-refinement' });
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(
      await harness.peer.recovery.evolveAllocationRef({
        claim,
        executionId: `${ids.executionId}-foreign`,
        currentRef,
        nextRef,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toEqual(operation);
  });
}

/**
 * Register provider-operation behavior at allocation-control and unknown-ID boundaries.
 * @param getHarness - Current suite realization.
 */
function registerUncertaintyAndUnknownTakeoverCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('retains allocation control and claim ownership when uncertainty is recorded before termination', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const before = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const evidence = makeEvidence({ summary: 'provider cannot yet confirm allocation termination' });

    expect(await harness.peer.recordProviderOperationUncertainty({ claim, evidence })).toEqual({ kind: 'recorded' });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toEqual(before);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...claim,
      obligation: 'allocation-control',
      failureCount: 1,
      lastFailure: evidence,
    });
  });

  it('refuses takeover of an unknown attempt without manufacturing an operation or attempt', async () => {
    const harness = getHarness();
    const unknown = nextIds();
    const input = {
      executionAttemptId: unknown.executionAttemptId,
      ownerId: 'unknown-takeover-controller',
      observedAt: leaseAt(0),
      leaseExpiresAt: leaseAt(60_000),
    };

    expect(await harness.peer.takeOverProviderOperation(input)).toEqual({ kind: 'not-found' });
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getProviderOperation(unknown.executionAttemptId)).toBeNull();
      expect(await repository.recovery.getAttemptWithAllocation(unknown.executionAttemptId)).toBeNull();
    }
  });
}
