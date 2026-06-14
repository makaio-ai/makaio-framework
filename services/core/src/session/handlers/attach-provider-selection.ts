import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext, ResolvedAgentConfig } from '@makaio/contracts';
import { buildProviderContext } from '../session-orchestrator-helpers.js';

/**
 * Resolve the effective provider selection for attach-time agent startup.
 *
 * Converts public provider config IDs into runtime provider execution contexts,
 * while preserving already resolved contexts from local framework-internal
 * startup paths.
 * @param bus - Bus instance for provider resolution
 * @param explicitProviderConfigId - Provider config selected explicitly on the agent selection
 * @param resolved - Agent resolution result (persona/profile/virtualModel), or null for adapter kind
 * @param resolvedProviderContext - Local-only already resolved provider execution context
 * @returns Merged provider ID plus the resolved runtime provider context
 */
export async function resolveAttachProviderSelection(
  bus: IMakaioBus,
  explicitProviderConfigId: string | undefined,
  resolved: ResolvedAgentConfig | null,
  resolvedProviderContext?: ProviderContext,
): Promise<{ providerConfigId: string | undefined; providerContext: ProviderContext | undefined }> {
  if (
    resolvedProviderContext !== undefined &&
    explicitProviderConfigId !== undefined &&
    explicitProviderConfigId !== resolvedProviderContext.providerConfigId
  ) {
    throw new Error(
      `[attach-handler] providerConfigId '${explicitProviderConfigId}' does not match resolved provider context '${resolvedProviderContext.providerConfigId}'`,
    );
  }

  const providerConfigId =
    explicitProviderConfigId ?? resolvedProviderContext?.providerConfigId ?? resolved?.providerConfigId;
  if (resolvedProviderContext !== undefined) {
    return { providerConfigId, providerContext: resolvedProviderContext };
  }
  const providerContext =
    providerConfigId !== undefined ? await buildProviderContext(bus, providerConfigId) : undefined;
  return { providerConfigId, providerContext };
}
