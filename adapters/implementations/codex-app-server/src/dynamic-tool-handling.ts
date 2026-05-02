/**
 * Dynamic tool integration for Codex App Server.
 *
 * Converts Makaio registry tools to Codex's dynamicTools format for
 * `thread/start`, and handles `item/tool/call` server requests by routing
 * execution through the bus.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { type ToolListItem, ToolSubjects } from '@makaio/contracts';
import { loadToolsFromRegistry, filterToolsWithSchema } from '@makaio/ai-adapters-stream-session';
import { extractMcpCallTarget, isMcpCallTool, type ISessionToolLedger } from '@makaio/ai-adapters-core';
import type { ThreadStartParams } from './protocol/generated/v2/index.js';

/**
 * Codex dynamic tool declaration for `thread/start`.
 * Matches the shape expected by the codex app-server experimental API.
 */
export interface CodexDynamicTool {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for tool input */
  inputSchema: Record<string, unknown>;
}

/**
 * Extension of `ThreadStartParams` that includes the experimental `dynamicTools` field.
 *
 * The generated `ThreadStartParams` does not include `dynamicTools` because it is
 * part of the experimental API. This type is used only at the `thread/start` callsite
 * to avoid losing type safety on the other required fields.
 */
export type ThreadStartParamsWithDynamicTools = ThreadStartParams & {
  /** Makaio registry tools exposed to the model as function-calling tools. Requires experimentalApi capability. */
  dynamicTools?: CodexDynamicTool[];
};

/**
 * Payload carried in an `item/tool/call` server request from codex.
 *
 * This method is part of the codex experimental API and is not included in the
 * generated `ServerRequest` discriminated union. A local extension is used so
 * the `setupServerRequestHandler` can handle it with full type safety.
 */
export interface DynamicToolCallServerRequest {
  method: 'item/tool/call';
  id: string | number;
  params: {
    /** Thread identifier */
    threadId: string;
    /** Turn identifier */
    turnId: string;
    /** Item identifier — used as `toolCallId` for lifecycle correlation */
    itemId: string;
    /** Tool name as declared in `dynamicTools` */
    name: string;
    /** Tool arguments from the model */
    arguments: Record<string, unknown>;
  };
}

/**
 * Content item in the `item/tool/call` response.
 */
export interface DynamicToolCallResponseContent {
  type: 'text';
  text: string;
}

/**
 * Response shape for `item/tool/call` server requests.
 */
export interface DynamicToolCallResponse {
  content: DynamicToolCallResponseContent[];
}

/**
 * Type guard for `item/tool/call` server requests.
 *
 * Used to narrow the generic server-request union (which does not yet include
 * `item/tool/call` in the generated types) to the experimental shape.
 * @param request - The raw server request object
 * @returns `true` if the request is an `item/tool/call` request
 */
export function isDynamicToolCallRequest(request: { method: string }): request is DynamicToolCallServerRequest {
  return request.method === 'item/tool/call';
}

/**
 * Convert registry `ToolListItem[]` to Codex dynamic tool format.
 *
 * Filters out tools without an `inputSchema` because the codex protocol
 * requires a JSON Schema for each dynamic tool declaration.
 * @param tools - Tools from `loadToolsFromRegistry`
 * @returns Codex-compatible dynamic tool declarations
 */
export function toCodexDynamicToolFormat(tools: ToolListItem[]): CodexDynamicTool[] {
  return filterToolsWithSchema(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * Fetch registry tools and convert to Codex dynamic tool format.
 *
 * `loadToolsFromRegistry` catches fetch failures internally and returns `[]`,
 * so this function never throws. Callers always receive a (possibly empty) array.
 * @param adapterId - Adapter instance ID for policy filtering
 * @param adapterName - Adapter type name for policy filtering
 * @returns Codex-formatted dynamic tool declarations
 */
export async function fetchToolsForCodex(adapterId: string, adapterName: string): Promise<CodexDynamicTool[]> {
  const tools = await loadToolsFromRegistry(adapterId, adapterName);
  return toCodexDynamicToolFormat(tools);
}

/**
 * Cached result of a dynamic tool call, indexed by `itemId` in the connector.
 * Populated by the `item/tool/call` server request handler and consumed by the
 * `item/started` / `item/completed` lifecycle handlers to emit step events.
 */
export interface DynamicToolCallCacheEntry {
  /** Tool name as declared in `dynamicTools` */
  name: string;
  /** Tool input arguments */
  args: Record<string, unknown>;
  /** Serialised tool output */
  output: string;
  /** Whether execution succeeded */
  success: boolean;
}

/**
 * Execution context for dynamic tool calls.
 */
export interface DynamicToolCallContext {
  /** Session ID for multi-session task correlation */
  sessionId?: string;
  /** Agent ID for attribution */
  agentId: string;
  /** Adapter instance ID for allowedAdapters policy enforcement */
  adapterId: string;
  /** Adapter type name for allowedAdapters policy enforcement */
  adapterName: string;
  /** Session tool ledger for MCP call tracking. */
  toolLedger?: ISessionToolLedger;
  /** Turn number for MCP call tracking. */
  currentTurnNumber: number;
}

/**
 * Determine whether a serialised tool output string represents a success.
 *
 * Returns `false` when the output is valid JSON that contains a top-level `error`
 * key (the shape emitted by {@link handleDynamicToolCall} on bus failure), and
 * `true` in all other cases (including non-JSON output, which is treated as success).
 *
 * Known limitation: a tool that legitimately returns `{ "error": "..." }` as data
 * will be misclassified as failed. This is acceptable because (a) the Codex dynamic
 * tool protocol has no out-of-band success channel, (b) tools should not use
 * "error" as a top-level key for successful results, and (c) the misclassification
 * only affects lifecycle telemetry, not the tool output returned to the agent.
 *
 * **Error format contract:** {@link handleDynamicToolCall} serialises bus errors as
 * `JSON.stringify({ error: message })` (a single top-level `error` string key).
 * This function is coupled to that exact shape — any change to the error format in
 * `handleDynamicToolCall` must be reflected here.
 * @param outputText - Serialised tool output from a `DynamicToolCallResponse`
 * @returns `true` if the output represents a successful execution
 */
export function isDynamicToolCallSuccess(outputText: string): boolean {
  try {
    const parsed = JSON.parse(outputText) as Record<string, unknown>;
    return !('error' in parsed);
  } catch {
    return true; // Non-JSON output is treated as success
  }
}

/**
 * Handle an `item/tool/call` server request from codex.
 *
 * Routes execution through `ToolSubjects.execute` on the global bus and
 * converts the result to the content-item format codex expects in the response.
 * Both success and failure paths return a valid response — bus errors are
 * serialised as error content rather than rejecting the promise, so codex
 * always receives a well-formed reply.
 * @param params - Tool call parameters from the server request
 * @param context - Execution context for bus routing and attribution
 * @returns Content items to send back to codex
 */
export async function handleDynamicToolCall(
  params: DynamicToolCallServerRequest['params'],
  context: DynamicToolCallContext,
): Promise<DynamicToolCallResponse> {
  try {
    const result = await MakaioBus.request(ToolSubjects.execute, {
      toolName: params.name,
      input: params.arguments,
      adapterId: context.adapterId,
      adapterName: context.adapterName,
      contextOverrides: {
        sessionId: context.sessionId,
        agentId: context.agentId,
        toolCallId: params.itemId,
      },
    });

    const text = result.success
      ? typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data ?? null)
      : JSON.stringify({ error: result.error.message, code: result.error.code });

    // Only record successful mcp_call executions in the ledger.
    // Failed calls don't count toward promotion scoring — a tool that consistently
    // fails should not be promoted to direct-inject. Consistent with the
    // handle-tool-calls.ts pipeline which also records success-only.
    if (result.success && context.toolLedger && isMcpCallTool(params.name)) {
      const targetTool = extractMcpCallTarget(params.arguments);
      if (targetTool !== undefined && context.currentTurnNumber > 0) {
        context.toolLedger.recordCall(targetTool, context.currentTurnNumber);
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  }
}
