/**
 * Utilities for identifying and extracting target information from `mcp_call`
 * tool invocations.
 *
 * The `mcp_call` meta-tool carries its real target as the `tool` field in the
 * parsed JSON arguments. These helpers centralise that extraction logic so
 * every consumer (ledger, event bridge, analytics) uses a single, tested path.
 * @packageDocumentation
 */

import { MCP_CALL_TOOL_NAME } from '@makaio/contracts';

/**
 * Extract the target MCP tool name from parsed `mcp_call` arguments.
 *
 * Conforms to the `mcp_call` input schema which defines `{ tool: z.string() }`.
 * Returns `undefined` for any non-conformant argument shape so callers can
 * skip processing without throwing.
 * @param args - Parsed JSON arguments object from the tool call
 * @returns The namespaced target tool name, or `undefined` if not conformant
 */
export function extractMcpCallTarget(args: Record<string, unknown>): string | undefined {
  return typeof args['tool'] === 'string' ? args['tool'] : undefined;
}

/**
 * Check whether a tool call name refers to the `mcp_call` meta-tool.
 *
 * Uses the canonical {@link MCP_CALL_TOOL_NAME} constant so the comparison
 * stays in sync with the toolset definition automatically.
 *
 * Callers are responsible for stripping provider-specific prefixes before
 * calling this function (e.g., Gemini's `default_api.` prefix must be
 * removed at the call site — see `execute-tool-calls.ts` normalizedToolName).
 * @param toolName - Normalized tool name from the tool call
 * @returns `true` if this is an `mcp_call` invocation
 */
export function isMcpCallTool(toolName: string): boolean {
  return toolName === MCP_CALL_TOOL_NAME;
}
