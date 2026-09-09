import type { OutcomeAcceptance, WorkflowExecution, WorkflowRunResult } from '@makaio/contracts';
import type { OutcomeConvergenceInput } from './outcome-convergence.js';
import type {
  WorkflowAttemptCancellation,
  WorkflowAttemptOutcome,
  WorkflowAttemptTechnicalFailure,
} from './workflow-attempt-outcome.js';
import {
  isAcceptedRunnerResultStatus,
  recoverSuccessFinalizations,
  withExecutionDurableTransition,
  type FinalizerDeps,
} from './workflow-execution-finalizer.js';
import { parkExecution } from './workflow-execution-pause.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/** Existing workflow projections used only after owner policy permits them. */
export interface WorkflowOwnerOutcomeDeps {
  /** Shared owner lifecycle serialization and storage. */
  readonly lifecycle: FinalizerDeps;
  /** Accept a terminal workflow result through its existing finalizer. */
  readonly acceptTerminalResult: (
    executionId: string,
    result: WorkflowRunResult,
  ) => Promise<{ accepted: boolean; status: WorkflowExecution['status'] }>;
  /** Preserve a technical failure and converge its owner. */
  readonly acceptTechnicalFailure: (
    executionId: string,
    failure: WorkflowAttemptTechnicalFailure,
  ) => Promise<{ accepted: boolean; status: WorkflowExecution['status'] }>;
  /** Converge an observed cancellation, not a request to stop. */
  readonly acceptCancellation: (
    executionId: string,
    cancellation: WorkflowAttemptCancellation,
  ) => Promise<{ accepted: boolean; status: WorkflowExecution['status'] }>;
}

/**
 * Resolve an already terminal runner result through existing success-finalizer recovery.
 * @param deps - Owner storage and registered success finalizers.
 * @param execution - Durable execution read before result acceptance.
 * @param result - Correlated terminal workflow result.
 * @returns Compatible terminal status, or undefined for a not-yet-terminal owner.
 */
export async function resolveAuthorityRunnerReplay(
  deps: FinalizerDeps,
  execution: WorkflowExecution,
  result: WorkflowRunResult,
): Promise<WorkflowExecution['status'] | undefined> {
  if (execution.status === 'finalizing') {
    if (result.status !== 'completed') {
      throw new Error('authority runner result conflicts with terminal execution');
    }
    await recoverSuccessFinalizations(deps);
    const replayed = await deps.bus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id });
    if (!replayed.execution) throw new Error('Authority runner success finalization execution is missing');
    if (!isAcceptedRunnerResultStatus(replayed.execution.status, result.status)) {
      throw new Error('authority runner result conflicts with terminal execution');
    }
    return replayed.execution.status;
  }
  if (execution.status !== 'completed' && execution.status !== 'failed' && execution.status !== 'cancelled') {
    return undefined;
  }
  if (!isAcceptedRunnerResultStatus(execution.status, result.status))
    throw new Error('authority runner result conflicts with terminal execution');
  return execution.status;
}

/**
 * Read the owner after any already pending lifecycle decision has committed.
 * @param deps - Owner lifecycle dependencies.
 * @param input - Canonical correlated outcome and its immutable observation.
 * @returns Current durable owner state.
 */
async function readOwner(deps: FinalizerDeps, input: OutcomeConvergenceInput<WorkflowAttemptOutcome>) {
  return withExecutionDurableTransition(deps, input.executionId, async () => {
    const { execution } = await deps.bus.request(WorkflowStorageSubjects.getExecution, {
      executionId: input.executionId,
    });
    if (!execution) throw new Error(`Authority execution not found: ${input.executionId}`);
    if (
      !('kind' in input.outcome) &&
      (input.outcome.executionId !== execution.id || input.outcome.workflowId !== execution.workflowId)
    ) {
      throw new Error('authority outcome execution or workflow identity mismatch');
    }
    return execution;
  });
}

/**
 * Accept a technical fact without allowing it to reverse a durable owner Cancel.
 * The observation is frozen at commit; a later cleanup request never rewrites it.
 * @param deps - Existing owner projections and lifecycle ordering.
 * @param input - Canonical outcome, immutable control observation and identity.
 * @returns Whether this fact projected lifecycle state or was only recorded.
 */
export async function acceptWorkflowOwnerOutcome(
  deps: WorkflowOwnerOutcomeDeps,
  input: OutcomeConvergenceInput<WorkflowAttemptOutcome>,
): Promise<OutcomeAcceptance> {
  const owner = await readOwner(deps.lifecycle, input);
  const cancellation =
    'kind' in input.outcome ? input.outcome.kind === 'cancelled' : input.outcome.status === 'cancelled';
  if (owner.status === 'cancelled' && !cancellation) return 'recorded-only';
  if (
    !cancellation &&
    input.controlObservation !== null &&
    input.controlObservation.controlRevision > 0 &&
    (owner.status === 'running' || owner.status === 'paused')
  ) {
    // Attempt Cancel and owner Cancel are two durable writes. After an
    // interrupted second write, recovery must finish that decision first.
    // A real cancelled outcome can itself finish cancellation through its
    // existing finalizer; a success/failure fact cannot invent a stopped worker.
    throw new Error(`Workflow owner cancellation is not durably settled for '${input.executionId}'`);
  }
  const accepted = await projectOutcome(deps, input);
  // Projection functions use the same queue themselves. Do not hold its lock
  // while calling them: Cancel may win that gap and explicitly refuse projection.
  const settled = await readOwner(deps.lifecycle, input);
  if (settled.status === 'cancelled' && !cancellation) return 'recorded-only';
  if (!accepted) throw new Error(`Workflow outcome did not converge execution '${input.executionId}'`);
  return 'projected';
}

/**
 * Delegate to the existing owner projection without fabricating workflow results.
 * @param deps - Owner's projection callbacks.
 * @param input - Committed technical outcome.
 * @returns Whether the corresponding projection accepted the fact.
 */
async function projectOutcome(
  deps: WorkflowOwnerOutcomeDeps,
  input: OutcomeConvergenceInput<WorkflowAttemptOutcome>,
): Promise<boolean> {
  if ('kind' in input.outcome) {
    const accepted =
      input.outcome.kind === 'cancelled'
        ? await deps.acceptCancellation(input.executionId, input.outcome)
        : await deps.acceptTechnicalFailure(input.executionId, input.outcome);
    return (
      accepted.accepted &&
      (input.outcome.kind === 'cancelled'
        ? accepted.status === 'cancelled'
        : accepted.status === 'failed' || accepted.status === 'cancelled')
    );
  }
  if (input.outcome.status === 'paused') {
    return parkExecution(deps.lifecycle, input.outcome);
  }
  const accepted = await deps.acceptTerminalResult(input.executionId, input.outcome);
  return accepted.accepted && isAcceptedRunnerResultStatus(accepted.status, input.outcome.status);
}
