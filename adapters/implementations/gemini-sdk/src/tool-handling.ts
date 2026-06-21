/**
 * Tool Handling for Gemini SDK Adapter
 *
 * Centralizes tool approval transformation, bus registration, and registry
 * tool loading/conversion for both production (agent.ts) and test use cases.
 *
 * Pattern:
 * - toGlobalToolApproval: SDK ToolCallRequestInfo → AgentToolApproveRequest
 * - fromGlobalToolApproval: AgentToolApproveResponse → SDK response (identity)
 * - registerToolApprovalHandler: Wire bus handler for scoped → global routing
 * - toGeminiToolFormat: ToolListItem[] → GeminiRegistryToolDeclaration[]
 * - fetchToolsForGemini: Load registry tools and convert to Gemini format
 */

import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { GeminiConnectorSubjects, type GeminiToolApprovalRequest } from './namespaces/index.js';
import { createToolApprovalHandler, type ToolApprovalContext } from '@makaio/ai-adapters-core';
import {
  AgentSubjects,
  type AgentToolApproveRequest,
  type AgentToolApproveResponse,
  type ToolListItem,
} from '@makaio/contracts';
import { loadToolsFromRegistry, filterToolsWithSchema } from '@makaio/ai-adapters-stream-session';

export type { ToolApprovalContext } from '@makaio/ai-adapters-core';

/**
 * Transform Gemini SDK ToolCallRequestInfo → AgentToolApproveRequest.
 *
 * Maps Gemini-native field names (callId, name) to core schema (toolCallId, toolName).
 * @param payload - SDK acp.tool_approval payload
 * @param context - Optional context override
 * @returns Global tool approval request
 */
export function toGlobalToolApproval(
  payload: GeminiToolApprovalRequest,
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return {
    agentId: context.agentId,
    adapterId: context.adapterId,
    adapterName: context.adapterName,
    adapterSessionId: context.adapterSessionId,
    sessionId: context.sessionId,
    toolCallId: payload.callId,
    toolName: payload.name,
    args: payload.args as Record<string, unknown>,
    reasoning: payload.reasoning,
  };
}

/**
 * Transform AgentToolApproveResponse → SDK response format.
 *
 * Gemini uses the core AgentToolApproveResponse schema directly,
 * so this is identity transformation.
 * @param response - Global tool approval response
 * @returns SDK-compatible response
 */
export function fromGlobalToolApproval(response: AgentToolApproveResponse): AgentToolApproveResponse {
  return response;
}

/**
 * Register tool approval handler on scoped connector.
 *
 * Wires GeminiSDKSubjects.acp.tool_approval → AgentSubjects.toolApprove.
 * Used by both createTestConfig (test harness) and optionally agent.ts (production).
 */
export const registerToolApprovalHandler = createToolApprovalHandler(
  GeminiConnectorSubjects.acp.tool_approval,
  toGlobalToolApproval,
  fromGlobalToolApproval,
);

/**
 * Convenience: Request tool approval via MakaioBus (round-trip).
 *
 * For cases where you need to call approval directly without bus.on() wiring.
 * @param payload - SDK acp.tool_approval payload
 * @param context - Context with adapterSessionId required
 * @returns Core tool approval response
 */
export async function requestToolApproval(
  payload: GeminiToolApprovalRequest,
  context: ToolApprovalContext,
): Promise<AgentToolApproveResponse> {
  const request = toGlobalToolApproval(payload, context);
  return MakaioBus.request(AgentSubjects.toolApprove, request);
}

// --------------------------------------------------------------------------
// Tool Registry Integration
// --------------------------------------------------------------------------

/**
 * Gemini-compatible registry tool declaration.
 *
 * Matches the shape of the `FunctionDeclaration` type from `\@google/genai` — we
 * define it locally to avoid a hard import on the genai package in this utility module.
 */
export interface GeminiRegistryToolDeclaration {
  /** Tool name as registered in the ToolRegistry. */
  name: string;
  /** Human-readable description forwarded to the LLM. */
  description: string;
  /** JSON Schema for tool parameters, stored in parametersJsonSchema. */
  parametersJsonSchema?: Record<string, unknown>;
}

/**
 * Convert ToolListItem[] to Gemini FunctionDeclaration-compatible objects.
 *
 * Uses `parametersJsonSchema` (not `parameters`) because inputSchema is already
 * plain JSON Schema — no need for Gemini's Schema type conversion.
 * Filters to only tools with inputSchema (required for function calling).
 * @param tools - Tools from loadToolsFromRegistry
 * @returns Gemini-compatible function declarations for registry tools
 */
export function toGeminiToolFormat(tools: ToolListItem[]): GeminiRegistryToolDeclaration[] {
  return filterToolsWithSchema(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  }));
}

/**
 * Convenience: Load registry tools and convert to Gemini format in one call.
 * @param bus - Bus that owns the ToolRegistry handlers.
 * @param adapterId - Adapter instance ID
 * @param adapterName - Adapter type name
 * @returns Gemini-formatted function declarations ready for GeminiChat construction
 */
export async function fetchToolsForGemini(
  bus: IMakaioBus,
  adapterId: string,
  adapterName: string,
): Promise<GeminiRegistryToolDeclaration[]> {
  const tools = await loadToolsFromRegistry(bus, adapterId, adapterName);
  return toGeminiToolFormat(tools);
}
