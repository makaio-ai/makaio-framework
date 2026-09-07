import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { DuplicateExecutionAttemptError } from '../../execution-attempt-repository.js';
import {
  makeTestInstruction,
  TEST_PROVIDER_ID,
  leaseAt,
  makeEvidence,
  makeTestAllocationRef,
} from '../attempt-fixtures.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';
import { nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';

/**
 * Register the allocation requirements of the repository port.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerAllocationCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  registerConcurrentCreationCase(getHarness);

  it('rejects a reused attempt identifier without touching the existing attempt', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });
    await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });

    // The port names the error, so a caller can tell a reused identifier from
    // a storage fault without matching on whichever text its store produced.
    await expect(
      harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
    ).rejects.toThrow(DuplicateExecutionAttemptError);
    await expect(
      harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
    ).rejects.toMatchObject({
      executionAttemptId: ids.executionAttemptId,
    });

    // Everything a fresh `pending` record would have discarded is still here.
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.status).toBe('settled');
    expect(stored?.settlementKind).toBe('infrastructure-failure');
    expect(stored?.allocationRef).toEqual(allocationRef);
    expect(stored?.providerId).toBe(TEST_PROVIDER_ID);
  });

  it('fences only the allocated attempt superseded for its execution', async () => {
    const harness = getHarness();
    const first = nextIds();
    const firstClaim = await startAttempt(harness.repository, first);
    await harness.repository.recordAllocation({ claim: firstClaim, allocationRef: makeTestAllocationRef() });
    const unrelated = nextIds();
    const unrelatedClaim = await startAttempt(harness.repository, unrelated);
    await harness.repository.recordAllocation({ claim: unrelatedClaim, allocationRef: makeTestAllocationRef() });

    const replacement = { executionId: first.executionId, executionAttemptId: `${first.executionAttemptId}-next` };
    await harness.repository.createAttempt({
      ...replacement,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    expect(await harness.repository.recovery.getAttemptWithAllocation(first.executionAttemptId)).toMatchObject({
      status: 'allocated',
      claimable: false,
    });
    expect(await harness.repository.recovery.getAttemptWithAllocation(unrelated.executionAttemptId)).toMatchObject({
      status: 'allocated',
      claimable: true,
    });
  });

  it('compares allocation references by value, not by member order', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // `providerData` is opaque provider-owned data, so its member order is an
    // artifact of however the provider built it — and of whether the store
    // round-tripped it. Neither may decide a durable outcome.
    await harness.repository.recordAllocation({
      claim,
      allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'parity-order', region: 'ord' }),
    });
    const reordered = makeTestAllocationRef(TEST_PROVIDER_ID, { region: 'ord', machineId: 'parity-order' });

    // A replay carrying the same members in another order is a replay.
    expect(await harness.repository.recordAllocation({ claim, allocationRef: reordered })).toMatchObject({
      kind: 'duplicate',
    });
    // And the same reordering is still a current view for the CAS, so
    // correlation is not rejected for a difference that is not one.
    expect(
      await harness.repository.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: reordered,
        nextRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'parity-order', region: 'ord', jobId: 7 }),
      }),
    ).toEqual({ kind: 'evolved' });

    // A genuinely different member value is still a conflict, so the
    // comparison did not become blind to content.
    expect(
      await harness.repository.recordAllocation({
        claim,
        allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'somewhere-else' }),
      }),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('keeps only the newest active allocation recoverable for an execution', async () => {
    const harness = getHarness();
    const executionId = `${nextIds().executionId}-recovery-order`;
    const created: string[] = [];
    for (const suffix of ['c', 'b', 'a']) {
      const executionAttemptId = `${executionId}-${suffix}`;
      const claim = await startAttempt(harness.repository, { executionId, executionAttemptId });
      await harness.repository.recordAllocation({
        claim,
        allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: suffix }),
      });
      created.push(executionAttemptId);
    }

    const recoverable = await harness.repository.recovery.getRecoverableAttempts(executionId);

    expect(recoverable.map((attempt) => attempt.executionAttemptId)).toEqual([created.at(-1)]);
  });

  it('refuses an evolution whose references name different providers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const currentRef = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'parity-1' });
    await harness.repository.recordAllocation({ claim, allocationRef: currentRef });

    // Rejection and unchanged state are portable requirements; adapter error wording is not.
    await expect(
      harness.repository.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef,
        nextRef: makeTestAllocationRef('a-different-provider', { machineId: 'parity-1' }),
      }),
    ).rejects.toThrow();

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.allocationRef).toEqual(currentRef);
  });

  it('retains unresolved provisioning when infrastructure failure has no allocation to settle', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);

    expect(await harness.peer.recordInfrastructureFailure({ claim, executionId: ids.executionId })).toEqual({
      kind: 'not-allocated',
    });
    const attempt = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(attempt).toMatchObject({ status: 'provisioning', allocationRef: null, operationStartGate: 'open' });
    expect(attempt?.settlementKind ?? null).toBeNull();
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...claim,
      obligation: 'provisioning-resolution',
      failureCount: 0,
      lastFailure: null,
    });
  });

  it('settles infrastructure only after termination is durably confirmed', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });

    // The claim is current and the attempt owns an allocation, so nothing but
    // the missing transition stands between this caller and a settlement.
    const premature = await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });
    const unsettled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const stillControlling = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(premature).toEqual({ kind: 'not-terminated' });
    expect(unsettled?.status).toBe('allocated');
    expect(unsettled?.settlementKind ?? null).toBeNull();
    expect(stillControlling?.obligation).toBe('allocation-control');

    // Recording the termination is what makes the very same call succeed, so
    // the refusal above was about the missing evidence and nothing else.
    const termination = await harness.repository.recordAllocationTerminated({
      claim,
      evidence: makeEvidence({ summary: 'provider reported the allocation terminated' }),
    });
    const settlement = await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });

    expect(termination).toEqual({ kind: 'recorded' });
    expect(settlement).toEqual({ kind: 'recorded' });
    const settled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(settled?.settlementKind).toBe('infrastructure-failure');
    // The evidence that authorized the settlement outlives it on the closed
    // operation, which is what a later reader has to be able to inspect.
    const closed = await harness.repository.getProviderOperation(ids.executionAttemptId);
    expect(closed?.obligation).toBe('terminal-convergence');
    expect(closed?.lastFailure?.summary).toBe('provider reported the allocation terminated');
  });

  it('refuses an allocation reference that names a provider other than the attempt own', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const foreignRef = makeTestAllocationRef('a-different-provider', { machineId: 'foreign-1' });

    await expect(harness.repository.recordAllocation({ claim, allocationRef: foreignRef })).rejects.toThrow();
    await expect(
      harness.repository.recovery.recordDiscoveredAllocation({ claim, allocationRef: foreignRef }),
    ).rejects.toThrow();

    // Neither call may leave the attempt pointing at infrastructure the bound
    // provider never created.
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.allocationRef).toBeNull();
    expect(stored?.status).toBe('provisioning');
    expect((await harness.repository.getProviderOperation(ids.executionAttemptId))?.obligation).toBe(
      'provisioning-resolution',
    );

    // The attempt's own provider is accepted through the same call, so the
    // rejection was about the binding rather than about the reference shape.
    expect(await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'recorded',
    });
  });

  it('refuses a foreign allocation reference even from a fenced claim', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // Fence the claim, so ownership alone would answer `stale`. A caller bug
    // must not become an outcome just because the caller also lost the race.
    const takeover = await harness.repository.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'parity-remediator',
      observedAt: leaseAt(3_600_000),
      leaseExpiresAt: leaseAt(7_200_000),
    });
    expect(takeover.kind).toBe('claimed');

    await expect(
      harness.repository.recordAllocation({
        claim,
        allocationRef: makeTestAllocationRef('a-different-provider', { machineId: 'foreign-2' }),
      }),
    ).rejects.toThrow();

    // The same fenced claim with a well-bound reference is answered rather
    // than thrown, which is what makes the rejection about the payload.
    expect(await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'stale',
    });
  });

  it('refuses an allocation reference the contract forbids, before any mutation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);

    await expect(
      // A blank provider identifier is exactly what the contract schema
      // exists to reject, and rejecting it on the way in is what keeps a
      // realization from storing it and only failing on some later read.
      harness.repository.recordAllocation({ claim, allocationRef: { ...makeTestAllocationRef(), providerId: '' } }),
    ).rejects.toThrow();

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.status).toBe('provisioning');
    expect(stored?.allocationRef).toBeNull();
  });

  it('never lets a caller mutate durable evidence after the call returned', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const providerData: Record<string, unknown> = { machineId: 'parity-owned' };
    await harness.repository.recordAllocation({
      claim,
      allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, providerData),
    });

    // The caller still holds its own object. Changing it must not be a way to
    // rewrite durable evidence with no claim and no repository transition.
    providerData.machineId = 'mutated-after-the-fact';

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.allocationRef?.providerData).toEqual({ machineId: 'parity-owned' });
  });
}

/**
 * Register concurrent creation without allowing a duplicate to overwrite the winner.
 * @param getHarness - Current suite realization.
 */
function registerConcurrentCreationCase(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('preserves exactly one instruction when two controllers create the same attempt identifier', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const primaryInstruction = makeTestInstruction({ id: 'primary-assignment' });
    const peerInstruction = makeTestInstruction({ id: 'peer-assignment' });
    const decisions = await Promise.allSettled([
      harness.repository.createAttempt({
        ...ids,
        instruction: primaryInstruction,
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
      harness.peer.createAttempt({
        ...ids,
        instruction: peerInstruction,
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
    ]);

    expect(decisions.map((decision) => decision.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = decisions.find((decision) => decision.status === 'rejected');
    if (!rejected) throw new Error('Expected the duplicate creation to reject');
    expect(rejected.reason).toBeInstanceOf(DuplicateExecutionAttemptError);
    expect(rejected.reason).toMatchObject({ executionAttemptId: ids.executionAttemptId });
    const winningInstruction = decisions[0]?.status === 'fulfilled' ? primaryInstruction : peerInstruction;
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getInstruction(ids)).toEqual(winningInstruction);
      expect(await repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
        ...ids,
        status: 'pending',
        instruction: winningInstruction,
        operationStartGate: 'open',
        runtimeGeneration: 0,
      });
      expect(await repository.getProviderOperation(ids.executionAttemptId)).toBeNull();
    }
  });
}
