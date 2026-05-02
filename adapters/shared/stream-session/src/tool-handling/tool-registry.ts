/**
 * Shared tool registry integration.
 *
 * Pure functions for loading and filtering tools from the central ToolRegistry
 * via the global MakaioBus. This logic is identical across all stream-based
 * adapters that use the registry pattern.
 */

import { MakaioBus } from '@makaio/bus-core';
import { type ToolListItem, ToolSubjects } from '@makaio/contracts';

/**
 * Load tools from ToolRegistry via MakaioBus.
 *
 * Fetches available tools from the central ToolRegistry.
 * Returns raw ToolListItem[] for maximum flexibility so each adapter can
 * convert to its own SDK-specific format.
 *
 * Does not throw on failure — an agent can still operate without tools,
 * so errors are logged and an empty array is returned.
 * @param adapterId - Adapter instance ID for logging/routing
 * @param adapterName - Adapter type name
 * @returns List of available tools, or empty array if fetch fails
 */
export async function loadToolsFromRegistry(adapterId: string, adapterName: string): Promise<ToolListItem[]> {
  try {
    const response = await MakaioBus.request(ToolSubjects.list, {
      adapterId,
      adapterName,
    });

    return response.tools;
  } catch (error) {
    // Log but don't fail — agent can still work without tools
    console.warn(`[${adapterName}] Failed to fetch tools from bus:`, error);
    return [];
  }
}

/**
 * Filter tools to only those with an inputSchema defined.
 *
 * Most LLM SDKs require a JSON Schema for function calling parameters.
 * Tools without inputSchema cannot be used with native function calling.
 * @param tools - Tools from the registry
 * @returns Tools that have a defined inputSchema
 */
export function filterToolsWithSchema(
  tools: ToolListItem[],
): (ToolListItem & { inputSchema: Record<string, unknown> })[] {
  return tools.filter(
    (tool): tool is ToolListItem & { inputSchema: Record<string, unknown> } => tool.inputSchema !== undefined,
  );
}
