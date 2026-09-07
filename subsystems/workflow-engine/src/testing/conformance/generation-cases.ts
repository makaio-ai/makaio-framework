import { describe, expect, it } from 'vitest';
import { makeTestInstruction } from '../attempt-fixtures.js';
import { generationCounterCodec, type GenerationCounterOutcome } from './counter-outcome.js';
import type { ExecutionAttemptRepositoryContractFactory } from './types.js';
import { useHarness } from './harness.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';

/**
 * Register the generation codec requirements.
 * @param factory - Repository realization under test.
 */
export function registerGenerationCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt outcome parity (${factory.name}, non-idempotent serialization)`, () => {
    const getHarness = useHarness(factory, generationCounterCodec);

    it('replays an identical submission as duplicate against the text it stored', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      const submitted: GenerationCounterOutcome = { counter: 0, generation: 0 };

      // The determinism the port leans on: rendering one outcome twice yields
      // one text, which is what lets a retry be compared against the text an
      // earlier commit stored.
      expect(generationCounterCodec.serialize(submitted)).toBe(generationCounterCodec.serialize(submitted));

      // One serialization decides both facts: the column holds generation `1`
      // and the attempt therefore committed generation `1`.
      const rendering = harness.repository.canonicalizeOutcome(submitted);
      expect(rendering).toEqual({ text: '{"counter":0,"generation":1}', outcome: { counter: 0, generation: 1 } });
      const accepted = await harness.repository.commitOutcome({ ...ids, result: rendering });
      expect(accepted).toEqual({
        kind: 'accepted',
        outcome: { counter: 0, generation: 1 },
        text: '{"counter":0,"generation":1}',
      });

      // The worker's honest retry. Its submission would write the same text
      // the first commit wrote, so it is the same answer replayed. A
      // realization that re-serialized the committed generation `1` would
      // compare generation `2` against generation `1` and reject the retry as a
      // conflicting outcome, stranding the waiter it owes a settlement.
      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome({ counter: 0, generation: 0 }),
      });
      expect(replay).toEqual({
        kind: 'duplicate',
        outcome: { counter: 0, generation: 1 },
        text: '{"counter":0,"generation":1}',
      });

      // A genuinely different submission still conflicts: comparing stored
      // texts narrows nothing beyond what the codec itself collapses.
      const competing = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome({ counter: 4, generation: 0 }),
      });
      expect(competing).toEqual({ kind: 'conflict' });
    });
  });
}
