import { expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import { nextIds } from './attempt-helpers.js';
import type { ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Register recovery ordering independently of backend insertion order.
 * @param getHarness - Current suite realization, initialized before its cases run.
 */
export function registerRecoveryOrderCases(
  getHarness: () => ExecutionAttemptRepositoryContractHarness<WorkflowRunResult>,
): void {
  it('orders every recoverable candidate by creation instant, then by attempt identifier', async () => {
    const harness = getHarness();
    const { executionId } = nextIds();
    const oldest = { executionAttemptId: `${executionId}-z`, createdAt: '2026-01-01T00:00:00.000Z' };
    const laterA = { executionAttemptId: `${executionId}-a`, createdAt: '2026-01-02T00:00:00.000Z' };
    const laterB = { executionAttemptId: `${executionId}-b`, createdAt: laterA.createdAt };
    await harness.seedRecoverableAttempts({ executionId, entries: [laterB, oldest, laterA] });

    for (const repository of [harness.repository, harness.peer]) {
      const candidates = await repository.recovery.getRecoverableAttempts(executionId);
      expect(candidates.map(({ executionAttemptId, createdAt }) => ({ executionAttemptId, createdAt }))).toEqual([
        oldest,
        laterA,
        laterB,
      ]);
    }
  });
}
