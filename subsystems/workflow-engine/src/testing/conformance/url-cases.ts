import { describe, expect, it } from 'vitest';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { urlOutcomeCodec } from './url-outcome.js';
import type { ExecutionAttemptRepositoryContractFactory } from './types.js';
import { useHarness } from './harness.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';

/**
 * Register the url codec requirements.
 * @param factory - Repository realization under test.
 */
export function registerUrlCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt outcome parity (${factory.name}, non-cloneable outcome)`, () => {
    const getHarness = useHarness(factory, urlOutcomeCodec);

    it('commits and replays an outcome structuredClone would refuse', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      // Proof the type is outside `structuredClone`: the assertion below would
      // pass vacuously if a URL were cloneable after all.
      expect(() => structuredClone(new URL('https://outcome.test/a'))).toThrow();
      const submitted = new URL('https://outcome.test/a');

      const accepted = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(submitted),
      });

      expect(accepted.kind).toBe('accepted');
      const committed = accepted.kind === 'accepted' ? accepted.outcome : null;
      expect(committed?.href).toBe('https://outcome.test/a');
      // The identity witness: what the port reports came out of the codec, not
      // out of the caller's hand, so a submitter that mutates its own object
      // afterwards changes nothing the owner converges on.
      expect(committed).not.toBe(submitted);

      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
      });
      expect(replay.kind).toBe('duplicate');
      expect(replay.kind === 'duplicate' ? replay.outcome.href : null).toBe('https://outcome.test/a');

      const competing = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/b')),
      });
      expect(competing).toEqual({ kind: 'conflict' });
    });

    // A `URL` keeps its state in internal slots, so `Object.freeze` does not
    // make it immutable: assigning `pathname` still rewrites `href`. What keeps
    // a committed outcome stable is therefore not the freeze but the rule that
    // every read decodes the stored text again — a realization that handed out
    // one shared instance would report the mutation back to the next reader.
    it('reports a committed outcome no earlier reader can have mutated', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });

      const accepted = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
      });
      const first = accepted.kind === 'accepted' ? accepted.outcome : null;
      // Proof the outcome type is mutable through the freeze, so the assertion
      // below is not passing because the mutation silently failed.
      if (first !== null) first.pathname = '/mutated';
      expect(first?.href).toBe('https://outcome.test/mutated');

      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
      });

      expect(replay.kind).toBe('duplicate');
      const second = replay.kind === 'duplicate' ? replay.outcome : null;
      expect(second?.href).toBe('https://outcome.test/a');
      expect(second).not.toBe(first);
    });

    // The rendering's decoded value is what a caller validates before it
    // commits, and a mutable one it can change there. The `accepted` decision
    // must still report what the stored text yields — anything else hands the
    // owner a value no later read of the attempt ever produces.
    it('reports an accepted outcome decoded from the stored text, not the rendering the caller held', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      const rendering = harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a'));
      // Exactly what a pre-commit validation is handed, mutated exactly where a
      // validator could mutate it. The assertion proves the mutation took, so
      // the ones below cannot pass vacuously.
      rendering.outcome.pathname = '/mutated';
      expect(rendering.outcome.href).toBe('https://outcome.test/mutated');
      expect(rendering.text).toBe('"https://outcome.test/a"');

      const accepted = await harness.repository.commitOutcome({ ...ids, result: rendering });

      expect(accepted.kind).toBe('accepted');
      expect(accepted.kind === 'accepted' ? accepted.outcome.href : null).toBe('https://outcome.test/a');
      // And the attempt holds the original, so the honest replay is a duplicate
      // rather than a conflict against a mutation nobody committed.
      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
      });
      expect(replay.kind).toBe('duplicate');
      expect(replay.kind === 'duplicate' ? replay.outcome.href : null).toBe('https://outcome.test/a');
    });

    // The read rule the port owes, and the one an owner boundary settles its
    // waiter from: the stored text is the only copy of an outcome no caller has
    // touched, and every decode of it is a value of its own.
    it('decodes a durable text into a fresh outcome on every call', async () => {
      const harness = getHarness();
      const text = harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')).text;

      const decoded = harness.repository.decodeOutcome(text);

      expect(decoded.href).toBe('https://outcome.test/a');
      expect(decoded).not.toBe(harness.repository.decodeOutcome(text));
      // A text the codec refuses fails loudly; the port permits wrapped codec errors.
      expect(() => harness.repository.decodeOutcome('5')).toThrow();
    });
  });
}
