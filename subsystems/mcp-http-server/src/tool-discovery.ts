import type { IMakaioBus } from '@makaio/bus-core';
import type { ToolInfo, McpToolDefinition } from '@makaio/tools-core';
import { ToolSubjects } from '@makaio/contracts';

/**
 * Maps a runtime toolset name to the plugin that owns it.
 * When present, tools in the toolset receive an MCP name of `{pluginName}.{toolName}`.
 */
export type PluginToolsetMap = Record<string, string>;

/**
 * Describes a single resolved MCP tool entry, capturing the relationship between
 * the MCP-visible name and the original runtime tool name.
 */
export interface McpToolEntry {
  /** The MCP-visible name used in `tools/list` and `tools/call`. */
  mcpName: string;
  /** The original tool name as registered in the ToolRegistry. */
  sourceToolName: string;
  /** The toolset this tool belongs to. */
  toolsetName: string;
}

/**
 * Result of resolving MCP tools from the registry.
 */
export interface McpResolvedTools {
  /** MCP-compatible tool definitions ready to send in `tools/list` responses. */
  tools: McpToolDefinition[];
  /**
   * Bidirectional lookup map from MCP name to tool entry.
   * Use `byMcpName.get(mcpName)?.sourceToolName` to map a `tools/call` name back
   * to the runtime tool name for execution.
   */
  byMcpName: Map<string, McpToolEntry>;
}

/**
 * Options for MCP tool discovery.
 */
export interface McpToolDiscoveryOptions {
  /**
   * Maps toolset names to the plugin that owns them.
   * Tools in a plugin-owned toolset receive an MCP name of `{pluginName}.{toolName}`.
   * Tools in non-plugin toolsets receive bare `{toolName}` unless a collision occurs.
   */
  pluginToolsets?: PluginToolsetMap;

  /**
   * Official filtering seam for controlling which tools are exposed via MCP.
   *
   * Receives the full list of candidate tools (after bus query or static fallback) and
   * returns the subset to expose. Return an empty array to suppress all tools.
   * Return the input unchanged (default) to expose all tools.
   *
   * Use this hook to implement allow-lists, capability checks, or runtime feature flags
   * without modifying the registry or toolsets themselves.
   * @param tools - All candidate tools available in the registry
   * @returns Subset of tools to expose via MCP
   */
  getExposedTools?: (tools: ToolInfo[]) => ToolInfo[];

  /**
   * Static fallback tool list used when `ToolSubjects.list` has no registered handler
   * on the bus (e.g., no `ToolRegistry` is running in-process).
   * If omitted and the bus has no handler, the result will be empty.
   */
  staticFallback?: ToolInfo[];
}

/**
 * Computes a tentative MCP name for a tool before collision resolution.
 * @param tool - Tool info entry from the registry
 * @param pluginToolsets - Map of toolset name to plugin name
 * @returns Tentative MCP name (may be overridden by collision resolution)
 */
function tentativeMcpName(tool: ToolInfo, pluginToolsets: PluginToolsetMap): string {
  const pluginName = pluginToolsets[tool.toolsetName];
  if (pluginName) {
    return `${pluginName}.${tool.name}`;
  }
  return tool.name;
}

/**
 * Resolves the MCP-visible tool list from the bus, with collision-safe naming.
 *
 * Resolution algorithm:
 * 1. Query `ToolSubjects.list` via `bus.requestOptional`. If no handler is registered,
 *    fall back to `options.staticFallback` (empty by default).
 * 2. Apply `options.getExposedTools` filter (identity by default).
 * 3. Assign tentative MCP names: plugin-owned toolsets get `{pluginName}.{toolName}`,
 *    all others get bare `{toolName}`.
 * 4. Detect collisions: any tentative name claimed by two or more tools is resolved to
 *    `{toolsetName}.{toolName}` for every tool sharing that name.
 * 5. Return `McpResolvedTools` with the final tool list and a `byMcpName` lookup map.
 * @param bus - Bus instance used to query the live tool registry
 * @param options - Discovery options (plugin map, filter hook, static fallback)
 * @returns Resolved MCP tools with bidirectional name mapping
 */
export async function resolveMcpTools(bus: IMakaioBus, options?: McpToolDiscoveryOptions): Promise<McpResolvedTools> {
  const pluginToolsets = options?.pluginToolsets ?? {};
  const staticFallback = options?.staticFallback ?? [];

  // Query live registry; fall back to static list if no handler is registered
  const listResult = await bus.requestOptional(ToolSubjects.list, {});
  const rawTools: ToolInfo[] = listResult.handled ? listResult.data.tools : staticFallback;

  // Apply the official filtering seam
  const filteredTools = options?.getExposedTools ? options.getExposedTools(rawTools) : rawTools;

  // Compute tentative MCP names and detect collisions
  const tentativeNames = filteredTools.map((tool) => tentativeMcpName(tool, pluginToolsets));

  // Count occurrences to identify collisions
  const nameCounts = new Map<string, number>();
  for (const name of tentativeNames) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  // Build resolved tools list and lookup map
  const byMcpName = new Map<string, McpToolEntry>();
  const tools: McpToolDefinition[] = [];

  for (let i = 0; i < filteredTools.length; i++) {
    const tool = filteredTools[i];
    const tentative = tentativeNames[i];

    // Resolve to qualified name when there is a collision
    const mcpName = (nameCounts.get(tentative) ?? 1) > 1 ? `${tool.toolsetName}.${tool.name}` : tentative;

    const entry: McpToolEntry = {
      mcpName,
      sourceToolName: tool.name,
      toolsetName: tool.toolsetName,
    };

    if (byMcpName.has(mcpName)) {
      throw new Error(`Duplicate resolved MCP tool name: ${mcpName}`);
    }
    byMcpName.set(mcpName, entry);

    tools.push(toolInfoToMcpTool(tool, mcpName));
  }

  return { tools, byMcpName };
}

/**
 * Convert a `ToolInfo` from the registry to an `McpToolDefinition`.
 *
 * Used internally by `resolveMcpTools` and exposed for consumers that build the tool list outside
 * of `resolveMcpTools` (e.g., static registration paths).
 * @param tool - Tool info entry with optional inputSchema
 * @param mcpName - MCP-visible name to assign (may differ from `tool.name`)
 * @returns MCP-compatible tool definition
 */
export function toolInfoToMcpTool(tool: ToolInfo, mcpName: string): McpToolDefinition {
  return {
    name: mcpName,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
    annotations: tool.annotations,
  };
}
