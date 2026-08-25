import { CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH } from './schemas.js';
import type {
  CodeExecutionAbortReason,
  CodeExecutionCancelledOutcome,
  CodeExecutionProviderContext,
  CodeExecutionTimedOutOutcome,
} from './types.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Contract-owned construction of the outcome shapes every CodeExecution
// participant would otherwise re-derive.
//
// Two rules are documented on the contract types but were previously left to
// each producer to implement: how an aborted execution is classified as a
// timeout versus a cancellation, and how a failure summary is kept inside the
// contract's length bound. A rule the contract states is a rule the contract
// should implement — a second implementation is free to drift in its message
// vocabulary and in the classification itself, and the drift only surfaces as
// two participants disagreeing about the same invocation.
//
// Both helpers are platform-neutral: `AbortSignal` and `Date.now` are standard,
// so this module stays free of any runtime-specific dependency.

/** Summary reported for an execution that ran out of wall-clock budget. */
const TIMED_OUT_MESSAGE = 'The execution exceeded its wall-clock budget before completing.';

/** Summary reported for an execution that was cancelled before completing. */
const CANCELLED_MESSAGE = 'The execution was cancelled before it completed.';

/** Ellipsis appended to a summary that had to be truncated to the contract bound. */
const TRUNCATION_SUFFIX = '…';

/**
 * Clamp a failure summary to {@link CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH}.
 *
 * Summaries interpolate host-controlled identifiers and provider diagnostics of
 * unbounded length, so the bound is enforced where the failure is built rather
 * than trusted to the length of its inputs. Truncation is marked with an
 * ellipsis so a reader can tell a clipped summary from a complete one, and the
 * result always satisfies the failure schema.
 * @param message - Summary to place on a failure.
 * @returns The summary, truncated to the contract bound when needed.
 */
export function boundCodeExecutionFailureMessage(message: string): string {
  if (message.length <= CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH) return message;
  return `${message.slice(0, CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

/**
 * Build the terminal outcome for an abort reason owned by the caller.
 *
 * This is deliberately separate from {@link codeExecutionAbortOutcome}: a
 * router which owns an effective signal retains its reason privately, while a
 * provider can only observe the signal it was handed. The owning router must
 * not let a provider's mutable view of that signal revise the classification
 * it already recorded.
 * @param reason - Authoritative abort reason recorded by the signal owner.
 * @returns The terminal timeout or cancellation outcome for that reason.
 */
export function codeExecutionAbortOutcomeForReason(
  reason: CodeExecutionAbortReason,
): CodeExecutionTimedOutOutcome | CodeExecutionCancelledOutcome {
  if (reason === 'timeout') {
    return { status: 'timed_out', error: { code: 'execution_timeout', message: TIMED_OUT_MESSAGE } };
  }
  return { status: 'cancelled', error: { code: 'cancelled', message: CANCELLED_MESSAGE } };
}

/**
 * Classify a settled execution abort as a timeout or a cancellation.
 *
 * This is the algorithm {@link CodeExecutionProviderContext.signal} documents
 * for a provider's observed or otherwise foreign signal. A routing service
 * which owns the abort reason privately uses
 * {@link codeExecutionAbortOutcomeForReason} instead.
 *
 * The signal's typed reason is authoritative, because only the party that owns
 * the signal knows why it settled. Comparing a wall clock against the deadline
 * instead would misreport a cancellation that happens to be processed after the
 * deadline, and would depend on the host clock not having moved. The deadline
 * comparison survives only as the documented fallback for a foreign signal —
 * one aborted by someone other than the routing service, which therefore
 * carries no `CodeExecutionAbortReason`.
 *
 * Each returned variant carries the failure code the outcome union pins to it,
 * so the mapping is total and cannot produce a contradictory status/code pair.
 * @param context - Effective cancellation signal and deadline for the execution.
 * @returns The `timed_out` or `cancelled` terminal outcome for that abort.
 */
export function codeExecutionAbortOutcome(
  context: CodeExecutionProviderContext,
): CodeExecutionTimedOutOutcome | CodeExecutionCancelledOutcome {
  const reason: unknown = context.signal.reason;
  if (reason === 'timeout' || reason === 'cancellation') return codeExecutionAbortOutcomeForReason(reason);
  return codeExecutionAbortOutcomeForReason(Date.now() >= context.deadlineEpochMs ? 'timeout' : 'cancellation');
}
