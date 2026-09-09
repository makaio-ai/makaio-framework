import type { IMakaioBus } from '@makaio/bus-core';
import {
  WorkerSubjects,
  WorkflowRunResultSchema,
  type OutcomeAckDecision,
  type OutcomeAcceptance,
} from '@makaio/contracts';
import type { BaseMessageContext } from '@makaio/core';
import { resolveExecutionAttemptPeer, type ExecutionAttemptPeerIdentity } from './execution-bound-access.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import { submitAttemptOutcome, type OutcomeConvergence, type OutcomeConvergenceInput } from './outcome-convergence.js';
import { registerExecutionAttemptHandlers, type ExecutionAttemptHandlersDeps } from './execution-attempt-handlers.js';
import { decodeWorkflowAttemptOutcome, type WorkflowAttemptOutcome } from './workflow-attempt-outcome.js';

// ─────────────────────────────────────────────────────────────
// Peer Context Resolution
// ─────────────────────────────────────────────────────────────

/**
 * Resolve authenticated attempt identity from bus message context.
 *
 * Remote callers are resolved through the subsystem's shared attempt-peer
 * derivation, so the identity comes from the authenticated peer rather than
 * the payload and a worker cannot impersonate another attempt.
 *
 * Local callers (the Authority process itself) are trusted and fall back
 * to the payload identity. This path exists because the executor may accept
 * outcomes through in-process composition seams.
 * @param ctx - Incoming bus message context.
 * @param payload - Outcome submission payload (used only for local callers).
 * @returns Resolved attempt identity, or `null` for unauthorized callers.
 */
function resolveAttemptIdentity(
  ctx: BaseMessageContext,
  payload: { executionAttemptId: string; executionId: string },
): ExecutionAttemptPeerIdentity | null {
  // Local callers (Authority process) are implicitly trusted.
  if (ctx.origin.local) {
    return {
      executionAttemptId: payload.executionAttemptId,
      executionId: payload.executionId,
    };
  }

  return resolveExecutionAttemptPeer(ctx);
}

// ─────────────────────────────────────────────────────────────
// Outcome Submission Dependencies
// ─────────────────────────────────────────────────────────────

/**
 * Dependencies for the outcome submission handler.
 */
export interface OutcomeSubmissionDeps {
  /** Message bus for storage and lifecycle requests. */
  readonly bus: IMakaioBus;
  /** Execution attempt Authority service. */
  readonly authority: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
  /**
   * Accept a canonical outcome under the executor's durable lifecycle ordering.
   * @param input - Correlated fact and its frozen control observation.
   * @returns Whether lifecycle projection occurred or the fact was only recorded.
   */
  readonly acceptOutcome: (input: OutcomeConvergenceInput<WorkflowAttemptOutcome>) => Promise<OutcomeAcceptance>;
}

// ─────────────────────────────────────────────────────────────
// Workflow Owner Adapter
// ─────────────────────────────────────────────────────────────

/**
 * Workflow-engine realization of the generic convergence port.
 *
 * Delegates to the executor's ordered owner decision. A fact can be accepted
 * without projecting lifecycle state when durable owner cancellation won.
 * The port receives the canonical committed copy, never the submitter's copy.
 */
class WorkflowOutcomeConvergence implements OutcomeConvergence<WorkflowAttemptOutcome> {
  public constructor(private readonly acceptOutcome: OutcomeSubmissionDeps['acceptOutcome']) {}

  /**
   * Converge workflow state with a committed outcome.
   * @param input - Attempt identity and the committed workflow result.
   * @returns The owner's explicit interpretation of the committed fact.
   */
  public converge(input: OutcomeConvergenceInput<WorkflowAttemptOutcome>): Promise<OutcomeAcceptance> {
    return this.acceptOutcome(input);
  }
}

/**
 * Compose one workflow-owner decoder and convergence port for both ingress paths.
 *
 * Identity validation reads the frozen instruction, never a mutable run-context
 * row. Canonical outcomes are committed before an owner finalizer runs.
 * @param deps - Shared Authority and idempotent owner finalizers.
 * @returns Generic Attempt handler dependencies for this workflow owner.
 */
export function createWorkflowOutcomeSubmissionDeps(
  deps: OutcomeSubmissionDeps,
): ExecutionAttemptHandlersDeps<WorkflowAttemptOutcome> {
  return {
    authority: deps.authority,
    decodeOutcome: decodeWorkflowAttemptOutcome,
    convergence: new WorkflowOutcomeConvergence(deps.acceptOutcome),
  };
}

// ─────────────────────────────────────────────────────────────
// Handler Registration
// ─────────────────────────────────────────────────────────────

/**
 * Register generic Attempt ingress and the workflow-only runner outcome endpoint.
 *
 * The workflow-only endpoint still serves the existing Piscina runner. Both
 * paths share the same instruction-bound decoder and canonical convergence.
 *
 * The handler:
 * 1. Derives attempt identity from the authenticated peer context.
 * 2. Validates the payload matches the peer identity.
 * 3. Commits the outcome through the Authority (durable repository decision).
 * 4. For `accepted` or `duplicate` terminal outcomes, converges workflow state
 *    through the executor's idempotent acceptance path.
 * 5. For `accepted` or `duplicate` paused outcomes, converges through the
 *    idempotent durable pause path.
 * 6. ACKs only after the durable Attempt decision and explicit owner acceptance
 *    succeed. Recorded-only acceptance does not manufacture a workflow transition.
 * @param bus - Authority-local workflow bus.
 * @param deps - Outcome submission dependencies.
 * @returns Cleanup function for handler deregistration.
 */
export function registerOutcomeSubmissionHandler(bus: IMakaioBus, deps: OutcomeSubmissionDeps): () => void {
  const submission = createWorkflowOutcomeSubmissionDeps(deps);
  const cleanupGeneric = registerExecutionAttemptHandlers(bus, submission);
  const cleanupWorkflow = bus.on(WorkerSubjects.control.outcome.submit, async (ctx) => {
    const identity = resolveAttemptIdentity(ctx, ctx.payload);
    if (identity === null) {
      throw new Error('Outcome submission requires an authenticated ' + 'workflow-execution-attempt peer');
    }

    const { result } = ctx.payload;

    // For remote callers, validate that payload identity matches the
    // authenticated peer. Local callers have identity derived from the
    // payload itself, so the check is skipped.
    if (!ctx.origin.local) {
      if (ctx.payload.executionId !== identity.executionId) {
        throw new Error(
          `Outcome payload executionId '${ctx.payload.executionId}' ` +
            `does not match authenticated peer claim ` +
            `'${identity.executionId}'`,
        );
      }
      if (ctx.payload.executionAttemptId !== identity.executionAttemptId) {
        throw new Error(
          `Outcome payload executionAttemptId ` +
            `'${ctx.payload.executionAttemptId}' does not match ` +
            `authenticated peer identity ` +
            `'${identity.executionAttemptId}'`,
        );
      }
    }

    // Security: the nested result.executionId must match the trusted identity.
    // The Zod superRefine on the schema enforces result.executionId === payload.executionId,
    // but schema validation is skipped when NODE_ENV=production. This handler-level
    // check is the security-critical enforcement that must always run.
    if (result.executionId !== identity.executionId) {
      throw new Error(
        `Nested result.executionId '${result.executionId}' does not match ` +
          `trusted identity '${identity.executionId}'`,
      );
    }

    // Parse the bus payload result through the Zod schema so the typed
    // WorkflowRunResult flows through without an unsafe cast. The bus
    // may skip schema validation in production, so this parse also
    // serves as a defense-in-depth structural check.
    const typedResult = WorkflowRunResultSchema.parse(result);
    const instruction = await deps.authority.getInstruction(identity);
    if (instruction === null) throw new Error('No instruction belongs to this workflow Attempt');
    const outcome = await submission.decodeOutcome({
      instruction,
      outcome: { kind: 'workload-result', result: typedResult },
    });

    // Validate, commit, converge (accepted/duplicate only), settle: the
    // generic owner boundary owns that order. A throwing convergence leaves
    // the outcome durably committed and the waiter pending, so the worker's
    // retry yields `duplicate` and converges again; the error propagates so
    // the RPC errors and the worker retries.
    const decision = await submitAttemptOutcome(submission, {
      executionId: identity.executionId,
      executionAttemptId: identity.executionAttemptId,
      outcome,
    });

    // ACK only after durable commit and convergence both succeeded.
    ctx.setResult({ decision: decisionToAck(decision) });
  });
  return () => {
    cleanupWorkflow();
    cleanupGeneric();
  };
}

/**
 * Map an internal repository decision kind to the bus ACK decision.
 * @param kind - Repository decision kind.
 * @returns Wire-compatible ACK decision.
 */
function decisionToAck(kind: 'accepted' | 'duplicate' | 'conflict' | 'fenced'): OutcomeAckDecision {
  return kind;
}
