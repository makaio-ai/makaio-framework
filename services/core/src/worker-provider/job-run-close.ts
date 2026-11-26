import { isDeepStrictEqual } from 'node:util';
import { isMintedCallContext } from '@makaio/bus-core';
import {
  JobRunEndingSchema,
  OutcomeSubmitResponseSchema,
  type CloseJobRunInput,
  type HostDatabase,
  type HostTransaction,
  type JobRunCapability,
  type JobRunErrorCode,
  type JobRunResult,
} from '@makaio/contracts';
import { CorePartyKind, type CallContext } from '@makaio/core';
import {
  checkHostTransactionCommit,
  getHostTransactionQueryContext,
  markTransactionRollbackOnly,
} from '@makaio/storage-drizzle';
import { deepFreeze } from '@makaio/utils';
import type { CommittedWorkerOrder, WorkerOrderClose, WorkerOrderSource } from './start-order.js';

/** A close refusal on the host's authoritative run storage. */
export class JobRunCloseError extends Error {
  /** @param code - Stable reason for refusing the close. */
  public constructor(public readonly code: JobRunErrorCode) {
    super(code);
    this.name = 'JobRunCloseError';
  }
}

export interface JobRunCloseAuthority {
  readonly database: HostDatabase;
  readonly source: WorkerOrderSource;
}

export interface JobRunAcceptanceBinding {
  readonly call: CallContext;
  readonly result: Readonly<JobRunResult>;
  readonly noteClose: (tx: HostTransaction) => void;
}

export interface JobRunOwnerBinding {
  readonly name: string;
  readonly generation: AbortSignal;
  readonly isActive: () => boolean;
}

/**
 * Verify a run's authenticated caller against the durable redemption identity.
 * @param order - Fresh locked order.
 * @param call - Trusted call from the bus.
 * @returns Whether the identity still matches the owner record.
 */
export function matchesRunProof(order: CommittedWorkerOrder, { caller }: CallContext): boolean {
  const { redemption } = order;
  const stored = redemption?.stored?.accepted;
  return (
    redemption?.tokenRevoked === false &&
    stored?.party.kind === caller.kind &&
    stored.party.id === caller.id &&
    Date.parse(stored.expiresAt) > Date.now()
  );
}

/**
 * Validate result timing against the owner's authoritative snapshot.
 * @param order - Fresh locked order.
 * @param result - Authenticated result proposed for close.
 * @param now - Current host time.
 */
export function checkResultWindow(order: CommittedWorkerOrder, result: JobRunResult, now = Date.now()): void {
  const deadline = Date.parse(order.outcome?.resultDeadlineAt ?? '');
  const cancellation = order.outcome?.cancellationDeadlineAt;
  const effectiveDeadline = cancellation === undefined ? deadline : Math.min(deadline, Date.parse(cancellation));
  if (order.state !== 'redeemed' || !(now < effectiveDeadline)) throw new JobRunCloseError('run-not-running');
  if ((result.status === 'cancelled') !== (cancellation !== undefined)) throw new JobRunCloseError('ending-invalid');
}

/**
 * Mark an owner's live transaction rollback-only before propagating a failed close.
 * @param tx - Transaction checked against the host database.
 * @param error - Failure raised by close.
 */
function failClose(tx: HostTransaction, error: unknown): never {
  markTransactionRollbackOnly(tx, error instanceof Error ? error : new Error('Job run close failed', { cause: error }));
  throw error;
}

/**
 * Prepare the immutable update before the first storage wait.
 * @param call - Invocation call being authorized.
 * @param input - Terminal operation requested by the extension.
 * @param owner - Exact recorded owner.
 * @param binding - Authenticated result invocation, when present.
 * @returns Detached terminal data to persist.
 */
function prepareUpdate(
  call: CallContext,
  { jobRunId, ending: requested, answer }: CloseJobRunInput,
  owner: string,
  binding?: JobRunAcceptanceBinding,
): WorkerOrderClose {
  const ending = JobRunEndingSchema.parse(requested);
  if (ending.kind === 'no-result') {
    if (binding !== undefined || !isOwnerCall(call, owner)) throw new JobRunCloseError('not-acceptance-owner');
    if (answer !== undefined) throw new JobRunCloseError('ending-invalid');
    return ending;
  }
  if (ending.result.jobRunId !== jobRunId) throw new JobRunCloseError('result-run-mismatch');
  if (binding?.call !== call || !isDeepStrictEqual(binding.result, ending.result)) {
    throw new JobRunCloseError('not-acceptance-owner');
  }
  const receipt = OutcomeSubmitResponseSchema.parse({ decision: 'accepted', answer });
  if (receipt.decision !== 'accepted') throw new JobRunCloseError('ending-invalid');
  return { kind: 'result', receipt: { result: ending.result, answer: receipt.answer } };
}

/**
 * Bind terminal writes to the owning extension and, for a result, one authenticated invocation.
 * @param authority - Shared host database and authoritative order repository.
 * @param owner - Exact extension and activation supplied by the coordinator.
 * @param binding - Authenticated result and original call for an outcome acceptance.
 * @returns The generation-bound close capability.
 */
export function bindJobRunClose(
  authority: JobRunCloseAuthority,
  owner: JobRunOwnerBinding,
  binding?: JobRunAcceptanceBinding,
): JobRunCapability {
  const checkGeneration = () => {
    if (owner.generation.aborted || !owner.isActive()) throw new JobRunCloseError('engine-not-active');
  };
  return {
    async close(call, input) {
      const { tx, jobRunId } = input;
      getHostTransactionQueryContext(authority.database, tx);
      try {
        checkGeneration();
        const update = deepFreeze(prepareUpdate(call, input, owner.name, binding));
        const order = await authority.source.lockOrder(tx, jobRunId, owner.generation);
        checkGeneration();
        if (order?.order.jobRunId !== jobRunId) throw new JobRunCloseError('run-unknown');
        if (order.owner.kind !== CorePartyKind.extension || order.owner.id !== owner.name) {
          throw new JobRunCloseError('not-acceptance-owner');
        }
        const checkCommit = () => {
          checkGeneration();
          if (update.kind === 'result') {
            checkResultWindow(order, update.receipt.result);
            if (!matchesRunProof(order, call)) throw new JobRunCloseError('not-acceptance-owner');
          } else if (
            order.state === 'redeemed' &&
            (update.outcome === 'cancelled') !== (order.outcome?.cancellationDeadlineAt !== undefined)
          ) {
            throw new JobRunCloseError('ending-invalid');
          }
        };
        if (update.kind === 'result') {
          if (order.outcome?.stored !== undefined) throw new JobRunCloseError('outcome-already-stored');
          if (!matchesRunProof(order, call)) throw new JobRunCloseError('not-acceptance-owner');
        }
        checkCommit();
        if (order.state === 'closed' || !(await order.outcome?.accept(tx, update))) {
          throw new JobRunCloseError('run-not-running');
        }
        checkHostTransactionCommit(tx, checkCommit);
        binding?.noteClose(tx);
      } catch (error) {
        failClose(tx, error);
      }
    },
  };
}

/**
 * Check a no-result request against the extension carrier rather than its principal.
 * @param call - Extension's own call.
 * @param owner - Name recorded for this close capability.
 * @returns Whether the owning extension made the call.
 */
function isOwnerCall(call: CallContext, owner: string): boolean {
  return isMintedCallContext(call) && call.caller.kind === CorePartyKind.extension && call.caller.id === owner;
}
