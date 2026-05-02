import type { ToolInfo } from '@makaio/tools-core';
import type { ToolsetInfo, ToolsetPolicy, ToolsetPolicyProvider } from './types.js';

/**
 * Result of applying policy-based filtering to tools and toolsets.
 */
export interface PolicyFilterResult {
  filteredTools: ToolInfo[];
  filteredToolsets: ToolsetInfo[];
}

/**
 * Applies policy-based filtering to tools and toolsets.
 * Filters out toolsets not allowed for the adapter and disabled tools.
 * @param tools - Tools to filter
 * @param toolsets - Toolsets to filter
 * @param adapterName - Adapter name for allowedAdapters check
 * @param policyProvider - Provider function for toolset policies
 * @returns Filtered tools and toolsets
 */
export async function applyPolicyFilter(
  tools: ToolInfo[],
  toolsets: ToolsetInfo[],
  adapterName: string,
  policyProvider: ToolsetPolicyProvider,
): Promise<PolicyFilterResult> {
  // Collect policies for all toolsets
  const policies = new Map<string, ToolsetPolicy | null>();
  for (const toolset of toolsets) {
    policies.set(toolset.name, await policyProvider(toolset.name));
  }

  // Filter toolsets: hide if adapter not in allowedAdapters
  const filteredToolsets = toolsets.filter((toolset) => {
    const policy = policies.get(toolset.name);
    if (!policy?.allowedAdapters || policy.allowedAdapters.length === 0) {
      return true; // No restrictions = allow
    }
    return policy.allowedAdapters.includes(adapterName);
  });

  // Build set of allowed toolset names for efficient lookup
  const allowedToolsetNames = new Set(filteredToolsets.map((t) => t.name));

  // Filter tools: remove if toolset is hidden OR tool is in disabledTools
  const filteredTools = tools.filter((tool) => {
    // Exclude if toolset is not allowed
    if (!allowedToolsetNames.has(tool.toolsetName)) {
      return false;
    }
    // Exclude if tool is disabled
    const policy = policies.get(tool.toolsetName);
    if (policy?.disabledTools?.includes(tool.name)) {
      return false;
    }
    return true;
  });

  return { filteredTools, filteredToolsets };
}
