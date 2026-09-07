import { describe, expect, it } from 'vitest';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { bytesOutcomeCodec } from './bytes-outcome.js';
import type { ExecutionAttemptRepositoryContractFactory } from './types.js';
import { useHarness } from './harness.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';

/**
 * Register the bytes codec requirements.
 * @param factory - Repository realization under test.
 */
export function registerBytesCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt outcome parity (${factory.name}, unfreezable outcome)`, () => {
    const getHarness = useHarness(factory, bytesOutcomeCodec);

    it('commits and replays an outcome Object.freeze would refuse', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      // Proof the type is outside `Object.freeze`: the assertions below would
      // pass vacuously if a populated typed array were freezable after all.
      expect(() => Object.freeze(Uint8Array.from([1, 2, 3]))).toThrow();
      const submitted = Uint8Array.from([1, 2, 3]);

      const rendering = harness.repository.canonicalizeOutcome(submitted);

      expect(rendering.text).toBe('[1,2,3]');
      const accepted = await harness.repository.commitOutcome({ ...ids, result: rendering });
      expect(accepted.kind).toBe('accepted');
      const committed = accepted.kind === 'accepted' ? accepted.outcome : null;
      expect(committed).toEqual(Uint8Array.from([1, 2, 3]));
      // The identity witness: what the port reports came out of the codec, not
      // out of the caller's hand.
      expect(committed).not.toBe(submitted);

      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(Uint8Array.from([1, 2, 3])),
      });
      expect(replay.kind).toBe('duplicate');
      expect(replay.kind === 'duplicate' ? replay.outcome : null).toEqual(Uint8Array.from([1, 2, 3]));

      const competing = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(Uint8Array.from([4])),
      });
      expect(competing).toEqual({ kind: 'conflict' });
    });
  });
}
