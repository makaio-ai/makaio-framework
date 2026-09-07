import type { IMakaioBus } from '@makaio/bus-core';
import {
  WorkerSubjects,
  WorkflowRunResultSchema,
  type OutcomeAckDecision,
  type WorkflowExecution,
  type WorkflowRunResult,
} from '@makaio/contracts';
import type { BaseMessageContext } from '@makaio/core';
import { resolveExecutionAttemptPeer, type ExecutionAttemptPeerIdentity } from './execution-bound-access.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import { submitAttemptOutcome, type OutcomeConvergence, type OutcomeConvergenceInput } from './outcome-convergence.js';
import { registerExecutionAttemptHandlers, type ExecutionAttemptHandlersDeps } from './execution-attempt-handlers.js';
import {
  decodeWorkflowAttemptOutcome,
  type WorkflowAttemptCancellation,
  type WorkflowAttemptOutcome,
  type WorkflowAttemptTechnicalFailure,
} from './workflow-attempt-outcome.js';
import { isAcceptedRunnerResultStatus } from './workflow-execution-finalizer.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { WorkflowSubjects } from './namespace.js';

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
   * Accept a terminal runner result through the executor's idempotent
   * workflow-state convergence path.
   * @param executionId - Durable authority-owned execution identity.
   * @param result - Correlated terminal runner result.
   * @returns The durable status after acceptance.
   */
  readonly acceptTerminalResult: (
    executionId: string,
    result: WorkflowRunResult,
  ) => Promise<{ accepted: boolean; status: WorkflowExecution['status'] }>;
  /**
   * Fail the owner execution after a technical outcome has already committed.
   * This must use the owner's idempotent finalizer, not resubmit a made-up workflow result.
   * @param executionId - Durable workflow execution that owns the Attempt.
   * @param failure - Canonical technical failure retained in Attempt storage.
   * @returns The durable owner status after acceptance.
   */
  readonly acceptTechnicalFailure: (
    executionId: string,
    failure: WorkflowAttemptTechnicalFailure,
  ) => Promise<{ accepted: boolean; status: WorkflowExecution['status'] }>;
  /**
   * Finalize the owner only after the Runtime's confirmed stop has committed.
   * @param executionId - Durable workflow execution that owns the Attempt.
   * @param cancellation - Canonical cancellation retained in Attempt storage.
   * @returns The durable owner status after acceptance.
   */
  readonly acceptCancellation: (
    executionId: string,
    cancellation: WorkflowAttemptCancellation,
  ) => Promise<{ accepted: boolean; status: WorkflowExecution['status'] }>;
}

// ─────────────────────────────────────────────────────────────
// Pause Convergence
// ─────────────────────────────────────────────────────────────

/**
 * Converge durable workflow state for a paused outcome.
 *
 * Parks the execution in storage and emits the paused lifecycle event.
 * Idempotent: when storage is already paused the event is not re-emitted.
 *
 * The `executionId` parameter is the trusted identity derived from the
 * authenticated peer or the authority payload — never from the untrusted
 * `result` object — so downstream storage and lifecycle paths cannot be
 * redirected to a different execution.
 * @param bus - Authority-local workflow bus.
 * @param executionId - Trusted execution identity from the peer validation.
 * @param result - Paused workflow result with gate identity.
 */
async function convergePausedState(bus: IMakaioBus, executionId: string, result: WorkflowRunResult): Promise<void> {
  if (result.pausedAtGateId === undefined || result.pausedAtFrameId === undefined) {
    throw new Error(`Paused outcome for '${executionId}' is missing gate identity`);
  }
  const { paused } = await bus.request(WorkflowStorageSubjects.pauseRunningExecution, {
    executionId,
  });
  if (!paused) {
    // Idempotent: check if already paused.
    const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, { executionId });
    if (execution?.status !== 'paused') {
      throw new Error(`Failed to park execution '${executionId}': ` + `status is '${execution?.status ?? 'missing'}'`);
    }
    return;
  }
  await bus.emit(WorkflowSubjects.execution.paused, {
    executionId,
    workflowId: result.workflowId,
    pausedAtGateId: result.pausedAtGateId,
    pausedAtFrameId: result.pausedAtFrameId,
  });
}

// ─────────────────────────────────────────────────────────────
// Workflow Owner Adapter
// ─────────────────────────────────────────────────────────────

/**
 * Workflow-engine realization of the generic convergence port.
 *
 * Dispatches on the committed outcome: a `paused` result parks the execution
 * through durable suspension, workflow results use terminal acceptance, and
 * runtime failures and cancellations use their owner finalizers. All branches
 * read the canonical committed copy the port hands over, never the submitter's copy.
 */
class WorkflowOutcomeConvergence implements OutcomeConvergence<WorkflowAttemptOutcome> {
  public constructor(
    private readonly bus: IMakaioBus,
    private readonly acceptTerminalResult: OutcomeSubmissionDeps['acceptTerminalResult'],
    private readonly acceptTechnicalFailure: OutcomeSubmissionDeps['acceptTechnicalFailure'],
    private readonly acceptCancellation: OutcomeSubmissionDeps['acceptCancellation'],
  ) {}

  /**
   * Converge workflow state with a committed outcome.
   * @param input - Attempt identity and the committed workflow result.
   */
  public async converge(input: OutcomeConvergenceInput<WorkflowAttemptOutcome>): Promise<void> {
    // Canonical outcomes are schema-decoded: workflow results reject `kind`;
    // only runtime failure and cancellation outcomes carry it.
    if ('kind' in input.outcome) {
      if (input.outcome.kind === 'cancelled') {
        const accepted = await this.acceptCancellation(input.executionId, input.outcome);
        if (!accepted.accepted || accepted.status !== 'cancelled') {
          throw new Error(`Cancellation did not converge workflow execution '${input.executionId}'`);
        }
        return;
      }
      const accepted = await this.acceptTechnicalFailure(input.executionId, input.outcome);
      if (!accepted.accepted || (accepted.status !== 'failed' && accepted.status !== 'cancelled')) {
        throw new Error(`Technical failure did not converge workflow execution '${input.executionId}'`);
      }
      return;
    }
    if (input.outcome.status === 'paused') {
      await convergePausedState(this.bus, input.executionId, input.outcome);
      return;
    }
    const accepted = await this.acceptTerminalResult(input.executionId, input.outcome);
    if (!accepted.accepted || !isAcceptedRunnerResultStatus(accepted.status, input.outcome.status)) {
      throw new Error(`Workflow result did not converge execution '${input.executionId}'`);
    }
  }
}

/**
 * Compose one workflow-owner decoder and convergence port for both ingress paths.
 *
 * Identity validation reads the frozen instruction, never a mutable run-context
 * row. Canonical outcomes are committed before an owner finalizer runs.
 * @param bus - Authority-local workflow bus used for pause convergence.
 * @param deps - Shared Authority and idempotent owner finalizers.
 * @returns Generic Attempt handler dependencies for this workflow owner.
 */
export function createWorkflowOutcomeSubmissionDeps(
  bus: IMakaioBus,
  deps: OutcomeSubmissionDeps,
): ExecutionAttemptHandlersDeps<WorkflowAttemptOutcome> {
  return {
    authority: deps.authority,
    decodeOutcome: decodeWorkflowAttemptOutcome,
    convergence: new WorkflowOutcomeConvergence(
      bus,
      deps.acceptTerminalResult,
      deps.acceptTechnicalFailure,
      deps.acceptCancellation,
    ),
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
 * 6. ACKs only after both the durable attempt decision and the workflow
 *    transition succeed.
 * @param bus - Authority-local workflow bus.
 * @param deps - Outcome submission dependencies.
 * @returns Cleanup function for handler deregistration.
 */
export function registerOutcomeSubmissionHandler(bus: IMakaioBus, deps: OutcomeSubmissionDeps): () => void {
  const submission = createWorkflowOutcomeSubmissionDeps(bus, deps);
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
