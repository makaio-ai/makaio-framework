/**
 * Gemini SDK Adapter
 *
 * Package: `@makaio/adapter-gemini-sdk`
 *
 * Provides standardized interface for Gemini SDK interactions
 * in the Makaio AI framework using the three-layer architecture.
 *
 * Architecture:
 * - GeminiAdapter (AIAdapter) - Factory for creating agents
 * - GeminiAgent (AIAgent) - Middle layer, wires events to global bus
 * - GeminiConnector (AIAgentConnector) - SDK-level bridge
 */

// Adapter exports
export { createGeminiSDKAdapter, GeminiSdkAdapterName, GeminiAdapter } from './adapter.js';

// Agent exports (three-layer architecture)
export { GeminiAgent } from './agent.js';
export { GeminiConnector, GeminiConnector as GeminiAgentLegacy } from './connector.js';

// Session/Turn abstractions (for prompt cache preservation pattern)
export { GeminiConnectorSession } from './session.js';
export { GeminiConnectorTurn } from './turn.js';
export { UserMessageQueue } from '@makaio/ai-adapters-core';

// Namespace exports
export { GeminiConnectorNamespace, GeminiConnectorSubjects } from './namespaces/index.js';

// eslint-disable-next-line no-restricted-syntax -- type-only wildcard
export type * from './namespaces/index.js';

// Session types
export type {
  GeminiAgentMetadata,
  GeminiConnectorConfig,
  GeminiAgentConnectorConfig,
  GeminiSessionConfig,
} from './types/index.js';

// Re-export core types for convenience
export type { AIAdapterPromptOptions, AIAdapterPromptResult } from '@makaio/ai-adapters-core';

// Export schemas
export { GeminiSdkProviderConfigSchema, type GeminiSdkProviderSettings } from './schemas.js';

// Tool handling utilities
export {
  toGlobalToolApproval,
  fromGlobalToolApproval,
  registerToolApprovalHandler,
  requestToolApproval,
  type ToolApprovalContext,
} from './tool-handling.js';
