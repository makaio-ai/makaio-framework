import type { IMakaioBus } from '@makaio/bus-core';
import { ExecutionAttemptSchemas, ExecutionAttemptSubjects } from '@makaio/contracts';
import { resolveExecutionAttemptPeer } from './execution-bound-access.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';

// ─────────────────────────────────────────────────────────────
// Operation Admission Dependencies
// ─────────────────────────────────────────────────────────────

/**
 * Dependencies for the operation admission handler.
 */
export interface OperationAdmissionDeps<TOutcome> {
  /**
   * Bus the authority speaks on.
   *
   * Carries the `operation.admitted` announcement. The bus the handler is
   * registered on is the registrar's own first argument; in every production
   * wiring the two are the same instance.
   */
  readonly bus: IMakaioBus;
  /** Execution attempt Authority service. */
  readonly authority: ExecutionAttemptAuthority<TOutcome>;
}

// ─────────────────────────────────────────────────────────────
// Handler Registration
// ─────────────────────────────────────────────────────────────

/**
 * Register the `execution-attempt.operation.admit` bus handler.
 *
 * The single authority gate for the attempt's start gate. It fences the caller
 * exactly as runtime registration does — the authenticated attempt peer must be
 * the attempt named in the payload, and `executionId` is taken from the peer
 * because no payload in the namespace carries one — and then makes one
 * `admitOperation` call whose eight refusal kinds are the eight wire refusal
 * reasons, one to one.
 *
 * `runtime-probe` is not admissible here at all. The bounded probe is the
 * authority's own proof of the endpoint, admitted and completed inside the
 * registration handshake; a caller admitting one on this gate would occupy the
 * attempt's single slot with an operation no subject can complete. It is
 * refused as a protocol violation, exactly like a peer mismatch.
 *
 * `execution-attempt.operation.admitted` is published for the durable
 * admission, on the `admitted` transition and on every `duplicate` that finds
 * it already persisted. Publication is at-least-once: a retried admission
 * announces again, so an announcement whose first pass failed after
 * persistence is delivered by the next pass. Every consumer is idempotent —
 * the worker pool collapses repeats into one `busy` projection and
 * observability upserts. What this does not cover is a process that exits
 * between persisting the admission and announcing it: until a durable
 * publication marker exists, that admission is announced by the next retry of
 * the same key, or never.
 * @param bus - Bus the handler subscribes on.
 * @param deps - Operation admission dependencies.
 * @returns Cleanup function for handler deregistration.
 */
export function registerOperationAdmissionHandler<TOutcome>(
  bus: IMakaioBus,
  deps: OperationAdmissionDeps<TOutcome>,
): () => void {
  return bus.on(ExecutionAttemptSubjects.operation.admit, async (ctx) => {
    const peer = resolveExecutionAttemptPeer(ctx);
    if (peer === null) {
      throw new Error('Operation admission requires an authenticated workflow-execution-attempt peer');
    }
    // Parsed here, not trusted from the bus: request payloads are validated
    // where they are sent and never in production, so an admission that
    // reaches this gate is checked before it can become an active operation.
    const { executionAttemptId, operationKind, admissionKey, runtimeGeneration } = ExecutionAttemptSchemas[
      'operation.admit'
    ].request.parse(ctx.payload);
    if (executionAttemptId !== peer.executionAttemptId) {
      throw new Error(
        `Admission payload executionAttemptId '${executionAttemptId}' does not match ` +
          `authenticated peer identity '${peer.executionAttemptId}'`,
      );
    }
    if (operationKind === 'runtime-probe') {
      throw new Error(
        `Operation admission does not accept 'runtime-probe' (executionAttemptId='${executionAttemptId}'): ` +
          'the bounded probe is admitted only by runtime registration',
      );
    }

    const decision = await deps.authority.admitOperation({
      executionAttemptId,
      executionId: peer.executionId,
      operationKind,
      admissionKey,
      runtimeGeneration,
    });

    if (decision.kind === 'admitted' || decision.kind === 'duplicate') {
      // Announced on the transition and on its replay alike; see the handler
      // doc for the at-least-once rule. The announcement is a projection of
      // the durable admission: generation and instant are the ones the
      // repository recorded, so a replay names the original admission, not
      // the retry that announced it again.
      await deps.bus.emit(ExecutionAttemptSubjects.operation.admitted, {
        executionAttemptId,
        operationId: decision.operationId,
        operationKind,
        runtimeGeneration: decision.runtimeGeneration,
        admittedAt: decision.admittedAt,
      });
      ctx.setResult({ decision: decision.kind, operationId: decision.operationId });
      return;
    }

    ctx.setResult({ decision: 'refused', refusalReason: decision.kind });
  });
}
