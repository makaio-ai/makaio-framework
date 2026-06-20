/**
 * Tool Handling for OpenAI Node Adapter
 *
 * Adapter-specific functions for tool format conversion and orchestration.
 * Pure, shared utilities (approval transforms, registry loading, execution)
 * are imported from `@makaio/ai-adapters-stream-session`.
 *
 * ## Architecture
 *
 * ```
 * connector.ts                    tool-handling.ts
 * ─────────────                   ────────────────
 * runTurn()
 *   │
 *   ├─► stream-bridge ──► message_complete (with tool_calls)
 *   │
 *   └─► handleToolCalls(toolCalls, callbacks, context)
 *         │
 *         ├─► requestToolApproval() ──► scoped bus ──► global bus
 *         │
 *         └─► executeTool()
 *               ├─► emitSdkEvent(tool_started)
 *               ├─► MakaioBus.request(ToolSubjects.execute)
 *               └─► emitSdkEvent(tool_completed)
 * ```
 *
 * ## Exports
 *
 * **Approval Transformation** (re-exported from shared)
 * - `extractToolCallPayload`: ToolCall → \{ toolName, args, toolCallId \}
 * - `registerToolApprovalHandler`: Wire scoped → global bus routing (via factory)
 *
 * **Registry Integration**
 * - `loadToolsFromRegistry`: Fetch tools via ToolSubjects.list (shared)
 * - `toOpenAIToolFormat`: Convert ToolListItem[] → ChatCompletionTool[]
 * - `fetchToolsForOpenAI`: Convenience wrapper (load + convert)
 *
 * **Execution (with lifecycle events)**
 * - `executeTool`: Execute via bus, emit tool_started/tool_completed (shared)
 * - `handleToolCalls`: Orchestrate approval + execution, return messages
 */

import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/index.js';

import type { IMakaioBus } from '@makaio/bus-core';
import { OpenAINodeConnectorSubjects, type SdkEventMessage } from './namespaces/index.js';
import type { ExtractSubjectPayload, ExtractSubjectResponse } from '@makaio/core';
import { type AgentToolApproveRequest, type AgentToolApproveResponse, type ToolListItem } from '@makaio/contracts';
import {
  createToolApprovalHandler,
  mergeScopedToolApproval,
  type ScopedToolApprovalRequest,
  type ToolApprovalContext,
} from '@makaio/ai-adapters-core';
export type { ToolApprovalContext } from '@makaio/ai-adapters-core';

import {
  extractToolCallPayload,
  loadToolsFromRegistry,
  filterToolsWithSchema,
  executeTool,
  handleToolCalls as handleToolCallsGeneric,
  type ToolCall,
  type ToolCallPayload,
  type ToolExecutionContextOverrides,
  type ToolRegistryLoadOptions,
} from '@makaio/ai-adapters-stream-session';

export type { ToolCallPayload, ToolExecutionContextOverrides };

const ADAPTER_LABEL = 'OpenAINodeAgent';

/**
 * Register tool approval handler on scoped connector.
 *
 * Wires OpenAINodeConnectorSubjects.tool_approval → AgentSubjects.toolApprove.
 * Used by agent.ts wireToolApprovalRpc() for consistent approval flow.
 *
 * The handler receives `AgentToolApproveRequest` from the connector (already
 * transformed via toGlobalToolApproval), enriches with context if needed,
 * and forwards to global MakaioBus.
 * @param connector - OpenAI Node connector (needs only `on` method)
 * @param context - Adapter context for request enrichment (static or lazy callback)
 * @returns Unsubscribe function
 */
export const registerToolApprovalHandler = createToolApprovalHandler(
  OpenAINodeConnectorSubjects.tool_approval,
  (payload: ScopedToolApprovalRequest, context: ToolApprovalContext): AgentToolApproveRequest =>
    mergeScopedToolApproval(payload, context, 'openai-node'),
  (response: AgentToolApproveResponse): AgentToolApproveResponse => response,
);

// --------------------------------------------------------------------------
// Tool Registry Integration
// SEAM: Other adapters may adopt this pattern when they need to load/execute
// tools from the central registry rather than relying on SDK-native tools.
// --------------------------------------------------------------------------

// Re-export shared utilities for consumers that import them from this module
export { loadToolsFromRegistry, extractToolCallPayload, executeTool };

/**
 * Convert ToolListItem[] to OpenAI ChatCompletionTool[] format.
 *
 * Filters to only tools with inputSchema (required for OpenAI function calling).
 * Maps name, description, and parameters to OpenAI's expected structure.
 * @param tools - Tools from ToolRegistry
 * @returns OpenAI-formatted tools
 */
export function toOpenAIToolFormat(tools: ToolListItem[]): ChatCompletionTool[] {
  return filterToolsWithSchema(tools).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Convenience: Load tools and convert to OpenAI format in one call.
 * @param bus - Bus that owns the ToolRegistry handlers
 * @param adapterId - Adapter instance ID
 * @param adapterName - Adapter type name
 * @param options - Optional adapter runtime tool allow/deny filters
 * @returns OpenAI-formatted tools ready for chat completions
 */
export async function fetchToolsForOpenAI(
  bus: IMakaioBus,
  adapterId: string,
  adapterName: string,
  options?: ToolRegistryLoadOptions,
): Promise<ChatCompletionTool[]> {
  const tools = await loadToolsFromRegistry(bus, adapterId, adapterName, options);
  return toOpenAIToolFormat(tools);
}

type OpenAIToolCallsCallbacks = {
  bus: IMakaioBus;
  emitSdkEvent: (event: SdkEventMessage) => Promise<void>;
  requestToolApproval: (
    payload: Omit<
      ExtractSubjectPayload<typeof OpenAINodeConnectorSubjects.tool_approval>,
      'adapterName' | 'adapterId' | 'agentId' | 'adapterSessionId' | 'sessionId'
    >,
  ) => Promise<ExtractSubjectResponse<typeof OpenAINodeConnectorSubjects.tool_approval>>;
  /** Optional mcp_call ledger callback forwarded from the session config. */
  recordMcpCall?: (toolFullName: string) => void;
};

/**
 * Process tool calls: request approval, execute, and add results to messages.
 *
 * Tool call arguments are already normalized by stream-bridge
 * (GLM \{\} fix, DeepSeek XML extraction).
 * @param toolCalls - Array of tool calls from the model response (normalized)
 * @param callbacks - Injected callbacks for event emission, approval requests, and optional ledger recording
 * @param contextOverrides - Execution context (cwd, env, sessionId, agentId, turnId)
 * @returns Tool result messages to append to conversation history
 */
export async function handleToolCalls(
  toolCalls: ToolCall[],
  callbacks: OpenAIToolCallsCallbacks,
  contextOverrides: ToolExecutionContextOverrides,
): Promise<ChatCompletionMessageParam[]> {
  return handleToolCallsGeneric<ChatCompletionMessageParam>(
    toolCalls,
    callbacks,
    contextOverrides,
    // OpenAI tool messages have no is_error field — errors are signalled
    // purely through the content JSON shape ({ error, code }).
    (toolCallId, content, _isError) => ({
      role: 'tool' as const,
      tool_call_id: toolCallId,
      content,
    }),
    ADAPTER_LABEL,
  );
}
