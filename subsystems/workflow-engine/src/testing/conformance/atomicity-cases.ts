import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { leaseAt, makeTestAllocationRef, makeTestWorkflowResult, TEST_PROVIDER_ID } from '../attempt-fixtures.js';
import { nextIds, preparationAttempt, startAttempt } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register compare-and-set and Preparation-report atomicity requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerAtomicityCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('accepts a worker outcome while a peer takes over the expired provider claim', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    const result = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));

    // Worker settlement has no provider claim. The two writes can reach the
    // durable boundary in either order, but the worker's canonical answer is
    // still accepted and settlement closes any ownership the takeover acquired.
    const [takeover, commit] = await Promise.all([
      harness.peer.takeOverProviderOperation({
        executionAttemptId: ids.executionAttemptId,
        ownerId: 'atomicity-remediator',
        observedAt: new Date(Date.parse(claim.leaseExpiresAt) + 1).toISOString(),
        leaseExpiresAt: leaseAt(120_000),
      }),
      harness.repository.commitOutcome({ ...ids, result }),
    ]);

    expect(['claimed', 'resolved']).toContain(takeover.kind);
    expect(commit).toEqual({ kind: 'accepted', outcome: result.outcome, text: result.text });
    expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      settlementKind: 'outcome',
    });
    expect(await harness.peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ownerId: null,
      token: null,
      leaseExpiresAt: null,
    });
  });

  it('returns the first evolved reference to a stale same-provider correlator without another mutation', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const initial = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'atomicity-stale' });
    const first = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'atomicity-stale', jobId: 'first' });
    await harness.repository.recordAllocation({ claim, allocationRef: initial });

    expect(
      await harness.repository.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: first,
      }),
    ).toEqual({ kind: 'evolved' });

    // A correlator that still sees `initial` cannot replace the first winner.
    // Its reply both exposes the durable winner and proves no second update ran.
    expect(
      await harness.peer.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'atomicity-stale', jobId: 'second' }),
      }),
    ).toEqual({ kind: 'stale', storedRef: first });
    expect((await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.allocationRef).toEqual(
      first,
    );
  });

  it('allows exactly one racing allocation-ref evolution and retains its actual winner', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const initial = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'atomicity-race' });
    const first = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'atomicity-race', jobId: 'first' });
    const second = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'atomicity-race', jobId: 'second' });
    await harness.repository.recordAllocation({ claim, allocationRef: initial });

    const decisions = await Promise.all([
      harness.repository.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: first,
      }),
      harness.peer.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: second,
      }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['evolved', 'stale']);
    const winner = decisions[0]?.kind === 'evolved' ? first : second;
    expect(decisions.find((decision) => decision.kind === 'stale')).toEqual({ kind: 'stale', storedRef: winner });
    expect((await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.allocationRef).toEqual(
      winner,
    );
  });

  it('records one receipt and releases the Preparation slot when matching reports race', async () => {
    const harness = getHarness();
    const report = await preparationAttempt(harness.repository);

    const decisions = await Promise.all([
      harness.repository.reportOperation(report),
      harness.peer.reportOperation(report),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['accepted', 'duplicate']);
    expect(decisions).toContainEqual({ kind: 'accepted', binding: report.result.binding });
    expect(decisions).toContainEqual({ kind: 'duplicate', binding: report.result.binding });
    const stored = await harness.repository.getActiveAttempt(report.executionId, report.executionAttemptId);
    expect(stored?.preparationReceipts).toEqual([
      { operationId: report.operationId, runtimeGeneration: report.runtimeGeneration, result: report.result },
    ]);
    expect(stored?.activeOperationId).toBeNull();
    expect(stored?.lastCompletedOperationId).toBe(report.operationId);
  });

  it('preserves the actual Preparation winner and releases its slot when reports conflict', async () => {
    const harness = getHarness();
    const first = await preparationAttempt(harness.repository);
    const second = {
      ...first,
      result: {
        ...first.result,
        binding: { workspaceRoot: '/scratch/atomicity-second', sourceRoots: [] },
      },
    };

    const decisions = await Promise.all([
      harness.repository.reportOperation(first),
      harness.peer.reportOperation(second),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['accepted', 'conflict']);
    const winner = decisions[0]?.kind === 'accepted' ? first : second;
    expect(decisions.find((decision) => decision.kind === 'accepted')).toEqual({
      kind: 'accepted',
      binding: winner.result.binding,
    });
    const stored = await harness.peer.getActiveAttempt(first.executionId, first.executionAttemptId);
    expect(stored?.preparationReceipts).toEqual([
      { operationId: winner.operationId, runtimeGeneration: winner.runtimeGeneration, result: winner.result },
    ]);
    expect(stored?.activeOperationId).toBeNull();
    expect(stored?.lastCompletedOperationId).toBe(winner.operationId);
  });
}
