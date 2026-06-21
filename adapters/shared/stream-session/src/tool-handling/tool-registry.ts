/**
 * Shared tool registry integration.
 *
 * Pure functions for loading and filtering tools from the central ToolRegistry
 * via the global MakaioBus. This logic is identical across all stream-based
 * adapters that use the registry pattern.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { type ToolListItem, ToolSubjects } from '@makaio/contracts';

export interface ToolRegistryLoadOptions {
  /** Allowed tool names. Empty array intentionally disables all registry tools. */
  allowedTools?: readonly string[];
  /** Disallowed tool names. Takes precedence over allowedTools. */
  disallowedTools?: readonly string[];
}

/**
 * Apply adapter runtime tool filters to registry results before SDK conversion.
 * @param tools - Registry tools returned by ToolSubjects.list.
 * @param options - Optional adapter runtime tool allow/deny filters.
 * @returns Tools that remain visible to the adapter SDK.
 */
function applyToolNameFilter(tools: ToolListItem[], options?: ToolRegistryLoadOptions): ToolListItem[] {
  if (options === undefined || (options.allowedTools === undefined && options.disallowedTools === undefined)) {
    return tools;
  }

  const allowed = options.allowedTools !== undefined ? new Set(options.allowedTools) : undefined;
  const disallowed = options.disallowedTools !== undefined ? new Set(options.disallowedTools) : undefined;

  return tools.filter((tool) => {
    if (disallowed?.has(tool.name)) return false;
    if (allowed !== undefined && !allowed.has(tool.name)) return false;
    return true;
  });
}

/**
 * Load tools from ToolRegistry via MakaioBus.
 *
 * Fetches available tools from the central ToolRegistry.
 * Returns raw ToolListItem[] for maximum flexibility so each adapter can
 * convert to its own SDK-specific format.
 *
 * Does not throw on failure — an agent can still operate without tools,
 * so errors are logged and an empty array is returned.
 * @param bus - Bus that owns the ToolRegistry handlers.
 * @param adapterId - Adapter instance ID for logging/routing.
 * @param adapterName - Adapter type name.
 * @param options - Optional adapter runtime tool allow/deny filters.
 * @returns List of available tools, or empty array if fetch fails.
 */
export async function loadToolsFromRegistry(
  bus: IMakaioBus,
  adapterId: string,
  adapterName: string,
  options?: ToolRegistryLoadOptions,
): Promise<ToolListItem[]> {
  try {
    const response = await bus.request(ToolSubjects.list, {
      adapterId,
      adapterName,
    });

    return applyToolNameFilter(response.tools, options);
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
