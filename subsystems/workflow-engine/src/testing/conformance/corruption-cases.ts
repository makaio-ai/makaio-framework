import { describe, expect, it } from 'vitest';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { counterCodec } from './counter-outcome.js';
import type { ExecutionAttemptRepositoryContractFactory } from './types.js';
import { useHarness } from './harness.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';

/**
 * Register the corruption codec requirements.
 * @param factory - Repository realization under test.
 */
export function registerCorruptionCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt outcome parity (${factory.name}, invalid stored outcome)`, () => {
    const getHarness = useHarness(factory, counterCodec);

    it('throws instead of reporting conflict when the stored outcome does not parse', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      // Valid JSON the codec refuses, so the failure is the codec's and not
      // `JSON.parse` choking on a truncated write.
      await harness.writeStoredOutcomeText(ids.executionAttemptId, '"not-a-number"');

      // A submission that differs from the stored text: the branch that used to
      // answer `conflict` without ever consulting the codec.
      // Rejection is required; a realization may wrap the codec's error.
      await expect(
        harness.repository.commitOutcome({ ...ids, result: harness.repository.canonicalizeOutcome(5) }),
      ).rejects.toThrow();
    });
  });
}
