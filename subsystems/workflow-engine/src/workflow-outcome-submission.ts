import type { IMakaioBus } from '@makaio/bus-core';
import {
  WorkerNodeSubjects,
  WorkflowRunResultSchema,
  type OutcomeAckDecision,
  type WorkflowExecution,
  type WorkflowRunResult,
} from '@makaio/contracts';
import type { BaseMessageContext } from '@makaio/core';
import { resolveExecutionAttemptPeer, type ExecutionAttemptPeerIdentity } from './execution-bound-access.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
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
  readonly authority: ExecutionAttemptAuthority;
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
}

/**
 * Verify that a worker outcome is correlated with the immutable durable
 * execution identity before the Authority records it.
 *
 * This validation intentionally performs only reads: a mismatched result must
 * never become an immutable attempt outcome, because a corrected retry would
 * then be rejected as a conflicting outcome.
 * @param bus - Authority-local workflow bus.
 * @param executionId - Trusted execution identity derived from the peer.
 * @param result - Parsed worker result to validate.
 */
async function validateOutcomeExecutionIdentity(
  bus: IMakaioBus,
  executionId: string,
  result: WorkflowRunResult,
): Promise<void> {
  const [{ execution }, { runContext }] = await Promise.all([
    bus.request(WorkflowStorageSubjects.getExecution, { executionId }),
    bus.request(WorkflowStorageSubjects.getRunContext, { executionId }),
  ]);
  if (!execution) throw new Error(`Outcome execution not found: ${executionId}`);
  if (execution.id !== executionId || execution.workflowId !== result.workflowId) {
    throw new Error(`Outcome workflow identity mismatch for execution '${executionId}'`);
  }
  if (!runContext) throw new Error(`Outcome run context not found: ${executionId}`);
  if (runContext.executionId !== executionId || runContext.workflowId !== result.workflowId) {
    throw new Error(`Outcome run context identity mismatch for execution '${executionId}'`);
  }
  if (runContext.terminalAuthority === 'worker') {
    throw new Error(`Outcome submission requires authority terminal ownership for execution '${executionId}'`);
  }
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
// Handler Registration
// ─────────────────────────────────────────────────────────────

/**
 * Register the `worker-node.control.outcome.submit` bus handler.
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
  return bus.on(WorkerNodeSubjects.control.outcome.submit, async (ctx) => {
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
    await validateOutcomeExecutionIdentity(bus, identity.executionId, typedResult);

    // Step 1: Commit the outcome through the Authority repository.
    // The Authority records the durable decision but does NOT settle
    // in-process waiters for accepted/duplicate outcomes — waiters are
    // settled only after workflow-state convergence succeeds (Step 2).
    const isPaused = typedResult.status === 'paused';
    const decision = await deps.authority.commitOutcome(identity.executionAttemptId, identity.executionId, typedResult);

    // Step 2: Converge workflow state for accepted/duplicate outcomes,
    // then settle the waiter. If convergence fails, reject the waiter.
    const ackDecision = decisionToAck(decision.kind);
    if (decision.kind === 'accepted' || decision.kind === 'duplicate') {
      // Convergence or settling may throw. When that happens the outcome
      // is already durably committed and immutable, so do NOT reject or
      // delete the waiter. A worker retry will resubmit the same outcome,
      // receive a `duplicate` decision, and converge the workflow state.
      // Let the error propagate so the RPC errors and the worker retries.
      if (isPaused) {
        await convergePausedState(bus, identity.executionId, typedResult);
      } else {
        await deps.acceptTerminalResult(identity.executionId, decision.outcome);
      }
      deps.authority.settleOutcome(identity.executionAttemptId, decision);
    }

    // Step 3: ACK only after both durable steps succeed.
    ctx.setResult({ decision: ackDecision });
  });
}

/**
 * Map an internal repository decision kind to the bus ACK decision.
 * @param kind - Repository decision kind.
 * @returns Wire-compatible ACK decision.
 */
function decisionToAck(kind: 'accepted' | 'duplicate' | 'conflict' | 'fenced'): OutcomeAckDecision {
  return kind;
}
