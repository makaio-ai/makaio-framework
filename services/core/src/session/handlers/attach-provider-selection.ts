import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext, ResolvedAgentConfig } from '@makaio/contracts';
import { resolveRuntimeProviderContext, RuntimeProviderContextResolutionError } from '../../provider-context/index.js';

/**
 * Resolve the effective provider selection for attach-time agent startup.
 *
 * Converts public provider config IDs into runtime provider execution contexts,
 * while preserving already resolved contexts from local framework-internal
 * startup paths.
 * @param bus - Bus instance for provider resolution
 * @param adapterName - Adapter selected for the attach-time execution
 * @param explicitProviderConfigId - Provider config selected explicitly on the agent selection
 * @param resolved - Agent resolution result (persona/profile/virtualModel), or null for adapter kind
 * @param resolvedProviderContext - Local-only already resolved provider execution context
 * @returns Merged provider ID plus the resolved runtime provider context
 */
export async function resolveAttachProviderSelection(
  bus: IMakaioBus,
  adapterName: string,
  explicitProviderConfigId: string | undefined,
  resolved: ResolvedAgentConfig | null,
  resolvedProviderContext?: ProviderContext,
): Promise<{ providerConfigId: string | undefined; providerContext: ProviderContext | undefined }> {
  const suppliedProviderConfigId =
    resolvedProviderContext?.state === 'resolved' ? resolvedProviderContext.providerConfigId : undefined;
  if (
    suppliedProviderConfigId !== undefined &&
    explicitProviderConfigId !== undefined &&
    explicitProviderConfigId !== suppliedProviderConfigId
  ) {
    throw new Error(
      `[attach-handler] providerConfigId '${explicitProviderConfigId}' does not match resolved provider context '${suppliedProviderConfigId}'`,
    );
  }

  const providerConfigId = explicitProviderConfigId ?? suppliedProviderConfigId ?? resolved?.providerConfigId;
  if (resolvedProviderContext !== undefined) {
    if (resolvedProviderContext.state !== 'resolved' && providerConfigId !== undefined) {
      throw new RuntimeProviderContextResolutionError('provider-context-unresolved', adapterName, providerConfigId);
    }
    return { providerConfigId, providerContext: resolvedProviderContext };
  }
  const providerContext =
    providerConfigId !== undefined
      ? await resolveRuntimeProviderContext(bus, { adapterName, providerConfigId })
      : undefined;
  return { providerConfigId, providerContext };
}
