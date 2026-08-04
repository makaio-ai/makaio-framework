/**
 * Session-ownership authority.
 *
 * The service half of the ownership aggregate: five bus operations, each of
 * which is exactly one durable ownership act, plus the two process-local seams
 * a start needs — exclusive-start joining and per-agent settle ordering.
 */
export { registerSessionOwnershipAuthority, type SessionOwnershipAuthorityDeps } from './authority.js';
export { registerAdapterSessionMovementObserver } from './movement-observer.js';
export {
  peekInFlightStart,
  runExclusiveStart,
  type ExclusiveStart,
  type InFlightStart,
} from './in-flight-starts.js';
export { enqueueAgentSettle } from './settle-queue.js';
export { mintClaimToken } from './claim-token.js';
export { designateSessionLead, type LeadDesignationRequest } from './lead-designation.js';
export { assessClaimOwner } from './owner-liveness.js';
