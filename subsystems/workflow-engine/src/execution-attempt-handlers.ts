import type { IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptSchemas,
  ExecutionAttemptSubjects,
  type ExecutionAttemptInstruction,
  type ExecutionAttemptOutcome,
  type ExecutionAttemptOutcomeSubmitRequest,
} from '@makaio/contracts';
import type { BaseMessageContext } from '@makaio/core';
import { resolveExecutionAttemptPeer, type ExecutionAttemptPeerIdentity } from './execution-bound-access.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import { RuntimeOutcomeFenceMismatchError, type AttemptControlState } from './execution-attempt-repository.js';
import { submitAttemptOutcome, type AttemptOutcomeSubmissionDeps } from './outcome-convergence.js';

/** Owner-specific interpretation of a terminal report against its frozen assignment. */
export interface AttemptOutcomeDecodingInput {
  /** Immutable instruction stored when the Attempt was created. */
  readonly instruction: ExecutionAttemptInstruction;
  /** Technical failure or adapter-produced result reported by the Runtime. */
  readonly outcome: ExecutionAttemptOutcome;
}

/** Dependencies for the generic instruction, Preparation, and outcome request handlers. */
export interface ExecutionAttemptHandlersDeps<TOutcome> extends AttemptOutcomeSubmissionDeps<TOutcome> {
  /**
   * Decode against immutable assignment facts, not the owner's mutable current state.
   * Must produce the same outcome for retries of the same report.
   * @param input - Frozen instruction and terminal wire report.
   * @returns The owner-specific outcome passed through canonical commit and convergence.
   */
  decodeOutcome(input: AttemptOutcomeDecodingInput): TOutcome | Promise<TOutcome>;
}

/**
 * Bind one request to its receiving transport's authenticated Attempt identity.
 * @param ctx - Incoming request context.
 * @param executionAttemptId - Attempt named in the parsed request.
 * @returns Trusted owner and Attempt identifiers.
 */
function requireAttemptPeer(ctx: BaseMessageContext, executionAttemptId: string): ExecutionAttemptPeerIdentity {
  const peer = resolveExecutionAttemptPeer(ctx);
  if (peer === null) throw new Error('Attempt requests require an authenticated workflow-execution-attempt peer');
  if (peer.executionAttemptId !== executionAttemptId) {
    throw new Error('Request executionAttemptId does not match authenticated peer identity');
  }
  return peer;
}

/**
 * Check terminal-report correlation without closing the active operation first.
 * @param control - Persisted Runtime generation and operation identity.
 * @param request - Parsed terminal report.
 * @returns Whether the report still belongs to the Runtime's execution slot.
 */
function matchesOutcomeCorrelation(
  control: AttemptControlState | null,
  request: ExecutionAttemptOutcomeSubmitRequest,
): boolean {
  if (control === null || control.runtimeGeneration !== request.runtimeGeneration) {
    return false;
  }
  if (request.outcome.kind === 'cancelled' && request.operationId === undefined) {
    // This reports stopped work, not cancel intent. Between work operations
    // there is no operation to identify; the atomic commit still fences the idle slot.
    return control.activeOperationId === null;
  }
  const stage =
    request.outcome.kind === 'technical-failure'
      ? request.outcome.stage
      : request.outcome.kind === 'cancelled'
        ? control.activeOperationKind
        : 'workload-invocation';
  if (stage === 'startup') {
    return request.operationId === undefined && control.activeOperationId === null;
  }
  if (
    control.activeOperationId !== request.operationId ||
    control.activeOperationGeneration !== request.runtimeGeneration ||
    control.activeOperationKind !== stage ||
    (stage !== 'workspace-preparation' && stage !== 'workload-invocation')
  ) {
    return false;
  }
  // Terminal commitment retains operation identity. Do not reject a closed
  // start gate here: an ACK retry must converge the already committed outcome.
  return true;
}

/**
 * Register frozen instruction retrieval without treating retrieval as admission.
 * @param bus - Bus that receives authenticated Runtime requests.
 * @param authority - Authority that owns the frozen assignment.
 * @returns Handler cleanup.
 */
function registerInstructionHandler<TOutcome>(
  bus: IMakaioBus,
  authority: ExecutionAttemptAuthority<TOutcome>,
): () => void {
  return bus.on(ExecutionAttemptSubjects.instruction.get, async (ctx) => {
    const request = ExecutionAttemptSchemas['instruction.get'].request.parse(ctx.payload);
    const peer = requireAttemptPeer(ctx, request.executionAttemptId);
    const instruction = await authority.getInstruction(peer);
    if (instruction === null) {
      ctx.setResult({ decision: 'refused', refusalReason: 'not-found' });
      return;
    }
    const control = await authority.getAttemptControlState(peer.executionAttemptId);
    if (control?.runtimeGeneration !== request.runtimeGeneration) {
      ctx.setResult({ decision: 'refused', refusalReason: 'stale-generation' });
      return;
    }
    // Historical reads remain useful after settlement. Only operation.admit
    // authorizes execution; reading an instruction never reopens its gate.
    ctx.setResult({ decision: 'found', instruction });
  });
}

/**
 * Register generic Runtime ingress; no Workflow result or owner lifecycle is assumed.
 *
 * Preparation acceptance and operation completion are one Authority write.
 * Terminal reports commit, converge, settle the waiter, then receive their ACK.
 * Local host code uses the typed Authority/submission ports directly; these wire
 * handlers follow the same authenticated-peer rule as Runtime registration.
 * @param bus - Bus that receives authenticated Runtime requests.
 * @param deps - Authority and owner-side outcome adapter.
 * @returns Cleanup function for all three handlers.
 */
export function registerExecutionAttemptHandlers<TOutcome>(
  bus: IMakaioBus,
  deps: ExecutionAttemptHandlersDeps<TOutcome>,
): () => void {
  const cleanups = [
    registerInstructionHandler(bus, deps.authority),
    bus.on(ExecutionAttemptSubjects.operation.report, async (ctx) => {
      const request = ExecutionAttemptSchemas['operation.report'].request.parse(ctx.payload);
      const peer = requireAttemptPeer(ctx, request.executionAttemptId);
      const decision = await deps.authority.reportOperation({ ...request, executionId: peer.executionId });
      if (decision.kind === 'accepted' || decision.kind === 'duplicate') {
        ctx.setResult({ decision: decision.kind, binding: decision.binding });
      } else {
        ctx.setResult({ decision: 'refused', refusalReason: decision.kind });
      }
    }),
    bus.on(ExecutionAttemptSubjects.outcome.submit, async (ctx) => {
      const request = ExecutionAttemptSchemas['outcome.submit'].request.parse(ctx.payload);
      const peer = requireAttemptPeer(ctx, request.executionAttemptId);
      const instruction = await deps.authority.getInstruction(peer);
      if (instruction === null) throw new Error('No instruction belongs to this authenticated Attempt');
      const control = await deps.authority.getAttemptControlState(peer.executionAttemptId);
      if (!matchesOutcomeCorrelation(control, request)) {
        ctx.setResult({ decision: 'fenced' });
        return;
      }
      const runtimeFence = {
        runtimeGeneration: request.runtimeGeneration,
        operationId: request.operationId ?? null,
      };
      const outcome = await deps.decodeOutcome({ instruction, outcome: request.outcome });
      try {
        const decision = await submitAttemptOutcome(deps, { ...peer, outcome, runtimeFence });
        ctx.setResult({ decision });
      } catch (error) {
        if (!(error instanceof RuntimeOutcomeFenceMismatchError)) throw error;
        // The stale caller must stop retrying, but this is only a wire reply:
        // settling the shared waiter would reject the replacement Runtime's work.
        ctx.setResult({ decision: 'fenced' });
      }
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
