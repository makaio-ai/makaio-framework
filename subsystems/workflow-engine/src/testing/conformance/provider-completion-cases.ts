import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeEvidence, makeTestInstruction, makeTestWorkflowResult } from '../attempt-fixtures.js';
import { allocateAttempt, nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register durable provider-completion requirements.
 *
 * An attempt settlement closes admission and chooses the canonical workflow
 * result. It does not by itself prove that the provider-side allocation has
 * been released; that independent fact remains recoverable until both durable
 * settlement and positive provider-completion evidence are recorded.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerProviderCompletionCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('retains early provider completion evidence through takeover until later settlement closes the operation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const evidence = makeEvidence({ summary: 'provider confirmed allocation cleanup before owner settlement' });

    expect(await harness.repository.completeProviderOperation({ claim, evidence })).toEqual({
      kind: 'evidence-recorded',
    });
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...claim,
      completionEvidence: evidence,
    });

    // Evidence alone does not freeze the controller: the unsettled attempt
    // remains an open obligation and a replacement controller may take it
    // over after the old lease expires.
    const takeover = await harness.peer.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'early-proof-remediator',
      observedAt: new Date(Date.parse(claim.leaseExpiresAt) + 1).toISOString(),
      leaseExpiresAt: new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString(),
    });
    if (takeover.kind !== 'claimed') throw new Error(`Expected takeover, got '${takeover.kind}'`);
    expect(await harness.repository.completeProviderOperation({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'stale',
    });
    // The first proof is immutable even to the replacement controller.
    expect(await harness.peer.completeProviderOperation({ claim: takeover.claim, evidence: makeEvidence() })).toEqual({
      kind: 'evidence-recorded',
    });
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...takeover.claim,
      completionEvidence: evidence,
    });

    const openBeforeSettlement = await harness.repository.recovery.listOpenProviderOperations({
      observedAt: new Date(Date.parse(takeover.claim.leaseExpiresAt) + 1).toISOString(),
      limit: 10_000,
    });
    expect(openBeforeSettlement).toContainEqual({
      attempt: expect.objectContaining({ executionAttemptId: ids.executionAttemptId, settlementKind: null }),
      operation: expect.objectContaining({ completionEvidence: evidence }),
    });

    const outcome = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    expect(await harness.repository.commitOutcome({ ...ids, result: outcome })).toEqual({
      kind: 'accepted',
      outcome: outcome.outcome,
      text: outcome.text,
      controlObservation: { controlRevision: 0, cancellation: null },
    });
    // The legacy recovery selector remains about bootstrap-recoverable,
    // unsettled attempts. Settlement now joins the already durable provider
    // proof, so the separate provider obligation is closed as well.
    expect(await harness.peer.recovery.getRecoverableAttempts(ids.executionId)).toEqual([]);
    expect(await harness.peer.completeProviderOperation({ claim: takeover.claim, evidence })).toEqual({
      kind: 'already-completed',
    });
    expect(
      (
        await harness.repository.recovery.listOpenProviderOperations({
          observedAt: new Date(Date.parse(takeover.claim.leaseExpiresAt) + 1).toISOString(),
          limit: 10_000,
        })
      ).some(({ attempt }) => attempt.executionAttemptId === ids.executionAttemptId),
    ).toBe(false);
    expect(
      await harness.repository.takeOverProviderOperation({
        executionAttemptId: ids.executionAttemptId,
        ownerId: 'too-late-remediator',
        observedAt: new Date(Date.parse(takeover.claim.leaseExpiresAt) + 1).toISOString(),
        leaseExpiresAt: new Date(Date.parse(takeover.claim.leaseExpiresAt) + 60_000).toISOString(),
      }),
    ).toEqual({ kind: 'resolved' });
  });

  it('lists pre-allocation, settled, and superseded provider obligations independently of attempt activity', async () => {
    const harness = getHarness();
    const preAllocationIds = nextIds();
    const settledIds = nextIds();
    const supersededIds = nextIds();
    const preAllocationClaim = await startAttempt(harness.repository, preAllocationIds);
    const settledClaim = await allocateAttempt(harness.repository, settledIds);
    const supersededClaim = await startAttempt(harness.repository, supersededIds);

    const outcome = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(settledIds.executionId));
    expect(await harness.repository.commitOutcome({ ...settledIds, result: outcome })).toMatchObject({
      kind: 'accepted',
    });
    await harness.peer.createAttempt({
      executionId: supersededIds.executionId,
      executionAttemptId: `${supersededIds.executionAttemptId}-replacement`,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    const observedAt = new Date(
      Math.max(
        Date.parse(preAllocationClaim.leaseExpiresAt),
        Date.parse(settledClaim.leaseExpiresAt),
        Date.parse(supersededClaim.leaseExpiresAt),
      ) + 1,
    ).toISOString();
    const records = await harness.repository.recovery.listOpenProviderOperations({ observedAt, limit: 10_000 });
    const relevant = records.filter(({ attempt }) =>
      [preAllocationIds.executionAttemptId, settledIds.executionAttemptId, supersededIds.executionAttemptId].includes(
        attempt.executionAttemptId,
      ),
    );

    expect(relevant).toHaveLength(3);
    expect(relevant.map(({ attempt }) => attempt.executionAttemptId).sort()).toEqual(
      [preAllocationIds.executionAttemptId, settledIds.executionAttemptId, supersededIds.executionAttemptId].sort(),
    );
    expect(
      relevant.find(({ attempt }) => attempt.executionAttemptId === preAllocationIds.executionAttemptId)?.attempt,
    ).toMatchObject({
      status: 'provisioning',
      settlementKind: null,
    });
    expect(
      relevant.find(({ attempt }) => attempt.executionAttemptId === settledIds.executionAttemptId)?.attempt,
    ).toMatchObject({
      status: 'settled',
      settlementKind: 'outcome',
    });
    expect(
      relevant.find(({ attempt }) => attempt.executionAttemptId === supersededIds.executionAttemptId)?.attempt,
    ).toMatchObject({
      status: 'provisioning',
      operationStartGate: 'closed',
    });
  });

  it('filters live leases before applying the bound and rejects invalid operation-query bounds', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const observedAt = new Date(Date.parse(claim.leaseExpiresAt) - 1).toISOString();
    const full = await harness.repository.recovery.listOpenProviderOperations({ observedAt, limit: 10_000 });

    expect(full.some(({ attempt }) => attempt.executionAttemptId === ids.executionAttemptId)).toBe(false);
    expect(await harness.peer.recovery.listOpenProviderOperations({ observedAt, limit: 1 })).toEqual(full.slice(0, 1));
    for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(harness.repository.recovery.listOpenProviderOperations({ observedAt, limit })).rejects.toThrow(
        RangeError,
      );
    }
  });

  it('orders open provider operations by binary attempt identifier when creation instants tie', async () => {
    const harness = getHarness();
    const { executionId } = nextIds();
    const createdAt = '2026-01-02T00:00:00.000Z';
    const expected = [`${executionId}-!`, `${executionId}-A`, `${executionId}-a`, `${executionId}_a`];
    await harness.seedRecoverableAttempts({
      executionId,
      entries: [
        { executionAttemptId: expected[3], createdAt },
        { executionAttemptId: expected[2], createdAt },
        { executionAttemptId: expected[0], createdAt },
        { executionAttemptId: expected[1], createdAt },
      ],
    });

    for (const repository of [harness.repository, harness.peer]) {
      const records = await repository.recovery.listOpenProviderOperations({
        observedAt: '2099-01-01T00:00:00.000Z',
        limit: 10_000,
      });
      expect(
        records
          .filter(({ attempt }) => attempt.executionId === executionId)
          .map(({ attempt }) => attempt.executionAttemptId),
      ).toEqual(expected);
    }
  });

  it('fences an expired settled-operation claim before allowing its new owner to complete it', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const outcome = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    expect(await harness.repository.commitOutcome({ ...ids, result: outcome })).toMatchObject({ kind: 'accepted' });
    const takeover = await harness.peer.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'provider-completion-remediator',
      observedAt: new Date(Date.parse(claim.leaseExpiresAt) + 1).toISOString(),
      leaseExpiresAt: new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString(),
    });
    if (takeover.kind !== 'claimed') throw new Error(`Expected takeover, got '${takeover.kind}'`);

    expect(await harness.repository.completeProviderOperation({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'stale',
    });
    const evidence = makeEvidence({ summary: 'replacement controller completed provider cleanup' });
    expect(await harness.peer.completeProviderOperation({ claim: takeover.claim, evidence })).toEqual({
      kind: 'completed',
    });
    expect(await harness.peer.completeProviderOperation({ claim: takeover.claim, evidence })).toEqual({
      kind: 'already-completed',
    });
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      generation: takeover.claim.generation,
      ownerId: takeover.claim.ownerId,
      token: takeover.claim.token,
      completionEvidence: evidence,
    });
  });

  it('does not let terminal infrastructure evidence overwrite an outcome or complete provider work', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    const outcome = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    const [outcomeDecision, infrastructureDecision] = await Promise.all([
      harness.repository.commitOutcome({ ...ids, result: outcome }),
      harness.peer.recordInfrastructureFailure({ claim, executionId: ids.executionId }),
    ]);

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    if (outcomeDecision.kind === 'accepted') {
      expect(infrastructureDecision).toEqual({ kind: 'resolved' });
      expect(stored).toMatchObject({ settlementKind: 'outcome' });
      expect(await harness.peer.commitOutcome({ ...ids, result: outcome })).toEqual({
        kind: 'duplicate',
        outcome: outcome.outcome,
        text: outcome.text,
        controlObservation: { controlRevision: 0, cancellation: null },
      });
    } else {
      expect(outcomeDecision).toEqual({ kind: 'conflict' });
      expect(infrastructureDecision).toEqual({ kind: 'recorded' });
      expect(stored).toMatchObject({ settlementKind: 'infrastructure-failure' });
    }

    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({ completionEvidence: null });
  });

  it('keeps terminal evidence and handoff distinct from provider completion', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.repository.handoffProviderOperation({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });

    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      obligation: 'terminal-convergence',
      ownerId: null,
      token: null,
      leaseExpiresAt: null,
      completionEvidence: null,
    });
    expect(
      (
        await harness.repository.recovery.listOpenProviderOperations({
          observedAt: new Date().toISOString(),
          limit: 10_000,
        })
      ).some(({ attempt }) => attempt.executionAttemptId === ids.executionAttemptId),
    ).toBe(true);
  });
}
