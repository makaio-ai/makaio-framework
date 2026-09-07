import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeTestAllocationRef, makeTestInstruction } from '../attempt-fixtures.js';
import { nextIds, startAttempt, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register the host-owned bootstrap-claim expiry requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerClaimExpiryCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('preserves host claim expiry across allocation and excludes an expired allocation from recovery', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await harness.setClaimExpiry(ids.executionAttemptId, futureExpiry);

    expect(await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'recorded',
    });
    expect(await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
      claimable: true,
      claimExpiresAt: futureExpiry,
    });
    expect(await harness.peer.recovery.getRecoverableAttempts(ids.executionId)).toEqual([
      expect.objectContaining({ executionAttemptId: ids.executionAttemptId, claimExpiresAt: futureExpiry }),
    ]);

    await harness.setClaimExpiry(ids.executionAttemptId, '2000-01-01T00:00:00.000Z');
    expect(await harness.repository.recovery.getRecoverableAttempts(ids.executionId)).toEqual([]);
    expect(await harness.peer.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
      claimExpiresAt: '2000-01-01T00:00:00.000Z',
    });
  });

  it('preserves host claim expiry when a newer attempt supersedes an allocated one', async () => {
    const harness = getHarness();
    const first = nextIds();
    const claim = await startAttempt(harness.repository, first);
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await harness.setClaimExpiry(first.executionAttemptId, futureExpiry);
    expect(await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'recorded',
    });

    const replacement = {
      executionId: first.executionId,
      executionAttemptId: `${first.executionAttemptId}-replacement`,
    };
    await harness.peer.createAttempt({
      ...replacement,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });

    const superseded = await harness.repository.recovery.getAttemptWithAllocation(first.executionAttemptId);
    expect(superseded).toMatchObject({
      status: 'allocated',
      claimExpiresAt: futureExpiry,
    });
    expect(superseded?.claimable ?? false).toBe(false);
    const pending = await harness.peer.recovery.getAttemptWithAllocation(replacement.executionAttemptId);
    expect(pending).toMatchObject({ status: 'pending' });
    expect(pending?.claimable ?? false).toBe(false);
    expect(pending?.claimExpiresAt ?? null).toBeNull();
  });
}
