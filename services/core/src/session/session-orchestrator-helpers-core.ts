/**
 * Framework-safe session orchestrator utilities.
 *
 * This module re-exports ONLY utilities with no host-layer dependencies
 * (no PersonaSubjects, ProfileSubjects, VirtualModelSubjects,
 * ExecutionTargetSubjects, etc.).
 *
 * The framework `SessionOrchestrator` imports from here. Host-coupled
 * utilities (resolveAdapterId, ensureAgentCwd, resolveModelCapabilities, etc.)
 * remain in `session-orchestrator-helpers.ts` for host consumers.
 * @packageDocumentation
 */
export { extractTextContent, convertToSessionBlock, normalizeToBlocks } from './utils/message-utils.js';
export { getOrCreateSession, resolveTargetAgents, findTurnByAgent } from './utils/session-utils.js';
export { buildTurnInitiator } from './utils/turn-initiator.js';
export { buildRecoveryContext, buildPlannedRecoveryContext } from './utils/recovery-context.js';
