/**
 * Shared infrastructure for Claude protocol AI adapter implementations.
 *
 * Provides the agent layer, turn state machine, content block handlers,
 * tool approval utilities, and log-importer infrastructure that are shared
 * between the claude-code and anthropic-sdk adapters.
 *
 * The namespace (bus subjects/schemas) is exposed separately via the
 * namespace barrel to allow namespace-only consumers to avoid the agent
 * layer dependencies.
 * @packageDocumentation
 */
export { ClaudeCodeAgent } from './agent/index.js';
export { AsyncQuerySource } from './async-query-source.js';
export { ClaudeConnectorTurn } from './turn/index.js';
export type { ClaudeTurnState, IQueryInterruptable } from './turn/index.js';
export { CONTENT_BLOCK_HANDLERS } from './content-block-handlers/index.js';
export {
  fromGlobalToolApproval,
  registerToolApprovalHandler,
  requestToolApproval,
  toGlobalToolApproval,
} from './tool-handling/index.js';
export type { ClaudePermissionResult, ToolApprovalContext } from './tool-handling/index.js';
export { createClaudeConnectorNamespace, SDKMessageSchema } from './namespace/index.js';
export type { ClaudeConnectorBus, ClaudeConnectorNamespace, SDKMessage } from './namespace/index.js';
export { claudeReasoningLevels } from './provider/index.js';
export {
  blocksToContentBlocks,
  buildSystemPrompt,
  decodeBase64Text,
  extractTextFromMessage,
  parseReasoningLevel,
  parseResultError,
  prependContextBlock,
  sdkUserMessageFromNormalized,
  unwrapBlockFromMessage,
} from './utils/index.js';
