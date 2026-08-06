/**
 * Turning an end this runtime *watched* into the class it may claim for it.
 *
 * The taxonomy's central rule is that a class may only be claimed when the
 * runtime observed the transition itself. Every connector that terminates a
 * process therefore has the same two-step shape: signal the end, then spend a
 * bounded amount of wall-clock time watching for it. This module owns that
 * shape so the four connectors that have it cannot each grow their own
 * almost-identical race.
 *
 * It owns the other half of the rule too: a teardown releases several things
 * best-effort, and a stage nobody could account for is exactly the case where no
 * class may be claimed. That mechanism lives here rather than in whichever
 * connector grew it first, because four copies of "which stage failed, and what
 * do I call the result" drift in both halves at once.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult, TeardownEvidence } from '@makaio/contracts';
import { aggregateTeardownEvidence } from '@makaio/contracts';
import type { TeardownReport } from './teardown-report.js';
import { unknownTeardown } from './teardown-report.js';
import { CONNECTOR_EXIT_OBSERVATION_MS } from './teardown-timing.js';

/** Inputs for {@link reportObservedExit}. */
export interface ObservedExitOptions {
  /**
   * Promise settled by the runtime's own observation of the end.
   *
   * Must be the promise the *existing* listener settles, never a second
   * subscription: two observations of one event are two things to keep in step,
   * and the second one is always the one that goes stale.
   */
  readonly exited: Promise<unknown>;
  /**
   * What was signalled, named for the `detail` a non-observation carries.
   *
   * Read by a human triaging a `detached` teardown, so it should name the
   * resource ("the qwen ACP process", "the tmux pane process") rather than
   * restating the class.
   */
  readonly resource: string;
}

/**
 * Wait for an end to be observed, bounded by the observation budget.
 *
 * The bound is what makes the wait admissible at all: a teardown that waited
 * for an exit that never comes would hang every consumer behind it, and a
 * consumer that hangs is strictly worse off than one told the end was not
 * observed. So expiry is a normal answer here, not a failure.
 *
 * A **rejected** observation counts as no observation. These promises are built
 * not to reject, but if one does then what failed is the watching, and a failed
 * watch has seen nothing.
 * @param exited - Promise settled by the runtime's own end observation.
 * @param budgetMs - Milliseconds to watch for; defaults to the wave's budget.
 * @returns Whether the end was observed inside the budget.
 */
export async function exitWasObserved(
  exited: Promise<unknown>,
  budgetMs: number = CONNECTOR_EXIT_OBSERVATION_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
  });
  try {
    return await Promise.race([
      exited.then(
        () => true,
        () => false,
      ),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Report the class a signalled resource's own end evidence supports.
 *
 * `exited` when the end was watched, `detached` when it was not — never
 * `unknown`, because nothing failed: the signal was sent and the handle is
 * gone, and the only missing fact is whether the peer finished before the
 * budget ran out. A `detail` names the resource so the weaker class is
 * actionable rather than merely honest.
 *
 * The budget is {@link CONNECTOR_EXIT_OBSERVATION_MS} and is not an option: "did
 * the resource end" is one question with one answer time across the wave, and a
 * per-call override nobody passed would only be a second place for it to differ.
 * @param options - Observation promise and resource name.
 * @returns `exited` on an observed end, `detached` with a `detail` otherwise.
 */
export async function reportObservedExit(options: ObservedExitOptions): Promise<ConnectorTeardownResult> {
  if (await exitWasObserved(options.exited)) {
    return { evidence: 'exited' };
  }
  return {
    evidence: 'detached',
    detail: `${options.resource} was signalled but its end was not observed within ${CONNECTOR_EXIT_OBSERVATION_MS}ms.`,
  };
}

/**
 * Report the class available to a teardown that finds one already finished.
 *
 * Every connector with a termination guard reaches this: a panic `abort()` ran,
 * or a first `close()` already reported, and a second caller arrives with no
 * observation of its own. It may not borrow the first one's — the class a
 * teardown reports is a statement about what *it* watched — and it may not claim
 * `released` either, because the handle being gone says nothing about the peer.
 * `detached` is what is left, and it is the truth: we stopped holding it and
 * cannot say more.
 * @returns `detached`, naming the missing observation.
 */
export function reportRepeatTeardown(): ConnectorTeardownResult {
  return {
    evidence: 'detached',
    detail: 'An earlier teardown closed this connector; this call made no observation of its own.',
  };
}

/**
 * Render a failure for a diagnostic `detail` without leaking a stack.
 *
 * Kept to the message because these `detail`s travel over the bus and end up in
 * logs a human reads; a stack there buries the one line that identifies the
 * stage.
 * @param error - Failure caught by a best-effort teardown stage.
 * @returns One-line description.
 */
export function describeTeardownFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Name a best-effort stage that failed, for {@link reportBestEffortStages}.
 *
 * For the connectors whose guarded region is interleaved with work that must run
 * regardless — a `finally` that closes a transport, an MCP unregistration behind a
 * disposal — and which therefore keep their own `try`/`catch` (and its log line)
 * and only borrow the naming.
 * @param stage - What was being released.
 * @param error - Failure the stage produced.
 * @returns The stage, named for a report.
 */
export function stageFailure(stage: string, error: unknown): string {
  return `${stage} failed (${describeTeardownFailure(error)})`;
}

/**
 * Run one best-effort teardown stage and name it when it fails.
 *
 * Several stages release several different things, so the first failure must not
 * skip the rest — and yet a stage nobody accounted for must not be reported as one
 * that succeeded. Returning the stage name instead of throwing is what lets a
 * caller do both: run everything, then decide the class from what went
 * unaccounted for.
 * @param stage - What is being released, for the reported `detail`.
 * @param run - The release call, which may be a no-op when the resource is absent.
 * @returns The named failure when the stage failed, `undefined` when it did not.
 */
export async function runBestEffortStage(
  stage: string,
  run: () => Promise<unknown> | undefined,
): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return stageFailure(stage, error);
  }
}

/**
 * Report the class a best-effort teardown with unaccounted stages may claim.
 *
 * The taxonomy's rule applied to the one case every such teardown shares: a
 * connector that could not tell whether its own release landed has no business
 * claiming it watched anything, so the class is `unknown` and *names* the stage —
 * a bare `unknown` leaves a human unable to tell which of several handles it was.
 *
 * `undefined` means every stage was accounted for, which is deliberately **not** a
 * class: what a fully accounted teardown may claim differs per connector (an
 * observed process exit, a `released` in-process object, a `detached` SDK handle)
 * and only the connector knows which. So the caller keeps that decision and this
 * only takes the branch the four of them shared.
 * @param subject - The teardown, named for the report ("Copilot close").
 * @param failures - Stages named by {@link runBestEffortStage} or {@link stageFailure}.
 * @returns The `unknown` report, or `undefined` when nothing went unaccounted for.
 */
export function reportBestEffortStages(subject: string, failures: readonly string[]): TeardownReport | undefined {
  if (failures.length === 0) return undefined;
  const noun = failures.length === 1 ? 'a stage' : 'stages';
  return unknownTeardown(`${subject} left ${noun} unaccounted for: ${failures.join('; ')}.`);
}

/**
 * Weaken a reported class to the weakest of itself and a ceiling.
 *
 * A connector sometimes learns *after* computing its class that something it
 * held was never proven finished — the canonical case being a superseded
 * resource generation nobody watched end. The class it may claim is then the
 * weakest of the two facts, which is the wave's single aggregation rule applied
 * to a set of two rather than a second rule.
 *
 * The reason travels with it: a capped class whose `detail` does not say what
 * capped it is indistinguishable from a resource that was simply slow.
 * @param result - Class the teardown computed for what it did observe.
 * @param ceiling - Strongest class the additional fact permits.
 * @param detail - Why the ceiling applies, appended to any existing `detail`.
 * @returns The capped class carrying both reasons.
 */
export function capTeardownEvidence(
  result: ConnectorTeardownResult,
  ceiling: TeardownEvidence,
  detail: string,
): ConnectorTeardownResult {
  return {
    evidence: aggregateTeardownEvidence([result.evidence, ceiling]),
    detail: result.detail === undefined ? detail : `${result.detail}; ${detail}`,
  };
}
