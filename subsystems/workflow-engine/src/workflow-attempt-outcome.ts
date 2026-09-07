import { z } from 'zod';
import {
  ExecutionAttemptOutcomeSchema,
  WorkflowRunResultSchema,
  type ExecutionAttemptOutcome,
  type WorkflowRunResult,
} from '@makaio/contracts';
import type { AttemptOutcomeDecodingInput } from './execution-attempt-handlers.js';
import type { OutcomeCodec } from './execution-attempt-repository.js';
import { parseWorkflowAttemptInstruction } from './workflow-attempt-instruction.js';

/** Technical failure retained as such rather than fabricated into a workflow-produced result. */
export type WorkflowAttemptTechnicalFailure = Extract<ExecutionAttemptOutcome, { kind: 'technical-failure' }>;

/** Confirmed cooperative stop retained independently of a workflow-produced result. */
export type WorkflowAttemptCancellation = Extract<ExecutionAttemptOutcome, { kind: 'cancelled' }>;

/** Canonical owner outcome: a workflow result, infrastructure failure, or confirmed cancellation. */
export type WorkflowAttemptOutcome = WorkflowRunResult | WorkflowAttemptTechnicalFailure | WorkflowAttemptCancellation;

const runtimeOutcomeSchema = ExecutionAttemptOutcomeSchema.transform((outcome, ctx) => {
  if (outcome.kind === 'technical-failure' || outcome.kind === 'cancelled') return outcome;
  ctx.addIssue({ code: 'custom', message: 'Expected a runtime outcome, not an opaque workload result' });
  return z.NEVER;
});

/** Production codec schema for workflow-owned Attempt outcomes. */
export const WorkflowAttemptOutcomeSchema = z.union([WorkflowRunResultSchema, runtimeOutcomeSchema]);

/** Durable workflow-owner codec; generic Attempt persistence does not interpret owner outcomes. */
export const workflowAttemptOutcomeCodec: OutcomeCodec<WorkflowAttemptOutcome> = {
  parse: (input) => WorkflowAttemptOutcomeSchema.parse(input),
  serialize: (outcome) => JSON.stringify(outcome),
};

/**
 * Interpret a generic terminal report against its immutable workflow assignment.
 * @param input - Frozen assignment and the Runtime's generic outcome report.
 * @returns An owner-typed outcome to canonicalize, commit, and then converge.
 */
export function decodeWorkflowAttemptOutcome(input: AttemptOutcomeDecodingInput): WorkflowAttemptOutcome {
  const report = ExecutionAttemptOutcomeSchema.parse(input.outcome);
  // Input rejection itself can produce a startup failure. Runtime outcomes
  // settle through the generic Attempt fences without re-decoding that input.
  if (report.kind === 'technical-failure' || report.kind === 'cancelled') return report;
  const invocation = parseWorkflowAttemptInstruction(input.instruction);
  const result = WorkflowRunResultSchema.parse(report.result);
  if (result.executionId !== invocation.executionId || result.workflowId !== invocation.workflowId) {
    throw new Error('Workflow result identity does not match the frozen instruction');
  }
  return result;
}

/** Workflow identity used to project an already-converged runtime outcome to a runner completion. */
export interface CommittedWorkflowOutcomeIdentity {
  /** Workflow execution whose state has already converged. */
  readonly executionId: string;
  /** Workflow definition that owns that execution. */
  readonly workflowId: string;
}

/**
 * Project an already committed and converged outcome for the workflow runner API.
 *
 * This is an owner status projection, not a result to submit or persist. A
 * runtime outcome retains its own kind in Attempt storage; the WorkflowExecution
 * has already converged before this helper is called.
 * @param outcome - Canonical outcome returned after owner convergence.
 * @param identity - Immutable identity of the converged workflow execution.
 * @returns Workflow status used by the runner's authority-committed completion.
 */
export function toCommittedWorkflowRunnerResult(
  outcome: WorkflowAttemptOutcome,
  identity: CommittedWorkflowOutcomeIdentity,
): WorkflowRunResult {
  if ('kind' in outcome) {
    if (outcome.kind === 'cancelled') {
      return {
        executionId: identity.executionId,
        workflowId: identity.workflowId,
        status: 'cancelled',
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      };
    }
    return {
      executionId: identity.executionId,
      workflowId: identity.workflowId,
      status: 'failed',
      error: `${outcome.stage}: ${outcome.message}`,
    };
  }
  if (outcome.executionId !== identity.executionId || outcome.workflowId !== identity.workflowId) {
    throw new Error('Committed workflow result does not match its owner identity');
  }
  return WorkflowRunResultSchema.parse(outcome);
}
