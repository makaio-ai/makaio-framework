import { describe, expect, it } from 'vitest';
import type { OutcomeCodec } from '../../execution-attempt-repository.js';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import { useHarness } from './harness.js';
import type { ExecutionAttemptRepositoryContractFactory } from './types.js';

/** Outcome whose member order is deliberately visible in its durable text. */
interface MemberOrderOutcome {
  readonly alpha: number;
  readonly beta: number;
}

/**
 * Check the required members without rebuilding the object, so serialization
 * retains the caller's insertion order.
 * @param input - Submitted outcome or JSON value decoded from durable text.
 * @returns Whether the input has the required numeric members.
 */
function isMemberOrderOutcome(input: unknown): input is MemberOrderOutcome {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    'alpha' in input &&
    'beta' in input &&
    typeof input.alpha === 'number' &&
    Number.isFinite(input.alpha) &&
    typeof input.beta === 'number' &&
    Number.isFinite(input.beta)
  );
}

/**
 * Codec that validates its object without normalizing member order.
 *
 * Its plain JSON rendering lets this suite prove that duplicate detection
 * compares parsed durable values, not literal serialized text.
 */
const memberOrderOutcomeCodec: OutcomeCodec<MemberOrderOutcome> = {
  parse: (input) => {
    if (!isMemberOrderOutcome(input)) throw new Error('MemberOrderOutcome requires numeric alpha and beta members');
    return input;
  },
  serialize: (outcome) => JSON.stringify(outcome),
};

/**
 * Register durable-outcome equivalence requirements independent of JSON member order.
 * @param factory - Repository realization under test.
 */
export function registerMemberOrderCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt outcome parity (${factory.name}, member-order codec)`, () => {
    const getHarness = useHarness(factory, memberOrderOutcomeCodec);

    it('replays equivalent reordered members with the first committed durable text', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });

      const original = harness.repository.canonicalizeOutcome({ alpha: 1, beta: 2 });
      const reordered = harness.peer.canonicalizeOutcome({ beta: 2, alpha: 1 });
      expect(original.text).not.toBe(reordered.text);

      const accepted = await harness.repository.commitOutcome({ ...ids, result: original });
      const controlObservation = { controlRevision: 0, cancellation: null };
      expect(accepted).toEqual({
        kind: 'accepted',
        outcome: { alpha: 1, beta: 2 },
        text: original.text,
        controlObservation,
      });

      const duplicate = await harness.peer.commitOutcome({ ...ids, result: reordered });
      expect(duplicate).toEqual({
        kind: 'duplicate',
        outcome: { alpha: 1, beta: 2 },
        text: original.text,
        controlObservation,
      });

      const changed = await harness.peer.commitOutcome({
        ...ids,
        result: harness.peer.canonicalizeOutcome({ beta: 2, alpha: 3 }),
      });
      expect(changed).toEqual({ kind: 'conflict' });
    });
  });
}
