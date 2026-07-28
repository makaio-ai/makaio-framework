import type { BaseMessageContext } from '@makaio/core';

/**
 * Authenticated dispatch identity carried by a remote workflow worker.
 *
 * Both fields are derived from the transport peer the receiving transport
 * authenticated — never from the request payload — so a worker cannot claim
 * another attempt or another execution.
 */
export interface ExecutionAttemptPeerIdentity {
  /** Authority-created attempt identifier (`peer.id`). */
  readonly executionAttemptId: string;
  /** Workflow execution identifier from the Authority-issued `executionId` claim. */
  readonly executionId: string;
}

/**
 * Resolve the authenticated attempt identity of a remote caller.
 *
 * This is the single derivation of "who is this worker" shared by every
 * execution-bound seam in the subsystem. A caller qualifies only when the
 * receiving transport authenticated it as a `workflow-execution-attempt` peer
 * carrying both a non-empty attempt id and a non-empty Authority-issued
 * `executionId` claim.
 *
 * Local origin is deliberately not considered here: each seam decides what a
 * trusted local caller may do with the identity it already owns.
 * @param ctx - Incoming message context.
 * @returns Resolved attempt identity, or `null` when the caller is not an authenticated attempt peer.
 */
export function resolveExecutionAttemptPeer(ctx: BaseMessageContext): ExecutionAttemptPeerIdentity | null {
  const peer = ctx.transport?.peer;
  if (peer?.authenticated !== true || peer.kind !== 'workflow-execution-attempt') return null;

  const executionAttemptId = peer.id;
  const executionId = peer.claims?.['executionId'];
  if (typeof executionAttemptId !== 'string' || executionAttemptId.length === 0) return null;
  if (typeof executionId !== 'string' || executionId.length === 0) return null;
  return { executionAttemptId, executionId };
}

/**
 * Determine whether a caller may access a single workflow execution.
 *
 * Local callers are trusted. A remote caller is admitted only when the
 * receiving transport independently authenticated it as that exact execution's
 * dispatch attempt — never on a caller-supplied identifier. Transport-level
 * encryption and peer-id equality are not evidence of that binding: any peer
 * kind other than `workflow-execution-attempt` is denied here regardless of how
 * it authenticated.
 * @param ctx - Incoming message context.
 * @param executionId - Execution identifier requested by the caller.
 * @returns Whether the caller may access the requested execution.
 */
export function isExecutionBoundAccessAllowed(ctx: BaseMessageContext, executionId: string): boolean {
  if (ctx.origin.local) return true;
  return resolveExecutionAttemptPeer(ctx)?.executionId === executionId;
}
