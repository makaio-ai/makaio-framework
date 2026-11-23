import { isInProcessCaller, MAKAIO_JOB_RUN_PARTY_KIND, type BaseMessageContext } from '@makaio/core';

/**
 * Authenticated dispatch identity carried by a remote workflow worker.
 *
 * Both fields are derived from the call context's caller, which the receiving
 * transport established — never from the request payload — so a worker cannot
 * claim another attempt or another execution.
 */
export interface ExecutionAttemptPeerIdentity {
  /** Authority-created attempt identifier (`call.caller.id`). */
  readonly executionAttemptId: string;
  /** Workflow execution identifier from the Authority-issued `executionId` claim. */
  readonly executionId: string;
}

/**
 * Resolve the authenticated attempt identity of a remote caller.
 *
 * This is the single derivation of "who is this worker" shared by every
 * execution-bound seam in the subsystem. A caller qualifies only when the
 * message's call context names a `makaio.job-run` caller
 * carrying both a non-empty attempt id and a non-empty Authority-issued
 * `executionId` claim.
 *
 * An in-process caller is deliberately not considered here: each seam decides what a
 * trusted local caller may do with the identity it already owns.
 * @param ctx - Incoming message context.
 * @returns Resolved attempt identity, or `null` when the caller is not an execution-attempt party.
 */
export function resolveExecutionAttemptPeer(ctx: BaseMessageContext): ExecutionAttemptPeerIdentity | null {
  const { caller } = ctx.call;
  if (caller.kind !== MAKAIO_JOB_RUN_PARTY_KIND) return null;

  const executionAttemptId = caller.id;
  const executionId = caller.claims?.['executionId'];
  if (typeof executionAttemptId !== 'string' || executionAttemptId.length === 0) return null;
  if (typeof executionId !== 'string' || executionId.length === 0) return null;
  return { executionAttemptId, executionId };
}

/**
 * Determine whether a caller may access a single workflow execution.
 *
 * In-process callers are trusted. Any other caller is admitted only when its
 * call context names that exact execution's dispatch attempt — never on a
 * caller-supplied identifier. Transport-level encryption and id equality are
 * not evidence of that binding: any caller kind other than
 * `makaio.job-run` is denied here regardless of how it
 * connected.
 * @param ctx - Incoming message context.
 * @param executionId - Execution identifier requested by the caller.
 * @returns Whether the caller may access the requested execution.
 */
export function isExecutionBoundAccessAllowed(ctx: BaseMessageContext, executionId: string): boolean {
  if (isInProcessCaller(ctx.call)) return true;
  return resolveExecutionAttemptPeer(ctx)?.executionId === executionId;
}
