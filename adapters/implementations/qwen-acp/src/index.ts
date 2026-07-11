/**
 * Qwen ACP Adapter
 *
 * Package: \@makaio/adapter-qwen-acp
 *
 * Provides a standardized interface for Qwen Code CLI interactions via the
 * Agent Client Protocol (ACP) over stdio in the Makaio AI framework.
 */

// Namespace and bus type
export { QwenAcpNamespace, QwenAcpSubjects } from './namespaces/index.js';
export type {
  QwenAcpBus,
  TurnStarted,
  TurnFinished,
  TurnStepStarted,
  TurnStepFinished,
  TurnStateChanged,
  MessageChunk,
  ThoughtChunk,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate,
} from './namespaces/index.js';

// Constants
export { QwenAcpAdapterName, DefaultModel, DEFAULT_TIMEOUTS } from './constants.js';

// Schemas and config types
export { QwenAcpProviderConfigSchema, ApprovalModeValues, AuthTypeValues } from './schemas.js';
export type { QwenAcpProviderConfig } from './schemas.js';

// Provider IDs
export { providerIds } from './provider.js';

// Connector and turn
export { QwenAcpConnector } from './connector.js';
export { QwenAcpTurn } from './turn.js';
export type { QwenAcpTurnState } from './turn.js';

// Agent
export { QwenAcpAgent } from './agent.js';

// Adapter and factory
export { QwenAcpAdapter, createQwenAcpAdapter } from './adapter.js';

// Config factory
export { QwenAcpConfig } from './config.js';

// Tool handling utilities
export {
  toGlobalToolApproval,
  fromGlobalToolApproval,
  registerToolApprovalHandler,
  type ToolApprovalContext,
} from './tool-handling.js';

// Utilities
export { buildCliArgs } from './utils/build-cli-args.js';
export { buildPromptContent } from './utils/build-prompt.js';
