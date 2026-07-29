import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECOVERY_EVIDENCE_LIMITS } from '@makaio/contracts';
import { createTempDb, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import type { BeginProvisioningInput, ExecutionAttemptRecord, ExecutionAttemptRepository } from '../index.js';
import { DuplicateExecutionAttemptError } from '../index.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import {
  TEST_PROVIDER_ID,
  TEST_PROVISIONER_INCARNATION_ID,
  createInMemoryAttemptRepository,
  leaseAt,
  makeBeginProvisioningInput,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestWorkflowResult,
  type ProvisioningClaimGrantor,
} from '../testing/index.js';
import type { ProviderOperationClaim } from '../provider-operation.js';

/**
 * One realization of the port under test, together with its teardown.
 *
 * The port is a specification, so a rule that only one realization obeys is a
 * rule the specification does not actually have. Everything in this suite is
 * asserted against every realization the package ships.
 */
interface RealizationHarness {
  /** Repository exposing the full port surface. */
  readonly repository: Required<ExecutionAttemptRepository>;
  /** Release whatever the realization holds open. */
  readonly dispose: () => void;
}

const REALIZATIONS: ReadonlyArray<readonly [string, () => Promise<RealizationHarness>]> = [
  [
    'in-memory',
    async () => ({
      repository: createInMemoryAttemptRepository(),
      dispose: () => {},
    }),
  ],
  [
    'sqlite',
    async () => {
      const context: TestDbContext = await createTempDb('execution-attempt-parity');
      return {
        repository: await createSqliteAttemptRepository(context.db),
        dispose: context.cleanup,
      };
    },
  ],
];

let sequence = 0;

/**
 * Allocate a fresh execution and attempt identifier pair.
 * @returns Unique execution and attempt identifiers.
 */
function nextIds(): { readonly executionId: string; readonly executionAttemptId: string } {
  sequence += 1;
  return { executionId: `parity-exec-${sequence}`, executionAttemptId: `parity-attempt-${sequence}` };
}

/**
 * Create an attempt and win its provisioning claim.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param overrides - Begin-provisioning fields to replace, such as the lifetime.
 * @returns The claim the winning begin issued.
 * @throws When provisioning does not start.
 */
async function startAttempt(
  repository: Required<ExecutionAttemptRepository>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  overrides: Partial<BeginProvisioningInput> = {},
): Promise<ProviderOperationClaim> {
  await repository.createAttempt(ids);
  const grantor: ProvisioningClaimGrantor = repository;
  const decision = await grantor.beginProvisioning(
    makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId, overrides),
  );
  if (decision.kind !== 'started') throw new Error(`Expected provisioning to start, got '${decision.kind}'`);
  return decision.claim;
}

describe.each(REALIZATIONS)('execution attempt port parity (%s)', (_realization, createHarness) => {
  let harness: RealizationHarness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(() => {
    harness.dispose();
  });

  it('rejects a reused attempt identifier without touching the existing attempt', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });
    await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });

    // The port names the error, so a caller can tell a reused identifier from
    // a storage fault without matching on whichever text its store produced.
    await expect(harness.repository.createAttempt(ids)).rejects.toThrow(DuplicateExecutionAttemptError);
    await expect(harness.repository.createAttempt(ids)).rejects.toMatchObject({
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
    const first = nextIds();
    const firstClaim = await startAttempt(harness.repository, first);
    await harness.repository.recordAllocation({ claim: firstClaim, allocationRef: makeTestAllocationRef() });
    const unrelated = nextIds();
    const unrelatedClaim = await startAttempt(harness.repository, unrelated);
    await harness.repository.recordAllocation({ claim: unrelatedClaim, allocationRef: makeTestAllocationRef() });

    const replacement = { executionId: first.executionId, executionAttemptId: `${first.executionAttemptId}-next` };
    await harness.repository.createAttempt(replacement);

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
    const executionId = `parity-recovery-order-${(sequence += 1)}`;
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
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const currentRef = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'parity-1' });
    await harness.repository.recordAllocation({ claim, allocationRef: currentRef });

    await expect(
      harness.repository.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef,
        nextRef: makeTestAllocationRef('a-different-provider', { machineId: 'parity-1' }),
      }),
    ).rejects.toThrow('must keep one provider');

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.allocationRef).toEqual(currentRef);
  });

  it('settles infrastructure only after termination is durably confirmed', async () => {
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
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const foreignRef = makeTestAllocationRef('a-different-provider', { machineId: 'foreign-1' });

    await expect(harness.repository.recordAllocation({ claim, allocationRef: foreignRef })).rejects.toThrow(
      'is bound to',
    );
    await expect(
      harness.repository.recovery.recordDiscoveredAllocation({ claim, allocationRef: foreignRef }),
    ).rejects.toThrow('is bound to');

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
    ).rejects.toThrow('is bound to');

    // The same fenced claim with a well-bound reference is answered rather
    // than thrown, which is what makes the rejection about the payload.
    expect(await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'stale',
    });
  });

  it('refuses an allocation reference the contract forbids, before any mutation', async () => {
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

  it('closes pre-allocation debt only on proof naming the attempt own provisioner', async () => {
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

    const own = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof('provisioner-A'),
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
    // Settling closes the operation in the same transaction, and the proof's
    // own evidence is what the closed record retains.
    expect(closed?.ownerId).toBeNull();
    expect(closed?.token).toBeNull();
    expect(closed?.lastFailure?.summary).toBe('supervisor observed the provisioner process exit');
    // Nothing was ever allocated, so the obligation never advances either.
    expect(closed?.obligation).toBe('provisioning-resolution');
  });

  it('refuses a loss proof for an attempt whose allocation outlives its provisioner', async () => {
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

  it('rejects malformed evidence before it consults ownership', async () => {
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

    // Over-long by the contract's own bound: a caller bug, not an outcome.
    const malformed = makeEvidence({ summary: 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary + 1) });
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
    const untouched = await harness.repository.getProviderOperation(ids.executionAttemptId);
    expect(untouched?.failureCount).toBe(0);
    expect(untouched?.lastFailure).toBeNull();
    expect(untouched?.ownerId).toBe('parity-remediator');
  });

  it('preserves an evidence timestamp verbatim while canonicalizing an ordered one', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // A provider in a different zone reports the instant it observed, in the
    // offset form the evidence contract accepts on purpose.
    const observedAt = '2026-07-27T12:00:00.000+02:00';
    const leaseExpiresAt = '2026-07-27T13:30:00+02:00';

    await harness.repository.recordProviderOperationUncertainty({ claim, evidence: makeEvidence({ observedAt }) });
    const renewal = await harness.repository.renewProviderOperationClaim({ claim, leaseExpiresAt });
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    // Evidence is a public contract value its producer authored: the port
    // retains and reports it, and never orders by it, so rewriting the field
    // would change what the provider said for no benefit.
    expect(operation?.lastFailure?.observedAt).toBe(observedAt);
    // A lease deadline is the opposite: the port compares it, so it is stored
    // as the canonical instant regardless of how the caller spelled it.
    expect(operation?.leaseExpiresAt).toBe('2026-07-27T11:30:00.000Z');
    expect(renewal.kind === 'claimed' ? renewal.claim.leaseExpiresAt : null).toBe('2026-07-27T11:30:00.000Z');
  });

  it('commits an outcome and reports the stored result, not the caller object', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt(ids);
    const result = makeTestWorkflowResult(ids.executionId);

    const accepted = await harness.repository.commitOutcome({ ...ids, result });

    expect(accepted).toEqual({ kind: 'accepted', outcome: result });
    const replay = await harness.repository.commitOutcome({ ...ids, result: makeTestWorkflowResult(ids.executionId) });
    expect(replay).toEqual({ kind: 'duplicate', outcome: result });
  });
});

// ─────────────────────────────────────────────────────────────
// Inconsistent durable state
//
// These states are only reachable by writing them directly, which the
// in-memory realization allows and a durable one does not. They pin down what
// the port owes when it meets them.
// ─────────────────────────────────────────────────────────────

describe('execution attempt port parity (inconsistent durable state)', () => {
  it('fences an outcome whose active attempt has no record behind it', async () => {
    const repository = createInMemoryAttemptRepository();
    repository.activeAttempts.set('ghost-exec', 'ghost-attempt');

    const decision = await repository.commitOutcome({
      executionId: 'ghost-exec',
      executionAttemptId: 'ghost-attempt',
      result: makeTestWorkflowResult('ghost-exec'),
    });

    // An accepted outcome obliges the caller to converge workflow state, so
    // it must never be the answer when no attempt exists to converge.
    expect(decision).toEqual({ kind: 'fenced' });
    expect(repository.committedOutcomes.size).toBe(0);
  });

  it('breaks a creation-instant tie by attempt identifier', async () => {
    const repository = createInMemoryAttemptRepository();
    // Two attempts created within one millisecond is reachable durably but not
    // reproducible through the port, so the tie is written directly here.
    const createdAt = new Date().toISOString();
    for (const executionAttemptId of ['tie-b', 'tie-a']) {
      repository.attempts.set(executionAttemptId, {
        executionAttemptId,
        executionId: 'tie-exec',
        status: 'allocated',
        allocationRef: makeTestAllocationRef(),
        createdAt,
        providerId: TEST_PROVIDER_ID,
        allocationLifetime: 'provider-managed',
        provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
        settlementKind: null,
        claimable: true,
        claimExpiresAt: null,
      });
    }

    const recoverable = await repository.recovery.getRecoverableAttempts('tie-exec');

    expect(recoverable.map((attempt) => attempt.executionAttemptId)).toEqual(['tie-a', 'tie-b']);
  });

  it('fails recovery on a selected attempt whose provider binding is incomplete', async () => {
    const repository = createInMemoryAttemptRepository();
    const inconsistent: ExecutionAttemptRecord = {
      executionAttemptId: 'partial-attempt',
      executionId: 'partial-exec',
      status: 'allocated',
      allocationRef: makeTestAllocationRef(),
      createdAt: new Date().toISOString(),
      providerId: null,
      allocationLifetime: null,
      provisionerIncarnationId: null,
      settlementKind: null,
      claimable: true,
      claimExpiresAt: null,
    };
    repository.attempts.set(inconsistent.executionAttemptId, inconsistent);

    // Dropping the row would hide an allocated attempt from recovery, and
    // nobody would ever reclaim the infrastructure it still owns.
    await expect(repository.recovery.getRecoverableAttempts('partial-exec')).rejects.toThrow(
      'selected as recoverable but is not',
    );
  });
});
