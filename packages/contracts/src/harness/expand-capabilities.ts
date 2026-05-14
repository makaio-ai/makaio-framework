/**
 * Capability expansion helpers shared by policy and resolution layers.
 *
 * These helpers are contract-owned because external consumers need the same
 * canonical capability-to-tool expansion behavior without importing the
 * harness service implementation package.
 * @packageDocumentation
 */

import type { MakaioBusLike } from '@makaio/core';
import type { ToolCapability } from '../tool-capability/index.js';
import { HarnessSubjects } from './namespace.js';

/**
 * Looks up the declared capabilities for a tool name.
 * @param toolName - Adapter-native tool name (e.g., 'bash', 'Read')
 * @param capabilityMap - Map of tool names to their declared capabilities
 * @returns Declared capabilities, or empty array if the tool has no capability mapping
 */
export function getToolCapabilities(
  toolName: string,
  capabilityMap: Readonly<Record<string, readonly ToolCapability[]>>,
): readonly ToolCapability[] {
  return capabilityMap[toolName] ?? [];
}

/** Input parameters for {@link expandCapabilities}. */
export interface ExpandCapabilitiesParams {
  /** Tool names currently registered/enabled by the active harness. */
  registeredTools: readonly string[];
  /**
   * Capabilities to allow. When empty, no capability-based filtering is
   * applied and `allowedTools` in the result will be empty.
   *
   * Callers are expected to merge the returned `allowedTools` with any
   * explicit `allowedTools` from the profile (Stance B overrides) at
   * resolution time; this function does not handle that merge.
   */
  allowedCapabilities: readonly ToolCapability[];
  /** Capabilities to disallow. */
  disallowedCapabilities: readonly ToolCapability[];
  /** Map of tool names to their declared capabilities. */
  capabilityMap: Readonly<Record<string, readonly ToolCapability[]>>;
}

/** Expanded concrete tool name lists produced by {@link expandCapabilities}. */
export interface ExpandCapabilitiesResult {
  /** Tool names whose capabilities are all within the allowed set. */
  allowedTools: string[];
  /** Tool names that have at least one disallowed capability. */
  disallowedTools: string[];
}

/**
 * Expands capability filters to concrete tool names using the ALL-match rule.
 * Only tools present in `registeredTools` are evaluated.
 *
 * A tool is included in `allowedTools` only if all its capabilities fall within
 * the allowed set. A tool is included in `disallowedTools` if any of its
 * capabilities falls within the disallowed set.
 *
 * Explicit `allowedTools` overrides (Stance B) are intentionally not handled
 * here; that merge belongs to the caller.
 * @param params - Expansion parameters; see {@link ExpandCapabilitiesParams}.
 * @returns Expanded tool name lists; see {@link ExpandCapabilitiesResult}.
 */
export function expandCapabilities(params: ExpandCapabilitiesParams): ExpandCapabilitiesResult {
  const { registeredTools, allowedCapabilities, disallowedCapabilities, capabilityMap } = params;

  const allowedSet = new Set<ToolCapability>(allowedCapabilities);
  const disallowedSet = new Set<ToolCapability>(disallowedCapabilities);

  const allowedTools: string[] = [];
  const disallowedTools: string[] = [];

  for (const toolName of registeredTools) {
    const capabilities = getToolCapabilities(toolName, capabilityMap);

    // Tools with no declared capabilities are excluded from allowed (unknown = not allowed)
    if (allowedCapabilities.length > 0 && capabilities.length > 0 && capabilities.every((cap) => allowedSet.has(cap))) {
      allowedTools.push(toolName);
    }

    if (capabilities.some((cap) => disallowedSet.has(cap))) {
      disallowedTools.push(toolName);
    }
  }

  return { allowedTools, disallowedTools };
}

/**
 * Config shape consumed by {@link expandProfileToolCapabilities}.
 * Matches the common subset shared by ProfileDefinition, Persona, and ad-hoc
 * SubagentConfig-level callers.
 */
export interface ProfileToolCapabilitiesConfig {
  /** Capabilities to allow; drives expansion to concrete tool names. */
  allowedCapabilities?: readonly ToolCapability[];
  /** Capabilities to disallow; drives expansion to concrete tool names. */
  disallowedCapabilities?: readonly ToolCapability[];
  /** Harness ID used to load the capability map and registered tools. */
  harnessId?: string;
  /** Explicit allowed tool names to union with expanded results (Stance B). */
  allowedTools?: readonly string[];
  /** Explicit disallowed tool names to union with expanded results (Stance B). */
  disallowedTools?: readonly string[];
}

type EmptyCapabilityResult = {
  allowedTools?: string[];
  disallowedTools?: string[];
};

/**
 * Merges two lists, deduplicating results. Returns the base list (or undefined)
 * when `extra` is empty.
 *
 * Empty arrays are preserved intentionally: callers use `[]` to express an
 * explicit "allow/disallow nothing" value, which is semantically different
 * from `undefined` (unspecified).
 * @param base - Base list of tool names
 * @param extra - Expanded tool names to union in
 * @returns Merged list or base value unchanged
 */
function unionTools(base: readonly string[] | undefined, extra: string[]): string[] | undefined {
  if (extra.length === 0) return base ? [...base] : undefined;
  return [...new Set([...(base ?? []), ...extra])];
}

/**
 * Returns the unchanged explicit tool lists (with unionTools normalization).
 * @param allowedTools - Explicit allowed tool names
 * @param disallowedTools - Explicit disallowed tool names
 * @returns Result preserving explicit lists when expansion is skipped
 */
function emptyCapabilityResult(
  allowedTools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
): EmptyCapabilityResult {
  return {
    allowedTools: unionTools(allowedTools, []),
    disallowedTools: unionTools(disallowedTools, []),
  };
}

/**
 * Expands capability-based filters from a profile-like config into concrete
 * tool names, loading the harness capability map via bus.
 *
 * This is a no-op when no capability fields are set, when `harnessId` is
 * absent, or when the resolved harness has no `toolCapabilityMap`. In all
 * these cases the explicit `allowedTools` / `disallowedTools` are returned
 * unchanged.
 *
 * Results are unioned with the explicit tool lists (Stance B): explicit names
 * are never removed by capability expansion.
 * @param bus - Bus for harness RPC
 * @param config - Object with capability and explicit tool list fields
 * @returns Expanded `allowedTools` and `disallowedTools` (Stance B union applied)
 */
export async function expandProfileToolCapabilities(
  bus: MakaioBusLike,
  config: ProfileToolCapabilitiesConfig,
): Promise<{ allowedTools?: string[]; disallowedTools?: string[] }> {
  const { allowedCapabilities, disallowedCapabilities, harnessId, allowedTools, disallowedTools } = config;

  const hasCapabilities = Boolean((allowedCapabilities?.length ?? 0) || (disallowedCapabilities?.length ?? 0));

  if (!hasCapabilities || !harnessId) {
    return emptyCapabilityResult(allowedTools, disallowedTools);
  }

  const harness = await bus.request(HarnessSubjects.get, { id: harnessId });

  if (!harness.toolCapabilityMap) {
    return emptyCapabilityResult(allowedTools, disallowedTools);
  }

  const expanded = expandCapabilities({
    registeredTools: harness.nativeTools.enabled,
    allowedCapabilities: allowedCapabilities ?? [],
    disallowedCapabilities: disallowedCapabilities ?? [],
    capabilityMap: harness.toolCapabilityMap,
  });

  return {
    allowedTools: unionTools(allowedTools, expanded.allowedTools),
    disallowedTools: unionTools(disallowedTools, expanded.disallowedTools),
  };
}
