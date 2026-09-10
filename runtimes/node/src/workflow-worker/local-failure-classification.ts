import type { ExecutionAttemptOutcome } from '@makaio/contracts';
import { isCooperativeCancellation } from '../cooperative-cancellation.js';
import type { LocalWorkspaceHandle } from '../workspace-preparation/workspace-preparation.js';

// Local classification of the invocation path's failures. Nothing here makes an
// Authority call: every function turns one locally observed fact into the
// terminal outcome the caller then submits.

/** Result shape returned by the local Workspace setup handle. */
export type LocalSetupStatus = Awaited<ReturnType<LocalWorkspaceHandle['runSetup']>>;

/**
 * Convert an unknown local failure to bounded non-secret diagnostics.
 * @param error - Local exception or rejected value.
 * @returns Bounded diagnostic text safe for the technical outcome.
 */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 8_192) || 'Local execution failed without a diagnostic message';
}

/**
 * Classify a completed local setup attempt without making any Authority call.
 * @param status - Local command completion status from the Workspace handle.
 * @returns Terminal outcome when setup cannot continue, otherwise undefined.
 */
export function setupFailureOutcome(status: LocalSetupStatus): ExecutionAttemptOutcome | undefined {
  if (status.status === 'completed') return undefined;
  if (status.status === 'cancelled') return { kind: 'cancelled' };
  if (status.status === 'stop-failed') {
    return { kind: 'technical-failure', stage: 'workspace-preparation', message: 'Workspace setup stop-failed' };
  }
  return {
    kind: 'technical-failure',
    stage: 'workspace-preparation',
    message: `Workspace setup ${status.status}`,
  };
}

/**
 * Classify a thrown local preparation failure without making any Authority call.
 * @param error - Local exception from binding the Workspace or running its setup.
 * @param signal - Workload-local cancellation signal the throw is judged against.
 * @returns Cooperative cancellation, or a bounded technical failure.
 */
export function preparationFailureOutcome(error: unknown, signal: AbortSignal): ExecutionAttemptOutcome {
  return isCooperativeCancellation(error, signal)
    ? { kind: 'cancelled' }
    : { kind: 'technical-failure', stage: 'workspace-preparation', message: errorMessage(error) };
}
