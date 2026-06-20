/**
 * Shared tool-handling utilities for stream-based adapter implementations.
 *
 * Exports pure functions and types that are identical across Anthropic SDK,
 * OpenAI Node, and any future stream-based adapters. Each adapter provides
 * a `ToolResultBuilder` to format results in its SDK-specific wire type.
 */

export {
  boundToolResultContent,
  MAX_TOOL_RESULT_CONTENT_CHARS,
  type ToolCallPayload,
  type ToolExecutionContextOverrides,
} from './tool-result.js';

export { type ToolCall, extractToolCallPayload, toGlobalToolApproval, applyApprovedArgs } from './tool-approval.js';

export { loadToolsFromRegistry, filterToolsWithSchema, type ToolRegistryLoadOptions } from './tool-registry.js';

export { executeTool, type ToolLifecycleEmitter } from './tool-execution.js';

export { handleToolCalls, type HandleToolCallsCallbacks, type ToolResultBuilder } from './handle-tool-calls.js';
