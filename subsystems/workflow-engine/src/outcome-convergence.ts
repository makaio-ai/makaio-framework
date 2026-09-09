import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import type { ExecutionOwnerId, RuntimeOutcomeFence } from './execution-attempt-repository.js';

export type { ExecutionOwnerId };

/**
 * Input handed to {@link OutcomeConvergence.converge}.
 *
 * Named rather than inlined so an owner-side realization can state the shape
 * it implements against, and so a consumer can pin it from the public surface.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface OutcomeConvergenceInput<TOutcome> {
  /** Owner identifier the attempt belongs to. */
  readonly executionId: ExecutionOwnerId;
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** The canonical committed outcome, never the submitter's copy of it. */
  readonly outcome: TOutcome;
  /** The durable decision that produced the committed outcome. */
  readonly decision: 'accepted' | 'duplicate';
}

/**
 * Owner-side convergence of a committed attempt outcome.
 *
 * Runs after the durable commit and before waiter settlement and ACK. It is
 * idempotent by contract: it is re-entered for every duplicate retry, because
 * a worker whose first submission committed but did not converge resubmits
 * the same outcome, receives `duplicate`, and must converge again.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface OutcomeConvergence<TOutcome> {
  /**
   * Converge owner state with the committed outcome.
   * @param input - Attempt identity, the canonical committed outcome, and the
   *   durable decision that produced it.
   */
  converge(input: OutcomeConvergenceInput<TOutcome>): Promise<void>;
}

/**
 * Owner-side validation that runs before the durable commit.
 *
 * Performs reads only: an outcome it rejects never becomes an immutable
 * attempt outcome, so a corrected retry is not answered as a conflict. What
 * it inspects is the canonical outcome the attempt will hold, obtained from
 * `ExecutionAttemptAuthority.canonicalizeOutcome` before the commit.
 *
 * **A realization must be retry-stable.** {@link submitAttemptOutcome} runs it
 * ahead of every commit, including the retry of a submission that already
 * committed, so its verdict may depend only on the submission itself and on
 * owner facts no convergence step rewrites — never on owner state convergence
 * moves forward. A validator that read, say, a mutable lifecycle status would
 * reject the identical retry of an outcome its own convergence already
 * committed, and the waiter for that outcome would never settle.
 *
 * Retry-stable is measured on the outcome, not on its text. A retry need not
 * render the same text as the first commit: `sameDurableOutcome` judges
 * two texts the same outcome whatever member order they carry and answers
 * `duplicate` for such a retry, while the validator sees the retry's own
 * canonical rendering, never the stored one. Its verdict may therefore turn
 * only on what `sameDurableOutcome` compares — the members and their values
 * — and never on member order or any other detail of one particular
 * rendering. A validator that keyed on which member comes first would reject
 * the retry the repository is about to report as `duplicate`, and the
 * committed-but-unconverged waiter could never recover. Validating the stored
 * representation instead is not an option, for the reason the next paragraph
 * gives: validation runs ahead of the commit, where the retry's rendering is
 * the only one there is.
 *
 * The rule is stated here rather than worked around downstream because the
 * order it constrains is the one that keeps a spoofed outcome out of durable
 * storage: validation cannot move behind the commit without committing what
 * it exists to reject. The workflow adapter's `validateOutcomeExecutionIdentity`
 * satisfies it by correlating the submitted result against immutable durable
 * identity — the execution's own id and workflow id, and the run context's
 * terminal-authority binding, none of which outcome convergence touches.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface OutcomePreCommitValidation<TOutcome> {
  /**
   * Validate an outcome against owner state.
   *
   * Called again for every retry of the same submission, so the same outcome
   * owes the same verdict — the same as `sameDurableOutcome` reads it,
   * which ignores member order and every other rendering detail, not the
   * same text.
   *
   * The outcome handed over is the canonical one — what the attempt will
   * hold and what {@link OutcomeConvergence.converge} will receive — not the
   * submitter's copy of it. A codec may normalize while serializing, so
   * validating the copy would let an outcome the validator would have
   * rejected become the immutable committed one.
   * @param executionId - Owner identifier the attempt belongs to.
   * @param outcome - Canonical outcome about to be committed.
   * @throws When the outcome must not be committed.
   */
  validate(executionId: ExecutionOwnerId, outcome: TOutcome): Promise<void>;
}

/**
 * Dependencies of {@link submitAttemptOutcome}.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface AttemptOutcomeSubmissionDeps<TOutcome> {
  /** Authority that commits the outcome and holds the in-process waiter. */
  readonly authority: ExecutionAttemptAuthority<TOutcome>;
  /** Owner convergence that runs for `accepted` and `duplicate` decisions. */
  readonly convergence: OutcomeConvergence<TOutcome>;
  /** Optional owner validation that runs before the durable commit. */
  readonly validation?: OutcomePreCommitValidation<TOutcome>;
}

/**
 * Input of {@link submitAttemptOutcome}.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface AttemptOutcomeSubmission<TOutcome> {
  /** Owner identifier the attempt belongs to. */
  readonly executionId: ExecutionOwnerId;
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Outcome the worker submitted. */
  readonly outcome: TOutcome;
  /** Originating runtime slot, checked atomically at commit after owner validation. */
  readonly runtimeFence?: RuntimeOutcomeFence;
}

/**
 * Submit an attempt outcome through the generic owner boundary.
 *
 * Order: one canonicalization of the submitted outcome, optional pre-commit
 * validation of that canonical value, durable commit of that same rendering
 * through the authority, owner convergence for `accepted` and `duplicate`,
 * then waiter settlement on a fresh decode of the text the decision reports
 * as committed. The decision kind is returned for the caller's
 * acknowledgement.
 *
 * Invariants this function keeps:
 * - the submission is rendered exactly once, and the submitter's object is
 *   never read again after that: an outcome the caller mutates while an await
 *   is pending can reach neither the validation nor the durable write;
 * - validation and convergence see one and the same value: the canonical
 *   outcome the attempt holds, never the submitter's copy of it;
 * - convergence only ever sees `decision.outcome`, the repository's own
 *   committed object;
 * - the waiter settles on a value decoded afresh from the text the attempt
 *   stores — the decision's own text, which for a `duplicate` is the first
 *   commit's rather than the retry's — so what a runner receives is the
 *   committed outcome even when convergence mutated the object it was handed;
 * - a throwing convergence leaves the outcome durably committed and the
 *   waiter pending, so the worker's retry yields `duplicate` and converges
 *   again; nothing is rejected or deleted here. That recovery path runs the
 *   validation again first, which is why {@link OutcomePreCommitValidation}
 *   owes a retry-stable verdict;
 * - `conflict` and `fenced` skip convergence and settlement; their waiter
 *   rejection already happened inside `ExecutionAttemptAuthority.commitOutcome`.
 * @param deps - Authority, convergence, and optional validation.
 * @param input - Attempt identity and submitted outcome.
 * @returns The durable decision kind.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export async function submitAttemptOutcome<TOutcome>(
  deps: AttemptOutcomeSubmissionDeps<TOutcome>,
  input: AttemptOutcomeSubmission<TOutcome>,
): Promise<'accepted' | 'duplicate' | 'conflict' | 'fenced'> {
  // The submitter's object is read exactly here and never again. What the
  // owner validates is what the attempt will hold — a codec may normalize
  // while serializing, so the submitter's copy and the committed outcome can
  // differ — and because the rendering itself is carried into the commit, no
  // second serialization and no mutation of the caller's object during the
  // awaits below can make the durable answer differ from the validated one.
  const durable = deps.authority.canonicalizeOutcome(input.outcome);
  const runtimeFence = input.runtimeFence === undefined ? undefined : { ...input.runtimeFence };

  // Ahead of the commit, on every attempt including a retry of one that
  // already committed: an outcome the owner rejects must never become durable,
  // which is why the validation contract requires a retry-stable verdict
  // rather than the order being relaxed for retries.
  await deps.validation?.validate(input.executionId, durable.outcome);

  const decision = await deps.authority.commitOutcome(
    input.executionAttemptId,
    input.executionId,
    durable,
    runtimeFence,
  );

  if (decision.kind === 'accepted' || decision.kind === 'duplicate') {
    await deps.convergence.converge({
      executionId: input.executionId,
      executionAttemptId: input.executionAttemptId,
      outcome: decision.outcome,
      decision: decision.kind,
    });
    // The waiter is settled from `decision.text`, not from `decision.outcome`
    // and not from `durable.text` — convergence has just held
    // `decision.outcome`, and a mutable outcome it changed there must not be
    // what the runner receives, while `durable.text` is only this
    // submission's own rendering. `decision.text` is the text the attempt
    // holds: for a `duplicate` that is the first commit's text, which
    // `sameDurableOutcome` judges the same outcome as the retry's without the
    // two being the same text, so decoding the retry's would hand the runner
    // a representation the attempt never stored.
    deps.authority.settleOutcome(input.executionAttemptId, {
      kind: decision.kind,
      outcome: deps.authority.decodeOutcome(decision.text),
      text: decision.text,
      controlObservation: decision.controlObservation,
    });
  }

  return decision.kind;
}
