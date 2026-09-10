import type { IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptControlDeliveryResponseSchema,
  ExecutionAttemptSubjects,
  type ExecutionAttemptControlDelivery,
  type ExecutionAttemptControlDeliveryResponse,
  type ExecutionAttemptControlReceipt,
} from '@makaio/contracts';
import type {
  AttemptControlEvidenceDecision,
  AttemptControlEvidenceRepository,
  ReadAttemptCancellationControlInput,
} from './attempt-control-evidence.js';

/** The existing Authority supplies persistence; the caller supplies its live bus. */
export interface AttemptControlDeliveryDeps {
  readonly bus: IMakaioBus;
  readonly authority: Pick<
    AttemptControlEvidenceRepository,
    'readAttemptCancellationControl' | 'recordAttemptControlReceipt'
  >;
}

/** One bounded delivery, not a scheduler or a provider termination policy. */
export interface ReconcileAttemptCancellationInput extends ReadAttemptCancellationControlInput {
  /** Transport request budget; repository operations retain their own transaction lifetime. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Received means an actual response; its persistence decision says whether it was stored.
 * Evidence-complete means both receipt and final report are recorded, including
 * unsupported/unconfirmed conclusions. It does not establish stop, success or cleanup permission.
 */
export type AttemptControlDeliveryResult =
  | {
      readonly kind:
        | 'not-found'
        | 'not-requested'
        | 'runtime-unregistered'
        | 'evidence-complete'
        | 'aborted'
        | 'unavailable'
        | 'invalid-receipt';
    }
  | { readonly kind: 'refused'; readonly reason: 'stale-generation' | 'unsupported' }
  | { readonly kind: 'received'; readonly persistence: AttemptControlEvidenceDecision };

/**
 * Validate that an answer acknowledges the exact delivery, not a different registered incarnation.
 * @param delivery - Original immutable address and winning Cancel.
 * @param receipt - Actual response from the addressed endpoint.
 * @returns Whether the receipt describes that delivery.
 */
function matchesDeliveredReceipt(
  delivery: ExecutionAttemptControlDelivery,
  receipt: ExecutionAttemptControlReceipt,
): boolean {
  return (
    receipt.executionAttemptId === delivery.executionAttemptId &&
    receipt.runtimeIncarnationId === delivery.runtimeIncarnationId &&
    receipt.runtimeGeneration === delivery.runtimeGeneration &&
    receipt.controlRevision === delivery.cancellation.controlRevision &&
    receipt.requestKey === delivery.cancellation.requestKey
  );
}

/**
 * Try one delivery of already accepted Cancel and persist only a genuine runtime response.
 *
 * A stored receipt without a final report remains eligible for redelivery: the runtime
 * replays its response/report, never starts the workload again. Unknown transport outcomes
 * remain unknown. This does not acquire an operation slot or touch outcome/provider state.
 * @param deps - Live bus and durable Authority ports.
 * @param input - Exact Attempt and explicit bounded transport-delivery budget.
 * @returns This pass's transport and receipt-persistence result, not a stop conclusion.
 */
export async function reconcileAttemptCancellation(
  deps: AttemptControlDeliveryDeps,
  input: ReconcileAttemptCancellationInput,
): Promise<AttemptControlDeliveryResult> {
  const { executionId, executionAttemptId, timeoutMs, signal } = input;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  if (signal?.aborted) return { kind: 'aborted' };
  const state = await deps.authority.readAttemptCancellationControl({ executionId, executionAttemptId });
  if (signal?.aborted) return { kind: 'aborted' };
  if (state === null) return { kind: 'not-found' };
  if (state.cancellation === null) return { kind: 'not-requested' };
  const { runtimeGeneration, runtimeIncarnationId } = state.control;
  if (runtimeIncarnationId === null || runtimeGeneration === 0) return { kind: 'runtime-unregistered' };
  const evidence = state.evidence.find(
    (fact) =>
      fact.controlRevision === state.cancellation?.controlRevision && fact.runtimeGeneration === runtimeGeneration,
  );
  if (evidence?.receipt && evidence.report) return { kind: 'evidence-complete' };
  const delivery: ExecutionAttemptControlDelivery = {
    executionAttemptId,
    runtimeIncarnationId,
    runtimeGeneration,
    cancellation: state.cancellation,
  };
  let response: ExecutionAttemptControlDeliveryResponse;
  try {
    response = ExecutionAttemptControlDeliveryResponseSchema.parse(
      await deps.bus.request(ExecutionAttemptSubjects.control.deliver, delivery, { timeout: timeoutMs, signal }),
    );
  } catch {
    // A timeout or disconnected runtime is absence of evidence, never unconfirmed/achieved evidence.
    return { kind: signal?.aborted ? 'aborted' : 'unavailable' };
  }
  if (response.decision === 'refused') return { kind: 'refused', reason: response.reason };
  if (!matchesDeliveredReceipt(delivery, response.receipt)) return { kind: 'invalid-receipt' };
  const persistence = await deps.authority.recordAttemptControlReceipt({ ...response.receipt, executionId });
  return { kind: 'received', persistence };
}
