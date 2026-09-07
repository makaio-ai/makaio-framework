import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { nextIds, startAttempt } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register timestamp ordering requirements for provider-operation leases.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerTimestampCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('orders offset-form takeover observations as instants and stores the new lease in canonical UTC', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const issuedLease = new Date(Date.parse(claim.leaseExpiresAt));
    const beforeExpiry = formatOffsetIso(new Date(issuedLease.getTime() - 1_000), 120);
    const afterExpiry = formatOffsetIso(new Date(issuedLease.getTime() + 1_000), -120);
    const requestedLeaseInstant = new Date(issuedLease.getTime() + 60_000);
    const requestedLease = formatOffsetIso(requestedLeaseInstant, 120);
    const canonicalLease = requestedLeaseInstant.toISOString();

    // The first text looks later, but its instant is before the issued lease.
    expect(beforeExpiry > claim.leaseExpiresAt).toBe(true);
    expect(Date.parse(beforeExpiry)).toBeLessThan(Date.parse(claim.leaseExpiresAt));
    expect(
      await harness.peer.takeOverProviderOperation({
        executionAttemptId: ids.executionAttemptId,
        ownerId: 'offset-before-expiry-controller',
        observedAt: beforeExpiry,
        leaseExpiresAt: requestedLease,
      }),
    ).toEqual({ kind: 'stale' });
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject(claim);

    // The second text looks earlier, but its instant is after the issued lease.
    expect(afterExpiry < claim.leaseExpiresAt).toBe(true);
    expect(Date.parse(afterExpiry)).toBeGreaterThan(Date.parse(claim.leaseExpiresAt));
    const takeover = await harness.peer.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'offset-after-expiry-controller',
      observedAt: afterExpiry,
      leaseExpiresAt: requestedLease,
    });

    expect(takeover.kind).toBe('claimed');
    if (takeover.kind !== 'claimed') throw new Error('Expected takeover after the lease expiry instant');
    expect(takeover.claim).toMatchObject({
      generation: claim.generation + 1,
      ownerId: 'offset-after-expiry-controller',
      leaseExpiresAt: canonicalLease,
    });
    expect(await harness.repository.getProviderOperation(ids.executionAttemptId)).toMatchObject({
      ...takeover.claim,
      leaseExpiresAt: canonicalLease,
    });
  });
}

/**
 * Render one instant in a numeric-offset ISO-8601 form without changing it.
 * @param instant - UTC instant to express.
 * @param offsetMinutes - Offset east of UTC to render.
 * @returns The same instant expressed with the requested numeric offset.
 */
function formatOffsetIso(instant: Date, offsetMinutes: number): string {
  const local = new Date(instant.getTime() + offsetMinutes * 60_000);
  const absoluteOffset = Math.abs(offsetMinutes);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const pad = (value: number): string => value.toString().padStart(2, '0');

  return `${local.toISOString().slice(0, -1)}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(
    absoluteOffset % 60,
  )}`;
}
