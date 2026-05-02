/**
 * AI Adapter base class and types.
 *
 * Provides the foundation for creating AI service adapters with:
 * - Scoped bus communication
 * - Session/agent lifecycle management
 * - RPC handler registration
 */
export { AIAdapter } from './ai-adapter.js';
export {
  type AIAdapterConfig,
  type AIAdapterConstructorConfig,
  type AgentRuntimeCreationResult,
  type AgentUsageTotals,
} from './types.js';
export { type ConfigFactoryInput, type IAdapterConfigFactory } from './ai-adapter-config.js';
