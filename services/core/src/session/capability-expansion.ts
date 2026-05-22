/**
 * Capability expansion helpers for the session resolution pipeline.
 *
 * These utilities bridge profile capability filters (abstract `ToolCapability`
 * values) to concrete tool name lists by consulting the harness's
 * `toolCapabilityMap` at resolution time.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { expandProfileToolCapabilities, type ProfileToolCapabilitiesConfig } from '@makaio/contracts';

/**
 * Expands capability filters from a profile to concrete tool names, then unions
 * the results with the profile's explicit tool lists (Stance B override).
 *
 * This is a NO-OP when the profile has no capability fields set. If the harness
 * is not found or has no `toolCapabilityMap`, expansion is skipped and the
 * explicit lists are returned unchanged.
 * @param bus - Bus instance for harness RPC
 * @param profile - Profile capability and tool list config
 * @returns Final tool lists after capability expansion and union
 */
export async function expandProfileCapabilities(
  bus: IMakaioBus,
  profile: ProfileToolCapabilitiesConfig,
): Promise<{ allowedTools: string[] | undefined; disallowedTools: string[] | undefined }> {
  // Intentional seam: session layer can add orchestration-specific capability
  // expansion behavior here without changing downstream callers.
  const { allowedTools, disallowedTools } = await expandProfileToolCapabilities(bus, profile);
  return { allowedTools, disallowedTools };
}
