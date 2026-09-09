import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import {
  makeBeginProvisioningInput,
  makeEvidence,
  makeTestInstruction,
  makeTestWorkflowResult,
} from '../attempt-fixtures.js';
import { allocateAttempt, nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Prove cancellation survives replacement controllers without becoming a terminal outcome.
 * @param getHarness - Independent repositories sharing one durable store.
 */
export function registerCancellationIntentCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('persists cancellation and closes admission without confirming any outcome', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const claim = await allocateAttempt(repository, ids);
    await repository.requestCancellation({ executionId: ids.executionId, reason: 'operator cancelled' });
    const intent = await peer.readCancellation(ids.executionAttemptId);
    expect(intent).toEqual({ requestedAt: expect.any(String), reason: 'operator cancelled' });
    expect(Number.isFinite(Date.parse(intent!.requestedAt))).toBe(true);
    expect(await peer.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
      status: 'allocated',
      settlementKind: null,
      operationStartGate: 'closed',
    });
    expect(await peer.getProviderOperation(ids.executionAttemptId)).toMatchObject({ completionEvidence: null });
    await repository.handoffProviderOperation({ claim, evidence: makeEvidence() });
    expect(await peer.readCancellation(ids.executionAttemptId)).toEqual(intent);
  });

  it('preserves the first request across duplicates and returns independent read values', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    await repository.requestCancellation({ executionId: ids.executionId });
    const first = await peer.readCancellation(ids.executionAttemptId);
    await peer.requestCancellation({ executionId: ids.executionId, reason: 'later reason' });
    expect(await repository.readCancellation(ids.executionAttemptId)).toEqual(first);
    Object.assign(first!, { reason: 'reader mutation' });
    expect(await peer.readCancellation(ids.executionAttemptId)).not.toHaveProperty('reason');
  });

  it('includes historical residual allocations but never another owner', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const other = nextIds();
    await allocateAttempt(repository, ids);
    await repository.commitOutcome({
      ...ids,
      result: repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
    });
    const successor = { ...ids, executionAttemptId: `${ids.executionAttemptId}-next` };
    await allocateAttempt(repository, successor);
    await allocateAttempt(repository, other);
    await peer.requestCancellation({ executionId: ids.executionId });
    expect(await repository.readCancellation(ids.executionAttemptId)).not.toBeNull();
    expect(await repository.readCancellation(successor.executionAttemptId)).not.toBeNull();
    expect(await repository.readCancellation(other.executionAttemptId)).toBeNull();
    expect(await repository.getAttemptControlState(other.executionAttemptId)).toMatchObject({
      operationStartGate: 'open',
    });
  });

  it('does not install a permanent owner-wide creation fence', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await repository.requestCancellation({ executionId: ids.executionId });
    await peer.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    expect(await repository.readCancellation(ids.executionAttemptId)).toBeNull();
    expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'open',
    });
    expect(await peer.readCancellation('missing-attempt')).toBeNull();
  });

  it('serializes concurrent controller requests to one immutable intent', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    await Promise.all([
      repository.requestCancellation({ executionId: ids.executionId, reason: 'first controller' }),
      peer.requestCancellation({ executionId: ids.executionId, reason: 'second controller' }),
    ]);
    const intent = await repository.readCancellation(ids.executionAttemptId);
    expect(['first controller', 'second controller']).toContain(intent?.reason);
    expect(await peer.readCancellation(ids.executionAttemptId)).toEqual(intent);
  });

  it('refuses provider provisioning after cancellation committed before dispatch', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    await peer.requestCancellation({ executionId: ids.executionId });
    expect(
      await repository.beginProvisioning(makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId)),
    ).toEqual({ kind: 'fenced' });
    expect(await peer.getProviderOperation(ids.executionAttemptId)).toBeNull();
  });
}
