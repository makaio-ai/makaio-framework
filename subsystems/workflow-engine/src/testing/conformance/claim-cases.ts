import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import type { ExecutionAttemptRepository } from '../../execution-attempt-repository.js';
import type { ProviderOperationClaim } from '../../provider-operation.js';
import {
  makeBeginProvisioningInput,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestInstruction,
} from '../attempt-fixtures.js';
import { nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register durable provisioning authorization and provider-claim lease requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerClaimCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('authorizes provisioning once across racing controllers and subsequent retries', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const primaryInput = makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId, {
      ownerId: 'provisioning-controller-primary',
    });
    const peerInput = { ...primaryInput, ownerId: 'provisioning-controller-peer' };

    const decisions = await Promise.all([
      harness.repository.beginProvisioning(primaryInput),
      harness.peer.beginProvisioning(peerInput),
    ]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['already-provisioning', 'started']);
    const started = decisions.find((decision) => decision.kind === 'started');
    if (!started) throw new Error('Expected exactly one provisioning claim');
    const winningInput = decisions[0]?.kind === 'started' ? primaryInput : peerInput;
    expect(started.claim).toMatchObject({
      executionAttemptId: ids.executionAttemptId,
      generation: 1,
      ownerId: winningInput.ownerId,
      leaseExpiresAt: winningInput.leaseExpiresAt,
    });
    expect(started.claim.token).toEqual(expect.any(String));
    const expectedOperation = {
      ...started.claim,
      obligation: 'provisioning-resolution',
      failureCount: 0,
      lastFailure: null,
    };
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toMatchObject(expectedOperation);
      expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
        status: 'provisioning',
        allocationRef: null,
        providerId: winningInput.providerId,
        allocationLifetime: winningInput.allocationLifetime,
        provisionerIncarnationId: winningInput.provisionerIncarnationId,
      });
    }

    expect(await harness.repository.beginProvisioning(primaryInput)).toEqual({ kind: 'already-provisioning' });
    expect(await harness.peer.beginProvisioning(peerInput)).toEqual({ kind: 'already-provisioning' });
    expect(
      await harness.peer.beginProvisioning({
        ...peerInput,
        providerId: 'different-provider',
        allocationLifetime: 'provisioner-process-bound',
        provisionerIncarnationId: 'different-provisioner-incarnation',
      }),
    ).toEqual({ kind: 'already-provisioning' });
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toMatchObject(expectedOperation);
      expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
        providerId: winningInput.providerId,
        allocationLifetime: winningInput.allocationLifetime,
        provisionerIncarnationId: winningInput.provisionerIncarnationId,
      });
    }
  });

  it('refuses takeover before the held lease expires without fencing its owner', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const evidence = makeEvidence({ summary: 'allocation lookup remains inconclusive' });
    expect(await harness.repository.recordProviderOperationUncertainty({ claim, evidence })).toEqual({
      kind: 'recorded',
    });
    const expectedOperation = {
      ...claim,
      obligation: 'provisioning-resolution',
      failureCount: 1,
      lastFailure: evidence,
    };
    const contender = {
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'lease-takeover-controller',
      leaseExpiresAt: new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString(),
    };

    expect(
      await harness.peer.takeOverProviderOperation({
        ...contender,
        observedAt: new Date(Date.parse(claim.leaseExpiresAt) - 1).toISOString(),
      }),
    ).toEqual({ kind: 'stale' });
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toMatchObject(expectedOperation);
    }
    // A refused contender must not invalidate the holder's existing authorization.
    expect(await harness.repository.recordProviderOperationUncertainty({ claim, evidence })).toEqual({
      kind: 'recorded',
    });

    const takeover = await harness.peer.takeOverProviderOperation({
      ...contender,
      observedAt: new Date(Date.parse(claim.leaseExpiresAt) + 1).toISOString(),
    });
    expect(takeover.kind).toBe('claimed');
    if (takeover.kind !== 'claimed') throw new Error('Expected takeover after lease expiry');
    expect(takeover.claim.generation).toBe(claim.generation + 1);
    expect(takeover.claim.token).not.toBe(claim.token);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...takeover.claim,
      ownerId: contender.ownerId,
      leaseExpiresAt: contender.leaseExpiresAt,
      obligation: 'provisioning-resolution',
      failureCount: 2,
      lastFailure: evidence,
    });
    expect(await harness.repository.recordProviderOperationUncertainty({ claim, evidence })).toEqual({
      kind: 'stale',
    });
  });

  registerRenewalCase(getHarness);
  registerStaleClaimCases(getHarness);
}

/**
 * Register renewal without invalidating an existing holder's claim.
 * @param getHarness - Current suite realization.
 */
function registerRenewalCase(getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>): void {
  it('renews the lease without changing generation or fencing the original claim', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const leaseExpiresAt = new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString();

    const renewal = await harness.peer.renewProviderOperationClaim({ claim, leaseExpiresAt });
    expect(renewal.kind).toBe('claimed');
    if (renewal.kind !== 'claimed') throw new Error('Expected lease renewal');
    expect(renewal.claim).toEqual({ ...claim, leaseExpiresAt });
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...claim,
      leaseExpiresAt,
      obligation: 'provisioning-resolution',
    });
    for (const authorizedClaim of [claim, renewal.claim]) {
      expect(
        await harness.repository.recordProviderOperationUncertainty({
          claim: authorizedClaim,
          evidence: makeEvidence(),
        }),
      ).toEqual({ kind: 'recorded' });
    }
  });
}

/**
 * Register the ownership fence for every provider-operation mutation port.
 * @param getHarness - Current suite realization.
 */
function registerStaleClaimCases(getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>): void {
  const methods = [
    'recordProviderOperationUncertainty',
    'recordAllocation',
    'recordAllocationTerminated',
    'handoffProviderOperation',
    'recordProvisioningAbsent',
    'recordProvisionerIncarnationLost',
    'recordInfrastructureFailure',
    'renewProviderOperationClaim',
    'recordDiscoveredAllocation',
    'evolveAllocationRef',
  ] as const;

  it.each(methods)('refuses %s from a superseded claim without changing durable state', async (method) => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    const evolving = method === 'evolveAllocationRef';
    if (evolving) {
      expect(await harness.repository.recordAllocation({ claim, allocationRef })).toEqual({ kind: 'recorded' });
    }
    const takeover = await harness.peer.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'current-remediation-controller',
      observedAt: new Date(Date.parse(claim.leaseExpiresAt) + 1).toISOString(),
      leaseExpiresAt: new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString(),
    });
    expect(takeover.kind).toBe('claimed');
    if (takeover.kind !== 'claimed') throw new Error('Expected takeover to fence the old claim');
    const { executionId } = ids;
    const mutations = providerOperationMutations(
      harness.repository,
      claim,
      executionId,
      allocationRef,
      new Date(Date.parse(takeover.claim.leaseExpiresAt) + 60_000).toISOString(),
    );

    expect(await mutations[method]()).toMatchObject({ kind: 'stale' });
    const stored = await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored).toMatchObject({
      status: evolving ? 'allocated' : 'provisioning',
      allocationRef: evolving ? allocationRef : null,
    });
    expect(stored?.settlementKind ?? null).toBeNull();
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...takeover.claim,
      obligation: evolving ? 'allocation-control' : 'provisioning-resolution',
      failureCount: 0,
      lastFailure: null,
    });
  });

  it.each(methods)('returns not-found from %s for a valid claim naming no attempt', async (method) => {
    const harness = getHarness();
    const ids = nextIds();
    const claim: ProviderOperationClaim = {
      executionAttemptId: ids.executionAttemptId,
      generation: 1,
      ownerId: 'missing-operation-owner',
      token: '00000000-0000-4000-8000-000000000001',
      leaseExpiresAt: new Date().toISOString(),
    };
    const mutations = providerOperationMutations(
      harness.peer,
      claim,
      ids.executionId,
      makeTestAllocationRef(),
      new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString(),
    );

    expect(await mutations[method]()).toEqual({ kind: 'not-found' });
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toBeNull();
      expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toBeNull();
    }
  });
}

/**
 * Build every provider-operation mutation under one claim context.
 * @param repository - Repository receiving the mutation.
 * @param claim - Claim supplied to every mutation.
 * @param executionId - Owner identity required by owner-scoped mutations.
 * @param allocationRef - Allocation reference supplied to allocation mutations.
 * @param leaseExpiresAt - Renewal deadline supplied to the renewal mutation.
 * @returns Invocations keyed by their provider-operation mutation method.
 */
function providerOperationMutations(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  claim: ProviderOperationClaim,
  executionId: string,
  allocationRef: ReturnType<typeof makeTestAllocationRef>,
  leaseExpiresAt: string,
) {
  const evidence = makeEvidence();
  return {
    recordProviderOperationUncertainty: () => repository.recordProviderOperationUncertainty({ claim, evidence }),
    recordAllocation: () => repository.recordAllocation({ claim, allocationRef }),
    recordAllocationTerminated: () => repository.recordAllocationTerminated({ claim, evidence }),
    handoffProviderOperation: () => repository.handoffProviderOperation({ claim, evidence }),
    recordProvisioningAbsent: () => repository.recordProvisioningAbsent({ claim, executionId, evidence }),
    recordProvisionerIncarnationLost: () =>
      repository.recordProvisionerIncarnationLost({ claim, executionId, proof: makeProcessLossProof() }),
    recordInfrastructureFailure: () => repository.recordInfrastructureFailure({ claim, executionId }),
    renewProviderOperationClaim: () => repository.renewProviderOperationClaim({ claim, leaseExpiresAt }),
    recordDiscoveredAllocation: () => repository.recovery.recordDiscoveredAllocation({ claim, allocationRef }),
    evolveAllocationRef: () =>
      repository.recovery.evolveAllocationRef({
        claim,
        executionId,
        currentRef: allocationRef,
        nextRef: makeTestAllocationRef(allocationRef.providerId, { machineId: 'refined-allocation' }),
      }),
  };
}
