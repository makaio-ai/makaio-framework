/**
 * The evidence taxonomy every connector teardown reports itself in.
 *
 * The rule that makes this honest: **a class may only be claimed when the
 * runtime observed the transition itself.** Not "asked for it", not "the call
 * returned", not "no error was thrown". Where nothing is observable, the class
 * says so, and consumers act on the weaker fact rather than on a comfortable
 * one.
 * @packageDocumentation
 */
import { z } from 'zod';

/**
 * What a runtime observed about the end of a resource it was holding.
 *
 * Ordered from strongest to weakest evidence. The distinction that matters to
 * every consumer is the boundary between the first three and the last two: the
 * first three mean *nothing of ours is still talking to the provider*, the last
 * two mean *we stopped holding it and cannot say more*.
 *
 * The per-member reasoning:
 * - `exited` — an operating-system process this runtime spawned has terminated
 *   and its termination was observed (an `exit`/`close` event, a settled spawn
 *   promise, a reaped status). The strongest class available anywhere here.
 * - `closed` — a connection this runtime owned is closed and the close was
 *   acknowledged by the peer or reported by the OS. The peer process may
 *   outlive it; what is proven is that *this* runtime can no longer speak on it.
 * - `released` — an in-process object was released, every handle dropped and
 *   every subscription cancelled, so no callback can arrive afterwards.
 *   Provable locally and without a counterparty — which is exactly why it is
 *   admissible: for a resource with no external end, "no further effects are
 *   possible" is the whole of what closure means.
 * - `detached` — the runtime gave up its handle, but something outside it may
 *   still be running: a process it did not spawn, a server-side session it can
 *   only *ask* to end, a detached supervisor. **Not** an error.
 * - `unknown` — the teardown path threw, timed out, or was never reached.
 *   Nothing is known.
 */
export const TeardownEvidenceSchema = z.enum(['exited', 'closed', 'released', 'detached', 'unknown']);
/** One member of {@link TeardownEvidenceSchema}. */
export type TeardownEvidence = z.infer<typeof TeardownEvidenceSchema>;

/**
 * The three classes that prove this runtime stopped speaking to the provider.
 *
 * Declared once, in weakest-last order, because it is simultaneously the
 * observed-class set {@link teardownWasObserved} tests and the ranking
 * {@link aggregateTeardownEvidence} walks. Two literals would drift.
 */
const OBSERVED_EVIDENCE_WEAKEST_LAST = ['exited', 'closed', 'released'] as const satisfies readonly TeardownEvidence[];

/**
 * Whether an evidence class proves this runtime has stopped speaking to the
 * provider.
 *
 * The single predicate every consumer branches on, so the boundary is defined
 * once. `detached` and `unknown` are **not** observed: the first because someone
 * else may still be speaking, the second because nobody knows.
 * @param evidence - Class reported by the teardown.
 * @returns Whether the runtime provably released the provider conversation.
 */
export function teardownWasObserved(evidence: TeardownEvidence): boolean {
  return OBSERVED_EVIDENCE_WEAKEST_LAST.some((observed) => observed === evidence);
}

/**
 * Result of tearing one connector down.
 *
 * Carries the class plus a human-readable `detail` for diagnostics. It is not an
 * error type: a `detached` or `unknown` teardown is a *reported outcome*, and a
 * consumer that treats it as a failure will start failing removals whenever an
 * adapter is slow.
 */
export const ConnectorTeardownResultSchema = z.object({
  /** What this runtime observed about the end of its resources. */
  evidence: TeardownEvidenceSchema,
  /** Why this class and not a stronger one. Required for the two weak classes. */
  detail: z.string().optional(),
});
/** One reported connector teardown. */
export type ConnectorTeardownResult = z.infer<typeof ConnectorTeardownResultSchema>;

/**
 * Reduce a set of teardown classes to the one a caller may claim for all of
 * them.
 *
 * **The wave's only aggregation rule**, so every layer that tears down more
 * than one resource calls this instead of restating it: the reported class is
 * the **weakest** in the set — `unknown` if any is `unknown`, else `detached` if
 * any is `detached`, else the weakest of the observed three.
 *
 * A teardown of *nothing* reports `released`: there is provably nothing
 * speaking, and that is the case consumers hit most often — a wrong default
 * there is invisible.
 * @param classes - Classes observed by the individual teardowns, in any order.
 * @returns The weakest class in the set, or `released` for an empty set.
 */
export function aggregateTeardownEvidence(classes: Iterable<TeardownEvidence>): TeardownEvidence {
  let weakestObservedIndex = -1;
  let sawDetached = false;
  for (const evidence of classes) {
    if (evidence === 'unknown') return 'unknown';
    if (evidence === 'detached') {
      sawDetached = true;
      continue;
    }
    const index = OBSERVED_EVIDENCE_WEAKEST_LAST.indexOf(evidence);
    if (index > weakestObservedIndex) weakestObservedIndex = index;
  }
  if (sawDetached) return 'detached';
  // An empty set and a set of observed classes share this line deliberately:
  // `released` is both "nothing was speaking" and the weakest observed class.
  return OBSERVED_EVIDENCE_WEAKEST_LAST[weakestObservedIndex] ?? 'released';
}

/**
 * Reduce a set of reported teardowns to the one result standing for all of them.
 *
 * {@link aggregateTeardownEvidence} answers the class; this answers the whole
 * *result*, because every layer that aggregates needs the second half too and had
 * been restating it: the `detail`s of the members that reached no observed class
 * are joined, so a caller told only `unknown` can still tell **which** of several
 * resources produced it. Which members those are is not a second list of classes
 * here — it is {@link teardownWasObserved} negated, so the boundary keeps having
 * exactly one definition.
 *
 * Layers that carry more than the wire fields (a failure to rethrow, a per-resource
 * breakdown) build on this result rather than beside it.
 * @param results - Results reported by the individual teardowns, in any order.
 * @returns The weakest class in the set, carrying the joined weak-class `detail`s.
 */
export function aggregateTeardownResults(results: readonly ConnectorTeardownResult[]): ConnectorTeardownResult {
  const evidence: TeardownEvidence = aggregateTeardownEvidence(results.map((result) => result.evidence));
  const details = results
    .filter((result) => !teardownWasObserved(result.evidence))
    .map((result) => result.detail)
    .filter((detail): detail is string => detail !== undefined);
  return { evidence, ...(details.length > 0 && { detail: details.join('; ') }) };
}
