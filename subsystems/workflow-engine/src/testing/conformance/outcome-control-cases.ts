import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { RuntimeOutcomeFenceMismatchError } from '../../execution-attempt-repository.js';
import { makeTestWorkflowResult } from '../attempt-fixtures.js';
import { allocateAttempt, nextIds, readyAttempt, registerTestRuntime } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Verify commit-time control evidence without interpreting owner-specific terminal results.
 * @param getHarness - Real repositories sharing one isolated store.
 */
export function registerOutcomeControlCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it.each([
    'completed',
    'failed',
  ] as const)('preserves raw %s after prior cancellation and freezes its receipt', async (status) => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    const cancel = { ...ids, requestKey: 'stop-before-outcome', reason: 'owner requested stop' };
    await repository.requestAttemptCancellation(cancel);
    const receipt = await peer.readCancellation(ids.executionAttemptId);
    const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, status));
    const controlObservation = { controlRevision: 1, cancellation: receipt };
    expect(await repository.commitOutcome({ ...ids, result })).toEqual({
      kind: 'accepted',
      ...result,
      controlObservation,
    });
    await peer.requestCancellation({ executionId: ids.executionId, reason: 'later cleanup reason' });
    expect(await peer.commitOutcome({ ...ids, result })).toEqual({ kind: 'duplicate', ...result, controlObservation });
    expect(await peer.readAttemptSettlement(ids)).toMatchObject({ kind: 'outcome', result, controlObservation });
    expect(await peer.requestAttemptCancellation(cancel)).toEqual({ kind: 'replayed', intent: receipt });
  });

  it.each([
    'completed',
    'failed',
  ] as const)('never retroactively adds a cancellation to an earlier %s outcome', async (status) => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, status));
    const controlObservation = { controlRevision: 0, cancellation: null };
    expect(await repository.commitOutcome({ ...ids, result })).toEqual({
      kind: 'accepted',
      ...result,
      controlObservation,
    });
    expect(await peer.requestAttemptCancellation({ ...ids, requestKey: 'cleanup-after-outcome' })).toMatchObject({
      kind: 'accepted',
      intent: { controlRevision: 1 },
    });
    expect(await repository.readCancellation(ids.executionAttemptId)).not.toBeNull();
    expect(await peer.commitOutcome({ ...ids, result })).toEqual({ kind: 'duplicate', ...result, controlObservation });
    expect(await peer.readAttemptSettlement(ids)).toMatchObject({ kind: 'outcome', result, controlObservation });
  });

  it('serializes concurrent cancellation and outcome to one replayable control observation', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    const [committed] = await Promise.all([
      repository.commitOutcome({ ...ids, result }),
      peer.requestAttemptCancellation({ ...ids, requestKey: 'concurrent-stop' }),
    ]);
    if (committed.kind !== 'accepted') throw new Error('Expected a canonical outcome');
    const receipt = await repository.readCancellation(ids.executionAttemptId);
    expect(receipt).toMatchObject({ controlRevision: 1 });
    expect([
      { controlRevision: 0, cancellation: null },
      { controlRevision: 1, cancellation: receipt },
    ]).toContainEqual(committed.controlObservation);
    expect(await peer.commitOutcome({ ...ids, result })).toEqual({ ...committed, kind: 'duplicate' });
    expect(await repository.readAttemptSettlement(ids)).toMatchObject({
      kind: 'outcome',
      result,
      controlObservation: committed.controlObservation,
    });
  });

  it('isolates commit, duplicate and settlement observations from caller mutation', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await allocateAttempt(repository, ids);
    await repository.requestAttemptCancellation({ ...ids, requestKey: 'stop', reason: 'immutable reason' });
    const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    const committed = await repository.commitOutcome({ ...ids, result });
    if (committed.kind !== 'accepted') throw new Error('Expected an accepted outcome');
    const expected = structuredClone(committed.controlObservation);
    Object.assign(committed.controlObservation!.cancellation!, { reason: 'mutated commit receipt' });
    Object.assign(committed.controlObservation!, { controlRevision: 99 });
    const duplicate = await peer.commitOutcome({ ...ids, result });
    expect(duplicate).toEqual({ kind: 'duplicate', ...result, controlObservation: expected });
    if (duplicate.kind !== 'duplicate') throw new Error('Expected duplicate outcome');
    Object.assign(duplicate.controlObservation!.cancellation!, { requestKey: 'mutated duplicate receipt' });
    const settlement = await repository.readAttemptSettlement(ids);
    expect(settlement).toMatchObject({ kind: 'outcome', controlObservation: expected });
    if (settlement.kind !== 'outcome') throw new Error('Expected outcome settlement');
    Object.assign(settlement.controlObservation!.cancellation!, { controlRevision: 100 });
    expect(await peer.readAttemptSettlement(ids)).toMatchObject({ kind: 'outcome', controlObservation: expected });
    expect(await peer.readCancellation(ids.executionAttemptId)).toEqual(expected!.cancellation);
  });

  it('keeps runtime and supersession fences independent of accepted control revisions', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    const previousGeneration = await readyAttempt(repository, ids);
    const currentGeneration = await registerTestRuntime(repository, ids, 'replacement-runtime');
    await peer.requestAttemptCancellation({ ...ids, requestKey: 'stop-current-runtime' });
    const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
    await expect(
      repository.commitOutcome({
        ...ids,
        result,
        runtimeFence: {
          runtimeGeneration: previousGeneration,
          operationId: null,
        },
      }),
    ).rejects.toThrow(RuntimeOutcomeFenceMismatchError);
    expect(await peer.readAttemptSettlement(ids)).toMatchObject({ kind: 'unsettled' });
    const receipt = await repository.readCancellation(ids.executionAttemptId);
    expect(receipt).toMatchObject({ controlRevision: 1 });
    expect(
      await repository.commitOutcome({
        ...ids,
        result,
        runtimeFence: {
          runtimeGeneration: currentGeneration,
          operationId: null,
        },
      }),
    ).toMatchObject({ kind: 'accepted', controlObservation: { controlRevision: 1, cancellation: receipt } });

    const superseded = nextIds();
    await allocateAttempt(repository, superseded);
    await peer.requestAttemptCancellation({ ...superseded, requestKey: 'stop-predecessor' });
    await allocateAttempt(repository, { ...superseded, executionAttemptId: `${superseded.executionAttemptId}-next` });
    expect(
      await peer.commitOutcome({
        ...superseded,
        result: peer.canonicalizeOutcome(makeTestWorkflowResult(superseded.executionId)),
      }),
    ).toEqual({ kind: 'fenced' });
    expect(await peer.readCancellation(superseded.executionAttemptId)).toMatchObject({ controlRevision: 1 });
    expect(await peer.readAttemptSettlement(superseded)).toMatchObject({ kind: 'unsettled', isCurrentAttempt: false });
  });
}
