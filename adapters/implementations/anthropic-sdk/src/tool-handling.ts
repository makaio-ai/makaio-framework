/**
 * Tool Handling for Anthropic SDK Adapter
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
 *   ├─► stream-bridge ──► tool_calls (with ToolCall[])
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
 * - `registerToolApprovalHandler`: Wire scoped → global bus routing
 *
 * **Registry Integration**
 * - `loadToolsFromRegistry`: Fetch tools via ToolSubjects.list (shared)
 * - `toAnthropicToolFormat`: Convert ToolListItem[] → Anthropic Tool[]
 * - `fetchToolsForAnthropic`: Convenience wrapper (load + convert)
 *
 * **Execution (with lifecycle events)**
 * - `executeTool`: Execute via bus, emit tool_started/tool_completed (shared)
 * - `handleToolCalls`: Orchestrate approval + execution, return ToolResultBlockParam[]
 */

import type { Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

import type { IMakaioBus } from '@makaio/bus-core';
import { AnthropicSdkConnectorSubjects, type SdkEventMessage, type ToolCall } from './namespaces/index.js';
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
  type ToolCallPayload,
  type ToolExecutionContextOverrides,
  type ToolRegistryLoadOptions,
} from '@makaio/ai-adapters-stream-session';

export type { ToolCallPayload, ToolExecutionContextOverrides };

const ADAPTER_LABEL = 'AnthropicSdkAgent';

/**
 * Register tool approval handler on scoped connector.
 *
 * Wires AnthropicSdkConnectorSubjects.tool_approval → AgentSubjects.toolApprove.
 * Used by agent.ts wireToolApprovalRpc() for consistent approval flow.
 *
 * The handler receives `AgentToolApproveRequest` from the connector (already
 * transformed via toGlobalToolApproval), enriches with context if needed,
 * and forwards to global MakaioBus.
 * @param connector - Anthropic SDK connector (needs only `on` method)
 * @param context - Adapter context for request enrichment (static or lazy callback)
 * @returns Unsubscribe function
 */
export const registerToolApprovalHandler = createToolApprovalHandler(
  AnthropicSdkConnectorSubjects.tool_approval,
  (payload: ScopedToolApprovalRequest, context: ToolApprovalContext): AgentToolApproveRequest =>
    mergeScopedToolApproval(payload, context, 'anthropic-sdk'),
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
 * Convert ToolListItem[] to Anthropic Tool[] format.
 *
 * Filters to only tools with inputSchema (required for Anthropic tool use).
 * Maps name, description, and input_schema to Anthropic's expected structure.
 * @param tools - Tools from ToolRegistry
 * @returns Anthropic-formatted tools
 */
export function toAnthropicToolFormat(tools: ToolListItem[]): Tool[] {
  return filterToolsWithSchema(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Tool['input_schema'],
  }));
}

/**
 * Convenience: Load tools and convert to Anthropic format in one call.
 * @param bus - Bus that owns the ToolRegistry handlers
 * @param adapterId - Adapter instance ID
 * @param adapterName - Adapter type name
 * @param options - Optional adapter runtime tool allow/deny filters
 * @returns Anthropic-formatted tools ready for messages.create
 */
export async function fetchToolsForAnthropic(
  bus: IMakaioBus,
  adapterId: string,
  adapterName: string,
  options?: ToolRegistryLoadOptions,
): Promise<Tool[]> {
  const tools = await loadToolsFromRegistry(bus, adapterId, adapterName, options);
  return toAnthropicToolFormat(tools);
}

type AnthropicToolCallsCallbacks = {
  bus: IMakaioBus;
  emitSdkEvent: (event: SdkEventMessage) => Promise<void>;
  requestToolApproval: (
    payload: Omit<
      ExtractSubjectPayload<typeof AnthropicSdkConnectorSubjects.tool_approval>,
      'adapterName' | 'adapterId' | 'agentId' | 'adapterSessionId' | 'sessionId'
    >,
  ) => Promise<ExtractSubjectResponse<typeof AnthropicSdkConnectorSubjects.tool_approval>>;
  /** Optional mcp_call ledger callback forwarded from the session config. */
  recordMcpCall?: (toolFullName: string) => void;
};

/**
 * Process tool calls: request approval, execute, and return tool result blocks.
 *
 * Returns Anthropic-format tool results: `{ role: 'user', content: [{ type: 'tool_result', ... }] }`
 * is assembled by the caller using the returned ToolResultBlockParam[].
 * @param toolCalls - Array of normalized tool calls from the stream-bridge tool_calls event
 * @param callbacks - Injected callbacks for event emission, approval requests, and optional ledger recording
 * @param contextOverrides - Execution context (cwd, env, sessionId, agentId, turnId)
 * @returns Tool result blocks to inject into the next user message
 */
export async function handleToolCalls(
  toolCalls: ToolCall[],
  callbacks: AnthropicToolCallsCallbacks,
  contextOverrides: ToolExecutionContextOverrides,
): Promise<ToolResultBlockParam[]> {
  return handleToolCallsGeneric<ToolResultBlockParam>(
    toolCalls,
    callbacks,
    contextOverrides,
    (toolCallId, content, isError) => ({
      type: 'tool_result' as const,
      tool_use_id: toolCallId,
      content,
      is_error: isError,
    }),
    ADAPTER_LABEL,
  );
}
