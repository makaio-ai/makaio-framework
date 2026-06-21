/**
 * Tool Conversion for Pi SDK Adapter
 *
 * Converts Makaio registry tools to Pi SDK's `defineTool()` format and provides
 * a convenience loader that fetches, converts, and returns them in one call.
 *
 * Architecture notes:
 * - Pi SDK calls `agent.beforeToolCall` for ALL tools (native + custom), so the
 *   `createPiBeforeToolCallHook` in tool-handling.ts handles approval centrally.
 *   The execute functions here focus purely on dispatch and result formatting.
 * - `Type.Unsafe<Record<string, unknown>>(jsonSchema)` bridges Makaio's JSON Schema
 *   to Pi's TypeBox parameter schema without schema conversion loss.
 * - Execute functions throw on tool failure, matching Pi's AgentTool contract.
 *   Pi then marks the tool result as an error instead of treating failure text
 *   as a successful tool output.
 * - Tool lifecycle events (`tool.started`, `tool.completed`, `tool.error`) are emitted
 *   by the tool registry during `ToolSubjects.execute` — no duplication here.
 * @packageDocumentation
 */

import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type ToolExecutionContextOverrides, type ToolListItem } from '@makaio/contracts';
import {
  loadToolsFromRegistry,
  filterToolsWithSchema,
  boundToolResultContent,
} from '@makaio/ai-adapters-stream-session';
import { safeJsonStringify } from '@makaio/ai-adapters-core';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { Type } from '@mariozechner/pi-ai';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

/**
 * Adapter identity context for bus-bridged tool handler calls.
 *
 * Provides the routing information needed to dispatch tool execution via the
 * global bus and attribute results to the correct session.
 */
export interface PiToolHandlerContext {
  /** Adapter instance ID */
  adapterId: string;
  /** Adapter type name */
  adapterName: string;
  /** Agent ID for attribution */
  agentId: string;
  /** Current Makaio session ID for bus routing */
  sessionId: string;
  /** Working directory for tool execution. */
  cwd: string;
  /** Environment overrides for tool execution. */
  env: Record<string, string>;
  /** Optional directory restrictions for filesystem-capable tools. */
  allowedDirectories?: string[];
  /** Resolve live turn-scoped context at tool invocation time. */
  getTurnExecutionContext?: () => Pick<ToolExecutionContextOverrides, 'turnId' | 'turnContext'>;
  /** Consume an approval-rewritten input for this tool call, when one exists. */
  consumeApprovedToolInput?: (toolCallId: string) => Record<string, unknown> | undefined;
}

/**
 * Build the context override payload forwarded to the ToolRegistry.
 *
 * Pi tool handlers are created at session initialization, before any specific
 * turn exists, so turn-scoped fields are resolved lazily from the session when
 * Pi invokes the tool.
 * @param context - Adapter and runtime execution context
 * @param toolCallId - Current Pi tool call identifier
 * @returns Tool execution context overrides for the bus request
 */
function createToolExecutionContextOverrides(
  context: PiToolHandlerContext,
  toolCallId: string,
): ToolExecutionContextOverrides {
  return {
    cwd: context.cwd,
    env: context.env,
    sessionId: context.sessionId,
    agentId: context.agentId,
    adapterId: context.adapterId,
    adapterName: context.adapterName,
    ...context.getTurnExecutionContext?.(),
    toolCallId,
    ...(context.allowedDirectories !== undefined && {
      constraints: { allowedDirectories: context.allowedDirectories },
    }),
  };
}

/**
 * Create the Pi SDK `execute` function for a single Makaio registry tool.
 *
 * Routes tool execution through `ToolSubjects.execute` on the global bus and
 * wraps the result into the Pi SDK's `AgentToolResult` shape. The tool registry
 * emits lifecycle events (`tool.started`, `tool.completed`, `tool.error`) during
 * execute — no duplication here.
 *
 * The function throws on failures so Pi marks the result as `isError: true`.
 * @param tool - Registry tool with a guaranteed `inputSchema`
 * @param context - Adapter identity for bus routing and attribution
 * @returns Async execute function conforming to Pi's ToolDefinition.execute signature
 */
export function createPiToolHandler(
  tool: ToolListItem & { inputSchema: Record<string, unknown> },
  context: PiToolHandlerContext,
): ToolDefinition['execute'] {
  return async (toolCallId, params) => {
    const input = context.consumeApprovedToolInput?.(toolCallId) ?? params;
    const result = await MakaioBus.request(ToolSubjects.execute, {
      toolName: tool.name,
      input,
      adapterId: context.adapterId,
      adapterName: context.adapterName,
      contextOverrides: createToolExecutionContextOverrides(context, toolCallId),
    });

    if (!result.success) {
      throw new Error(result.error.message);
    }

    const serialized = typeof result.data === 'string' ? result.data : safeJsonStringify(result.data ?? null);
    const text = boundToolResultContent(serialized);
    return { content: [{ type: 'text', text }], details: {} };
  };
}

/**
 * Convert Makaio registry `ToolListItem[]` to Pi SDK `ToolDefinition[]`.
 *
 * Uses `Type.Unsafe<Record<string, unknown>>(jsonSchema)` to bridge Makaio's
 * JSON Schema to Pi's TypeBox parameter schema without lossy conversion.
 * Filters to only tools with `inputSchema` (required for Pi's function calling).
 *
 * Pi's `beforeToolCall` hook handles approval for all custom tools before
 * `execute` is called, so no approval logic is needed here.
 * @param tools - Tools from `loadToolsFromRegistry` (may have undefined inputSchema)
 * @param context - Adapter identity for bus routing and attribution
 * @returns Pi SDK ToolDefinition[] ready for inclusion in `CreateAgentSessionOptions.customTools`
 */
export function toPiToolFormat(tools: ToolListItem[], context: PiToolHandlerContext): ToolDefinition[] {
  return filterToolsWithSchema(tools).map((tool) =>
    defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: createPiToolHandler(tool, context),
    }),
  );
}

/**
 * Load tools from the Makaio registry and convert to Pi SDK format in one call.
 *
 * Wraps `loadToolsFromRegistry` (which never throws) and `toPiToolFormat`.
 * Returns an empty array when no tools are registered or the registry is unavailable.
 * @param bus - Bus that owns the ToolRegistry handlers.
 * @param adapterId - Adapter instance ID for registry filtering
 * @param adapterName - Adapter type name for registry filtering
 * @param context - Adapter identity for bus routing in the execute handlers
 * @returns Pi SDK ToolDefinition[] ready for `CreateAgentSessionOptions.customTools`
 */
export async function fetchToolsForPi(
  bus: IMakaioBus,
  adapterId: string,
  adapterName: string,
  context: PiToolHandlerContext,
): Promise<ToolDefinition[]> {
  const tools = await loadToolsFromRegistry(bus, adapterId, adapterName);
  return toPiToolFormat(tools, context);
}
