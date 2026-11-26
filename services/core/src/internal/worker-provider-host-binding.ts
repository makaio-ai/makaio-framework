/** Composition controls for framework hosts (internal, no compatibility promise). */
export { AllocationObservationSignal } from '../worker-provider/allocation-observation-signal.js';
export { readAllocationScopeSetting } from '../worker-provider/allocation-scope-source.js';
export { DispatchCandidateReadError } from '../worker-provider/dispatch-store.js';
export { finishLocalAllocation } from '../worker-provider/local-worker-control.js';
export { WorkerProviderRegistry } from '../worker-provider/provider-registry.js';
export {
  prepareWorkerRedemption,
  WorkerRedemptionError,
  type WorkerRedemptionHost,
  type WorkerRedemptionPresentation,
} from '../worker-provider/redeem-worker.js';
export { WorkerOrderConfigurationError } from '../worker-provider/start-claim.js';
export { createWorkerDispatch } from '../worker-provider/start-ordered-worker.js';
export type { WorkerStartOptions } from '../worker-provider/start-order.js';
export { createWorkerProviderContributionProcessor } from '../worker-provider/worker-provider-contribution-processor.js';
export { encodeWorkerExchangeReply, WorkerExchangeReplyTooLargeError } from '../worker-provider/redemption-reply.js';
