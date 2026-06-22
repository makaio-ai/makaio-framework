/**
 * Claude Code AI Adapter
 *
 * Provides integration with the Claude Code Agent SDK using the three-layer architecture:
 * - ClaudeCodeAdapter: Domain-level adapter extending AIAdapter
 * - ClaudeCodeAgent: AIAgent subclass that wires connector events to global subjects
 * - ClaudeSdkConnector: SDK-level bridge to Claude Agent SDK
 *
 * Emits granular, type-safe events for all SDK message types.
 */

// Export the adapter class and factory
export {
  createClaudeAdapter,
  ClaudeCodeAdapterName,
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterConfig,
} from './adapter.js';

// Export the connector class
export { ClaudeSdkConnector } from './connector.js';

// Export namespace and subjects
export { ClaudeCodeConnectorSubjects, ClaudeCodeConnectorNamespace } from './namespace/index.js';

// Export types
export type { ClaudeAgentConfig } from './types/index.js';
export { ClaudeAccountObservationEmitter, normalizeClaudeAccountObservationPayload } from './account-observation.js';
export type { ClaudeAccountObservationPayload, ClaudeObservedAccountInfo } from './account-observation.js';

// Export schemas
export { ClaudeCodeProviderConfigSchema, type ClaudeCodeProviderConfig } from './schemas.js';

// Type-safe content block handlers
export { CONTENT_BLOCK_HANDLERS } from '@makaio/ai-adapters-claude-shared';
