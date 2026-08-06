/**
 * Re-export facade for session orchestrator utilities.
 *
 * The actual implementations live in targeted files under `./utils/`.
 * This file preserves the original import paths for existing consumers.
 * @packageDocumentation
 */
export { extractTextContent, convertToSessionBlock, normalizeToBlocks } from './utils/message-utils.js';
export { getOrCreateSession, resolveTargetAgents, findTurnByAgent } from './utils/session-utils.js';
export { buildTurnInitiator } from './utils/turn-initiator.js';
export {
  resolveAdapterId,
  resolveModelCapabilities,
  resolveExecutionTarget,
  resolveOwnedAdapterInstance,
  type MachineScopedAdapterInstance,
  type OwnedAdapterInstance,
  type OwnedAdapterInstanceTarget,
} from './utils/resolution.js';
export { reserveStartFor, type StartReservationRequest } from './utils/start-reservation.js';
export { buildRecoveryContext, buildPlannedRecoveryContext } from './utils/recovery-context.js';
export {
  type AgentRecoveryOutcome,
  type RecoveryConfig,
  type VerifiedAgents,
  ensureAgentCwd,
  ensureAgentModel,
  verifyAndRecoverAgents,
  buildRecoveryContextWithPipeline,
  recoverAgent,
} from './utils/agent-recovery.js';
export { resolveRuntimeProviderContext } from '../provider-context/index.js';
