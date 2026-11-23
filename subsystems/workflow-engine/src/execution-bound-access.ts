import { isInProcessCaller, MAKAIO_JOB_RUN_PARTY_KIND, type BaseMessageContext } from '@makaio/core';

/** A run identity bound to the authenticated remote caller. */
export interface JobRunCallerIdentity {
  /** Workflow execution identifier from the Authority-issued claim. */
  readonly executionId: string;
}

/**
 * Resolve the job run claim established by the receiving transport.
 * @param ctx - Incoming message context.
 * @returns The execution identity if the caller carries its job run claim.
 */
export function resolveJobRunCaller(ctx: BaseMessageContext): JobRunCallerIdentity | null {
  const { caller } = ctx.call;
  if (caller.kind !== MAKAIO_JOB_RUN_PARTY_KIND) return null;
  const executionId = caller.claims?.['executionId'];
  if (typeof executionId !== 'string' || executionId.length === 0) return null;
  return { executionId };
}

/**
 * Determine whether a caller may access a single workflow execution.
 *
 * In-process callers are trusted. Remote callers must carry the exact
 * execution claim in their call context. The party identifier is opaque.
 * @param ctx - Incoming message context.
 * @param executionId - Execution identifier requested by the caller.
 * @returns Whether the caller may access the requested execution.
 */
export function isExecutionBoundAccessAllowed(ctx: BaseMessageContext, executionId: string): boolean {
  if (isInProcessCaller(ctx.call)) return true;
  return resolveJobRunCaller(ctx)?.executionId === executionId;
}
