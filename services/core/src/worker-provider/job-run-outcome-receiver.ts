import { isDeepStrictEqual } from 'node:util';
import { isMintedCallContext, type IMakaioBus } from '@makaio/bus-core';
import {
  JobRunOutcomeNamespace,
  OutcomeSubmitRequestSchema,
  OutcomeSubmitResponseSchema,
  type HostTransaction,
  type JobRunOutcomeHandler,
  type JobRunOwnerDecision,
  type JobRunResult,
  type OutcomeSubmitResponse,
} from '@makaio/contracts';
import {
  CorePartyKind,
  ExtensionNameSchema,
  type CallContext,
  type ExtensionName,
  type TransportReceiveContext,
  type TransportRequestOrigin,
} from '@makaio/core';
import type { ContributionProcessor } from '@makaio/kernel';
import { didHostTransactionCommit } from '@makaio/storage-drizzle';
import { deepFreeze } from '@makaio/utils';
import {
  bindJobRunClose,
  checkResultWindow,
  JobRunCloseError,
  matchesRunProof,
  type JobRunCloseAuthority,
  type JobRunOwnerBinding,
} from './job-run-close.js';
import type { StoredJobRunOutcome } from './start-order.js';

interface ActiveOutcomeOwner extends JobRunOwnerBinding {
  readonly name: ExtensionName;
  readonly handle: JobRunOutcomeHandler;
}

const unavailable = { decision: 'refused', code: 'owner-unavailable', retryable: true } as const;
const notOwnRun = { decision: 'refused', code: 'not-own-job-run', retryable: false } as const;
const notRunning = { decision: 'refused', code: 'run-not-running', retryable: false } as const;

/**
 * Resolve a fresh run snapshot or a durable replay response under the owner lock.
 * The short host transaction is released before executing an extension handler.
 * @param authority - Shared database and order source.
 * @param call - Authenticated worker call.
 * @param result - Validated outcome bound to the caller.
 * @returns An immediate refusal or replay, or the booking to deliver.
 */
async function readOutcome(authority: JobRunCloseAuthority, call: CallContext, result: JobRunResult) {
  return authority.database.transaction(async (tx) => {
    const locked = await authority.source.lockOrder(tx, result.jobRunId);
    if (locked === undefined)
      return { response: { decision: 'refused', code: 'run-unknown', retryable: false } } as const;
    if (!matchesRunProof(locked, call)) return { response: notOwnRun };
    const stored = locked.outcome?.stored;
    if (stored !== undefined) return { response: replay(stored, result) };
    if (locked.outcome === undefined) return { response: unavailable };
    try {
      checkResultWindow(locked, result);
    } catch (error) {
      if (error instanceof JobRunCloseError) return { response: notRunning };
      throw error;
    }
    if (locked.owner.kind !== CorePartyKind.extension) return { response: unavailable };
    return { owner: locked.owner.id, order: deepFreeze(structuredClone(locked.order)) };
  });
}

/**
 * Resolve a receipt without treating identity ending in the committing transaction as a failed first ACK.
 * This is only used inside the already authenticated first invocation.
 * @param authority - Shared database and order source.
 * @param result - Authenticated result identifying the run.
 * @returns The receipt on the closed row, if one committed.
 */
async function readCommittedReceipt(authority: JobRunCloseAuthority, result: JobRunResult) {
  return authority.database.transaction(async (tx) => {
    const locked = await authority.source.lockOrder(tx, result.jobRunId);
    return locked?.state === 'closed' && locked.order.jobRunId === result.jobRunId
      ? structuredClone(locked.outcome?.stored)
      : undefined;
  });
}

/**
 * Classify a submission against the full validated result in the receipt.
 * @param stored - Durable first result and response.
 * @param result - Current validated submission.
 * @returns The original answer or a final conflict.
 */
function replay(stored: StoredJobRunOutcome, result: JobRunResult): OutcomeSubmitResponse {
  return isDeepStrictEqual(stored.result, result)
    ? { decision: 'duplicate', answer: structuredClone(stored.answer) }
    : { decision: 'refused', code: 'outcome-conflict', retryable: false };
}

/**
 * Require an authenticated job-run caller, independent of any declared principal.
 * Legacy execution credentials carry an execution claim and use their own protocol.
 * @param call - Call minted by the bus from transport identity.
 * @param transport - Locally verified receive context.
 * @returns Whether the transport authenticated the actual ordered worker.
 */
function isOrderedRunCall(call: CallContext, transport?: TransportReceiveContext): boolean {
  return (
    transport?.authenticated === true &&
    transport.caller?.kind === CorePartyKind.jobRun &&
    transport.caller.id === call.caller.id &&
    isMintedCallContext(call) &&
    call.caller.kind === CorePartyKind.jobRun &&
    call.caller.claims?.executionId === undefined &&
    call.attestedBy === undefined
  );
}

/**
 * Compose the receiver and the activation registry that supplies its owner handlers.
 * @param authority - Shared storage used by order redemption and close.
 * @returns Registration and owner contribution lifecycle.
 */
export function createJobRunOutcomeReceiver(authority: JobRunCloseAuthority) {
  const owners = new Map<string, ActiveOutcomeOwner>();
  const contributionProcessor: ContributionProcessor = {
    filter: (pkg) => pkg.jobRunOutcomes !== undefined,
    async processActivated(name, pkg, ctx, generation) {
      const contribution = pkg.jobRunOutcomes;
      if (contribution === undefined) return;
      if (generation === undefined) throw new Error('Job run outcome owner requires an activation generation');
      const owner = ExtensionNameSchema.parse(name);
      const active = { name: owner, generation, isActive: () => ctx.hasExtension(owner) };
      const handle = await contribution.createHandler(ctx, bindJobRunClose(authority, active));
      generation.throwIfAborted();
      owners.set(owner, { ...active, handle });
    },
    async processStopped(name) {
      owners.delete(name);
    },
  };

  return {
    contributionProcessor,
    /**
     * Install the sole receiver on this host bus.
     * @param bus - Host authority, with the contract namespace registered.
     * @returns Cleanup removing the handler.
     */
    register(bus: IMakaioBus) {
      return bus.on(
        JobRunOutcomeNamespace.subjects.outcome.submit,
        async ({ call, payload, setResult, transport }) => {
          if (!isOrderedRunCall(call, transport)) {
            setResult(notOwnRun);
            return;
          }
          const parsed = OutcomeSubmitRequestSchema.safeParse(payload);
          if (!parsed.success) {
            setResult({ decision: 'refused', code: 'outcome-invalid', retryable: false });
            return;
          }
          const result = deepFreeze(parsed.data.result);
          if (result.jobRunId !== call.caller.id) {
            setResult(notOwnRun);
            return;
          }
          const run = await readOutcome(authority, call, result);
          if (run.response !== undefined) {
            setResult(run.response);
            return;
          }
          const owner = owners.get(run.owner);
          setResult(
            owner === undefined || owner.generation.aborted || !owner.isActive()
              ? unavailable
              : await invokeOwner(authority, owner, call, result, run.order, transport?.requestOrigin),
          );
        },
        { exclusive: true },
      );
    },
  };
}

/**
 * Run owner code without a held framework lock and verify its committed receipt.
 * @param authority - Shared order storage.
 * @param owner - Contribution for the exact recorded owner and generation.
 * @param call - Original authenticated call.
 * @param result - Immutable validated result.
 * @param order - Immutable booking seen before invoking the owner.
 * @param reply - Response route for the authenticated request.
 * @returns The committed answer or a typed refusal.
 */
async function invokeOwner(
  authority: JobRunCloseAuthority,
  owner: ActiveOutcomeOwner,
  call: CallContext,
  result: JobRunResult,
  order: Parameters<JobRunOutcomeHandler>[0]['order'],
  reply?: TransportRequestOrigin,
): Promise<OutcomeSubmitResponse> {
  const invocation = new AbortController();
  const signal = AbortSignal.any([owner.generation, invocation.signal]);
  const handledTransactions = new Set<HostTransaction>();
  const jobRuns = bindJobRunClose(
    authority,
    { ...owner, generation: signal },
    {
      call,
      result,
      reply,
      noteClose: (tx) => {
        handledTransactions.add(tx);
      },
    },
  );
  let completion: { decision: JobRunOwnerDecision } | { error: unknown };
  try {
    completion = { decision: await owner.handle({ call, result, order, jobRuns, signal }) };
  } catch (error) {
    completion = { error };
  } finally {
    invocation.abort();
  }
  // The committed receipt is authoritative for both returned and thrown owner completions.
  if ([...handledTransactions].some(didHostTransactionCommit)) {
    const stored = await readCommittedReceipt(authority, result);
    if (stored === undefined || !isDeepStrictEqual(stored.result, result)) {
      throw new Error('Outcome owner accepted without a matching committed receipt');
    }
    if ('error' in completion) console.error('[JobRunOutcomeReceiver] Owner threw after committing the outcome');
    return { decision: 'accepted', answer: stored.answer };
  }
  if ('error' in completion) {
    const { error } = completion;
    if (!(error instanceof JobRunCloseError)) throw error;
    if (error.code === 'outcome-already-stored') {
      const stored = await readCommittedReceipt(authority, result);
      if (stored !== undefined) return replay(stored, result);
    }
    if (error.code === 'engine-not-active') return unavailable;
    if (error.code === 'not-acceptance-owner') return notOwnRun;
    if (error.code === 'run-not-running' || error.code === 'ending-invalid') return notRunning;
    throw error;
  }
  const { decision } = completion;
  if (decision.decision === 'refused') {
    return OutcomeSubmitResponseSchema.parse({ ...decision, owner: owner.name });
  }
  throw new Error('Outcome owner accepted without committing the close');
}
