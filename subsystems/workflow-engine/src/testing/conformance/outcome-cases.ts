import { describe, expect, it } from 'vitest';
import type { WorkflowRunResult } from '@makaio/contracts';
import type { OutcomeCodec } from '../../execution-attempt-repository.js';
import { makeTestInstruction, makeTestWorkflowResult, workflowRunResultOutcomeCodec } from '../attempt-fixtures.js';
import { counterCodec, type CounterOutcome } from './counter-outcome.js';
import type { ExecutionAttemptRepositoryContractFactory } from './types.js';
import { useHarness } from './harness.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';

/**
 * One owner outcome type the commitment cases are asserted against.
 *
 * `TOutcome` is a type parameter of the port, so a rule the port owes is owed
 * for whatever outcome an owner injects a codec for — not only for the
 * workflow adapter's own result.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
interface OutcomeVariant<TOutcome> {
  /** Codec the realization is built with. */
  readonly codec: OutcomeCodec<TOutcome>;
  /**
   * Build one of two unequal outcomes.
   * @param executionId - Execution the outcome belongs to, where the type carries one.
   * @param seed - `0` for the outcome a case commits, `1` for a competing one.
   * @returns The outcome to submit.
   */
  readonly makeOutcome: (executionId: string, seed: 0 | 1) => TOutcome;
}

const WORKFLOW_OUTCOME_VARIANT: OutcomeVariant<WorkflowRunResult> = {
  codec: workflowRunResultOutcomeCodec,
  makeOutcome: (executionId, seed) => makeTestWorkflowResult(executionId, seed === 0 ? 'completed' : 'failed'),
};

// Seed `0` is the number `0`: a committed outcome a truthiness probe reads as
// absence, which is what makes this variant the presence check's witness.
const COUNTER_OUTCOME_VARIANT: OutcomeVariant<CounterOutcome> = {
  codec: counterCodec,
  makeOutcome: (_executionId, seed) => seed,
};

/**
 * Assert the outcome decisions one realization owes for one outcome type.
 *
 * Defined as a function rather than a `describe.each` row so each outcome type
 * keeps its own `TOutcome` instead of collapsing into a union, and so the
 * cases that never touch an outcome are not re-run once per outcome type.
 * @param factory - Named factory that builds a realization around a codec.
 * @param outcomeName - Name of the outcome type under test.
 * @param variant - Codec and outcome builder for that type.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
function defineOutcomeParity<TOutcome>(
  factory: ExecutionAttemptRepositoryContractFactory,
  outcomeName: string,
  variant: OutcomeVariant<TOutcome>,
): void {
  describe(`execution attempt outcome parity (${factory.name}, ${outcomeName})`, () => {
    const getHarness = useHarness(factory, variant.codec);

    it('commits an outcome, reports the stored one on replay, and conflicts on a different one', async () => {
      const harness = getHarness();
      const ids = nextIds();
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      const result = variant.makeOutcome(ids.executionId, 0);

      // A real attempt identifier is not authority to settle another owner's work.
      expect(
        await harness.peer.commitOutcome({
          executionAttemptId: ids.executionAttemptId,
          executionId: `${ids.executionId}-foreign-owner`,
          result: harness.peer.canonicalizeOutcome(result),
        }),
      ).toEqual({ kind: 'fenced' });
      const untouched = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
      expect(untouched).toMatchObject({
        executionId: ids.executionId,
        status: 'pending',
        operationStartGate: 'open',
      });
      expect(untouched?.settlementKind ?? null).toBeNull();
      expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
        executionAttemptId: ids.executionAttemptId,
      });

      const storedText = harness.repository.canonicalizeOutcome(result).text;
      const accepted = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(result),
      });

      const controlObservation = { controlRevision: 0, cancellation: null };
      expect(accepted).toEqual({ kind: 'accepted', outcome: result, text: storedText, controlObservation });
      // Presence, not truthiness, decides that an outcome is already
      // committed: the counter variant commits `0` here, and a realization
      // that probed the stored value for truthiness would answer `accepted` a
      // second time. The reported outcome is the stored one, which for a
      // durable realization means it came back through the codec rather than
      // straight out of the column.
      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(variant.makeOutcome(ids.executionId, 0)),
      });
      expect(replay).toEqual({ kind: 'duplicate', outcome: result, text: storedText, controlObservation });

      const competing = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(variant.makeOutcome(ids.executionId, 1)),
      });
      expect(competing).toEqual({ kind: 'conflict' });
    });

    it('stores prior cancellation beside an opaque outcome without transforming its value', async () => {
      const { repository, peer } = getHarness();
      const ids = nextIds();
      await repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      await peer.requestAttemptCancellation({ ...ids, requestKey: 'stop-opaque-owner' });
      const cancellation = await repository.readCancellation(ids.executionAttemptId);
      const result = repository.canonicalizeOutcome(variant.makeOutcome(ids.executionId, 0));
      const controlObservation = { controlRevision: 1, cancellation };
      expect(await repository.commitOutcome({ ...ids, result })).toEqual({
        kind: 'accepted',
        ...result,
        controlObservation,
      });
      expect(await peer.commitOutcome({ ...ids, result })).toEqual({
        kind: 'duplicate',
        ...result,
        controlObservation,
      });
      expect(await peer.readAttemptSettlement(ids)).toMatchObject({ kind: 'outcome', result, controlObservation });
    });
  });
}

/**
 * Register ordinary and falsy outcome commitment requirements.
 * @param factory - Repository realization under test.
 */
export function registerOutcomeCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  defineOutcomeParity(factory, 'workflow run result', WORKFLOW_OUTCOME_VARIANT);
  defineOutcomeParity(factory, 'counter', COUNTER_OUTCOME_VARIANT);
}
