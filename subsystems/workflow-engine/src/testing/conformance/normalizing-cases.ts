import { describe, expect, it } from 'vitest';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { roundingCounterCodec } from './counter-outcome.js';
import type { ExecutionAttemptRepositoryContractFactory } from './types.js';
import { useHarness } from './harness.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';

/**
 * Register the normalizing codec requirements.
 * @param factory - Repository realization under test.
 */
export function registerNormalizingCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt outcome parity (${factory.name}, normalizing codec)`, () => {
    const getHarness = useHarness(factory, roundingCounterCodec);

    it('commits, replays, and conflicts on the truncated counter the codec persists', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });

      // The column holds `1`, so `1` is what the attempt committed — a
      // realization reporting the submitted `1.2` would report an outcome no
      // reload ever yields, and the owner would converge on it.
      const accepted = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(1.2),
      });
      expect(accepted).toEqual({ kind: 'accepted', outcome: 1, text: '{"counter":1}' });

      // A different submission with the same durable form is the same answer
      // replayed, so it owes `duplicate` — comparing the submitted values would
      // make this a `conflict` and reject a worker's honest retry.
      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(1.7),
      });
      // The text is the *stored* one, which the retry's own rendering also
      // happens to equal here — the truncating codec renders `1.2` and `1.7`
      // alike.
      expect(replay).toEqual({ kind: 'duplicate', outcome: 1, text: '{"counter":1}' });

      // Normalization narrows what counts as the same outcome; it does not
      // dissolve the distinction. `2.5` persists as `2`, which is a second,
      // different answer for an attempt that already has one.
      const competing = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(2.5),
      });
      expect(competing).toEqual({ kind: 'conflict' });
    });
  });
}
