import type { ExecutionAttemptInstruction } from '@makaio/contracts';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import type { ExecutionOwnerId, PendingAttemptAbandonmentDecision } from './execution-attempt-repository.js';

/**
 * Inputs for dispatching an Authority-owned attempt.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface AuthorityDispatchRunnerOptions<TOutcome> {
  /** Authority that persists and owns the execution attempt. */
  readonly authority: ExecutionAttemptAuthority<TOutcome>;
  /** Owner identifier of the aggregate that owns the attempt. */
  readonly executionId: ExecutionOwnerId;
  /** Complete non-secret assignment frozen before this Attempt can be dispatched. */
  readonly instruction: ExecutionAttemptInstruction;
  /** Dispatch operation whose successful return acknowledges acceptance. */
  readonly dispatch: (executionAttemptId: string) => Promise<unknown>;
}

/**
 * Dispatch an Authority-owned attempt and await its canonical outcome.
 *
 * A rejected dispatch operation is not proof that no provider received the
 * request. The pending-abandonment CAS distinguishes a confirmed pre-allocation
 * failure from a lost acknowledgement after provisioning, allocation, or settlement.
 * @param options - Authority, owner identity, immutable instruction, and dispatch operation.
 * @returns The Authority-committed outcome.
 */
export async function runAuthorityDispatchedAttempt<TOutcome>(
  options: AuthorityDispatchRunnerOptions<TOutcome>,
): Promise<TOutcome> {
  const { authority, executionId, instruction, dispatch } = options;
  const attempt = await authority.createAttempt(executionId, instruction);
  const outcomePromise = authority.waitForOutcome(attempt.executionAttemptId);
  if (outcomePromise === undefined) {
    throw new Error(
      `No outcome waiter for attempt '${attempt.executionAttemptId}': ` +
        `waiter was not installed during attempt creation`,
    );
  }

  // Dispatch can reject before this promise is awaited, while a concurrent
  // Authority terminalization can reject it. Keep that rejection owned until
  // the abandonment decision determines which path owns the attempt.
  void outcomePromise.catch(() => undefined);

  try {
    await dispatch(attempt.executionAttemptId);
  } catch (dispatchError) {
    return handleUnacknowledgedDispatchFailure({
      authority,
      executionId,
      executionAttemptId: attempt.executionAttemptId,
      outcomePromise,
      dispatchError,
    });
  }

  return outcomePromise;
}

interface UnacknowledgedDispatchFailureOptions<TOutcome> {
  readonly authority: ExecutionAttemptAuthority<TOutcome>;
  readonly executionId: ExecutionOwnerId;
  readonly executionAttemptId: string;
  readonly outcomePromise: Promise<TOutcome>;
  readonly dispatchError: unknown;
}

/**
 * Resolve a dispatch rejection that arrived before acknowledgement.
 *
 * `fenced` has no canonical outcome for this attempt: a newer attempt owns the
 * execution. Settle its waiter as fenced so this caller cannot retain an
 * unreachable waiter. `provisioning`, `allocated`, and `already-settled` instead retain the
 * waiter because the Authority still owns a canonical terminalization.
 * @param options - Failed dispatch and the Authority-owned attempt state.
 * @returns The canonical outcome when allocation or settlement won the race.
 */
async function handleUnacknowledgedDispatchFailure<TOutcome>(
  options: UnacknowledgedDispatchFailureOptions<TOutcome>,
): Promise<TOutcome> {
  const { authority, executionId, executionAttemptId, outcomePromise, dispatchError } = options;

  let abandonment: PendingAttemptAbandonmentDecision;
  try {
    abandonment = await authority.abandonPendingAttempt(executionAttemptId, executionId);
  } catch (abandonmentError) {
    // A failed durable decision cannot establish whether the attempt remains
    // active. The local waiter is no longer safely awaitable by this caller.
    authority.discardWaiter(executionAttemptId);
    throw new AggregateError(
      [dispatchError, abandonmentError],
      `Dispatch acknowledgement failed and pending attempt '${executionAttemptId}' could not be abandoned`,
      { cause: dispatchError },
    );
  }

  switch (abandonment.kind) {
    case 'abandoned':
    case 'already-abandoned':
      authority.discardWaiter(executionAttemptId);
      throw dispatchError;
    case 'allocated':
    case 'provisioning':
    case 'already-settled':
      return outcomePromise;
    case 'fenced':
      authority.settleOutcome(executionAttemptId, { kind: 'fenced' });
      try {
        return await outcomePromise;
      } catch (fenceError) {
        throw new AggregateError(
          [dispatchError, fenceError],
          `Dispatch acknowledgement failed after attempt '${executionAttemptId}' was fenced`,
          { cause: dispatchError },
        );
      }
  }
}
