import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import {
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestInstruction,
  makeTestWorkflowResult,
  TEST_PROVIDER_ID,
} from '../attempt-fixtures.js';
import { allocateAttempt, nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register successful provider-recovery transitions and their ownership effects.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerRecoveryCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('remediates a superseded attempt to settlement without reviving it', async () => {
    const harness = getHarness();
    const first = nextIds();
    const claim = await startAttempt(harness.repository, first);
    const replacement = {
      executionId: first.executionId,
      executionAttemptId: `${first.executionAttemptId}-replacement`,
    };
    await harness.peer.createAttempt({
      ...replacement,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const allocationRef = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'superseded-remediation' });

    expect(await harness.peer.recovery.recordDiscoveredAllocation({ claim, allocationRef })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.peer.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.peer.recordInfrastructureFailure({ claim, executionId: first.executionId })).toEqual({
      kind: 'recorded',
    });

    const settled = await harness.repository.recovery.getAttemptWithAllocation(first.executionAttemptId);
    expect(settled).toMatchObject({
      status: 'settled',
      settlementKind: 'infrastructure-failure',
      allocationRef,
    });
    expect(settled?.claimable ?? false).toBe(false);
    expect(await harness.repository.getActiveAttempt(first.executionId, first.executionAttemptId)).toBeNull();
    expect(
      await harness.repository.getActiveAttempt(replacement.executionId, replacement.executionAttemptId),
    ).toMatchObject({
      executionAttemptId: replacement.executionAttemptId,
    });
    expect(
      await harness.repository.commitOutcome({
        ...first,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(first.executionId)),
      }),
    ).toEqual({ kind: 'fenced' });
  });

  it.each([
    'active',
    'superseded',
  ] as const)('records a discovered allocation without making the %s attempt bootstrap-claimable', async (activeState) => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const replacement = { executionId: ids.executionId, executionAttemptId: `${ids.executionAttemptId}-retry` };
    if (activeState === 'superseded') {
      await harness.peer.createAttempt({
        ...replacement,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
    }
    const allocationRef = makeTestAllocationRef();

    expect(await harness.peer.recovery.recordDiscoveredAllocation({ claim, allocationRef })).toEqual({
      kind: 'recorded',
    });
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored).toMatchObject({ status: 'allocated', allocationRef });
    expect(stored?.claimable ?? false).toBe(false);
    expect((await harness.repository.getProviderOperation(ids.executionAttemptId))?.obligation).toBe(
      'allocation-control',
    );
    expect(await harness.repository.recovery.recordDiscoveredAllocation({ claim, allocationRef })).toEqual({
      kind: 'duplicate',
      allocationRef,
    });

    if (activeState === 'superseded') {
      expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toBeNull();
      expect(await harness.repository.getActiveAttempt(ids.executionId, replacement.executionAttemptId)).toMatchObject({
        executionAttemptId: replacement.executionAttemptId,
      });
    } else {
      expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
        executionAttemptId: ids.executionAttemptId,
      });
    }
  });

  it('rejects a different same-provider discovered allocation reference without replacing the original', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const original = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'discovered-original' });
    const conflicting = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'discovered-conflict' });

    expect(await harness.repository.recovery.recordDiscoveredAllocation({ claim, allocationRef: original })).toEqual({
      kind: 'recorded',
    });
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);
    expect(await harness.peer.recovery.recordDiscoveredAllocation({ claim, allocationRef: conflicting })).toEqual({
      kind: 'conflict',
      allocationRef: original,
    });
    expect(await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
      allocationRef: original,
    });
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toEqual(operation);
  });

  it('settles proven provisioning absence and closes ownership without allocation debt', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const evidence = makeEvidence({ summary: 'provider proved no allocation exists' });

    expect(await harness.peer.recordProvisioningAbsent({ claim, executionId: ids.executionId, evidence })).toEqual({
      kind: 'recorded',
    });
    const settled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(settled).toMatchObject({ status: 'settled', settlementKind: 'abandoned', allocationRef: null });
    expect(settled?.claimable ?? false).toBe(false);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ownerId: null,
      token: null,
      leaseExpiresAt: null,
      obligation: 'provisioning-resolution',
      lastFailure: evidence,
    });

    // Closed debt cannot be reclaimed, even after the former lease expires.
    expect(
      await harness.peer.takeOverProviderOperation({
        executionAttemptId: ids.executionAttemptId,
        ownerId: 'absence-remediator',
        observedAt: claim.leaseExpiresAt,
        leaseExpiresAt: new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString(),
      }),
    ).toEqual({ kind: 'resolved' });
  });

  it('keeps allocation and proven absence mutually exclusive when they race across controllers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'absence-race' });
    const [allocation, absence] = await Promise.all([
      harness.repository.recordAllocation({ claim, allocationRef }),
      harness.peer.recordProvisioningAbsent({ claim, executionId: ids.executionId, evidence: makeEvidence() }),
    ]);
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);

    if (stored?.status === 'allocated') {
      expect(allocation).toEqual({ kind: 'recorded' });
      expect(absence).toEqual({ kind: 'allocated', allocationRef });
      expect(stored).toMatchObject({ settlementKind: null, allocationRef });
      return;
    }

    expect(stored).toMatchObject({ status: 'settled', settlementKind: 'abandoned', allocationRef: null });
    expect(absence).toEqual({ kind: 'recorded' });
    expect(allocation).toEqual({ kind: 'resolved', allocationRef: null });
    // A late provider reply cannot resurrect an attempt whose absence closed.
    expect(await harness.repository.recordAllocation({ claim, allocationRef })).toEqual({
      kind: 'resolved',
      allocationRef: null,
    });
    expect((await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.allocationRef).toBeNull();
  });

  it('keeps allocation and own process-loss proof mutually exclusive when they race across controllers', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const provisionerIncarnationId = 'process-loss-race-provisioner';
    const claim = await startAttempt(harness.repository, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId,
    });
    const allocationRef = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'process-loss-race' });
    const [allocation, loss] = await Promise.all([
      harness.repository.recordAllocation({ claim, allocationRef }),
      harness.peer.recordProvisionerIncarnationLost({
        claim,
        executionId: ids.executionId,
        proof: makeProcessLossProof(provisionerIncarnationId),
      }),
    ]);
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);

    if (stored?.status === 'allocated') {
      expect(allocation).toEqual({ kind: 'recorded' });
      expect(loss).toEqual({ kind: 'allocated', allocationRef });
      expect(stored).toMatchObject({ settlementKind: null, allocationRef });
      return;
    }

    expect(stored).toMatchObject({ status: 'settled', settlementKind: 'abandoned', allocationRef: null });
    expect(loss).toEqual({ kind: 'recorded' });
    expect(allocation).toEqual({ kind: 'resolved', allocationRef: null });
    // The same claim remains closed after a late allocation report.
    expect(await harness.repository.recordAllocation({ claim, allocationRef })).toEqual({
      kind: 'resolved',
      allocationRef: null,
    });
    expect((await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.allocationRef).toBeNull();
  });

  it('hands off unresolved allocation ownership and immediately fences the released claim', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const evidence = makeEvidence({ summary: 'controller released allocation recovery' });

    expect(await harness.repository.handoffProviderOperation({ claim, evidence })).toEqual({ kind: 'recorded' });
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      generation: claim.generation,
      obligation: 'allocation-control',
      ownerId: null,
      token: null,
      leaseExpiresAt: null,
      failureCount: 0,
      lastFailure: evidence,
    });
    // Test fencing before takeover: clearing ownership alone invalidates the token.
    expect(await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'stale',
    });

    const takeover = await harness.peer.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'handoff-remediator',
      observedAt: new Date(Date.parse(claim.leaseExpiresAt) - 1).toISOString(),
      leaseExpiresAt: new Date(Date.parse(claim.leaseExpiresAt) + 60_000).toISOString(),
    });
    expect(takeover.kind).toBe('claimed');
    if (takeover.kind !== 'claimed') throw new Error('Expected immediate takeover after handoff');
    expect(takeover.claim.generation).toBe(claim.generation + 1);
    expect(takeover.claim.token).not.toBe(claim.token);
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      generation: takeover.claim.generation,
      ownerId: 'handoff-remediator',
      token: takeover.claim.token,
      leaseExpiresAt: takeover.claim.leaseExpiresAt,
      obligation: 'allocation-control',
      failureCount: 0,
      lastFailure: evidence,
    });
  });

  it('preserves prior uncertainty without counting evidence-free ownership handoff', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const evidence = makeEvidence({ summary: 'provider did not confirm allocation status' });

    expect(await harness.repository.recordProviderOperationUncertainty({ claim, evidence })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.repository.handoffProviderOperation({ claim })).toEqual({ kind: 'recorded' });
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      generation: claim.generation,
      obligation: 'allocation-control',
      ownerId: null,
      token: null,
      leaseExpiresAt: null,
      failureCount: 1,
      lastFailure: evidence,
    });
  });
}
