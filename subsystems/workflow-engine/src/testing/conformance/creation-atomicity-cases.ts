import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register atomic creation, active-pointer replacement, and pre-write validation requirements.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerCreationAtomicityCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('leaves one active attempt and closes its predecessor gate after concurrent distinct creations', async () => {
    const harness = getHarness();
    const primary = nextIds();
    const peer = { executionId: primary.executionId, executionAttemptId: `${primary.executionAttemptId}-peer` };
    await Promise.all([
      harness.repository.createAttempt({
        ...primary,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
      harness.peer.createAttempt({
        ...peer,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
    ]);

    const active = await Promise.all([
      harness.repository.getActiveAttempt(primary.executionId, primary.executionAttemptId),
      harness.repository.getActiveAttempt(peer.executionId, peer.executionAttemptId),
    ]);
    const winners = active.filter((attempt) => attempt !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) throw new Error('Expected one active attempt after concurrent creation');

    // Either creation can commit last; both controllers must observe the same pointer and gates.
    for (const repository of [harness.repository, harness.peer]) {
      for (const ids of [primary, peer]) {
        const isActive = ids.executionAttemptId === winner.executionAttemptId;
        const current = await repository.getActiveAttempt(ids.executionId, ids.executionAttemptId);
        if (isActive) {
          expect(current).toMatchObject({ ...ids, status: 'pending', operationStartGate: 'open' });
        } else {
          expect(current).toBeNull();
        }
        expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toMatchObject({
          ...ids,
          status: 'pending',
          operationStartGate: isActive ? 'open' : 'closed',
        });
      }
    }
  });

  it('rejects an invalid instruction without storing a row or consuming its attempt identifier', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const instruction = makeTestInstruction();

    await expect(
      harness.repository.createAttempt({
        ...ids,
        instruction: { ...instruction, revision: '' },
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      }),
    ).rejects.toThrow();
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.recovery.getAttemptWithAllocation(ids.executionAttemptId)).toBeNull();
      expect(await repository.getInstruction(ids)).toBeNull();
      expect(await repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toBeNull();
    }

    // Reusing exactly those identifiers proves rejection did not reserve a hidden row.
    expect(
      await harness.peer.createAttempt({ ...ids, instruction, bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS }),
    ).toMatchObject({
      ...ids,
      status: 'pending',
      instruction,
      operationStartGate: 'open',
    });
    for (const repository of [harness.repository, harness.peer]) {
      expect(await repository.getInstruction(ids)).toEqual(instruction);
      expect(await repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
        ...ids,
        status: 'pending',
        operationStartGate: 'open',
      });
    }
  });
}
