import type { BaseMessageContext } from '@makaio/core';

/**
 * Determine whether a caller may access a single workflow execution.
 *
 * Local callers are trusted. Remote callers must present an authenticated
 * identity that is bound to the requested execution; attempt identities carry
 * that binding in their Authority-issued `executionId` claim. Encrypted relay
 * identities remain a separate execution-bound transport mechanism.
 * @param ctx - Incoming message context.
 * @param executionId - Execution identifier requested by the caller.
 * @returns Whether the caller may access the requested execution.
 */
export function isExecutionBoundAccessAllowed(ctx: BaseMessageContext, executionId: string): boolean {
  if (ctx.origin.local) return true;

  const peer = ctx.transport?.peer;
  if (peer?.authenticated !== true) return false;
  if (peer.kind === 'workflow-execution-attempt' && peer.claims?.['executionId'] === executionId) return true;
  return peer.kind === 'e2e' && peer.encrypted === true && peer.id === executionId;
}
