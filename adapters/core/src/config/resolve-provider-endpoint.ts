import type { IMakaioBus } from '@makaio/bus-core';
import type { ProtocolId } from '@makaio/contracts';
import { resolveProviderResolution } from './resolve-provider-resolution.js';

/**
 * Resolved HTTP endpoint credentials for a provider.
 * Returned by {@link resolveProviderEndpoint} for use by infrastructure-layer
 * consumers (bridges, cloud STT/TTS clients, etc.) that need to make direct
 * HTTP calls to a provider API without an agent context.
 */
export interface ProviderEndpoint {
  /** Base URL for the provider's HTTP API. */
  baseUrl: string;
  /**
   * API key for authenticating requests to the provider.
   * This helper is intentionally scoped to apiKey-authenticated HTTP providers.
   */
  apiKey: string;
}

/**
 * Resolve `{ baseUrl, apiKey }` for a given provider config and wire protocol
 * without requiring an agent context.
 *
 * Intended for infrastructure-layer consumers (e.g., adapter-voice-bridge, cloud
 * STT/TTS providers) that need to make HTTP calls to cloud providers but are not
 * part of an agent turn.
 *
 * Delegates the common lookup chain (config → definition → endpoint → credentials)
 * to {@link resolveProviderResolution} and applies strict validation on the result:
 * both `baseUrl` and `apiKey` must be present or an error is thrown.
 *
 * Resolution order for the endpoint URL:
 * 1. `ProviderConfig.endpointOverrides[protocol]` (user-customised URL)
 * 2. `ProviderDefinition.endpoints[protocol]` (default from provider package)
 *
 * Credentials are resolved from the config's stored credential refs via the bus.
 * @param bus - Makaio bus instance used to query storage and resolve credential refs
 * @param providerConfigId - UUID of the ProviderConfig entity to resolve
 * @param protocol - Wire protocol to select the correct endpoint URL
 * @returns Resolved `{ baseUrl, apiKey }` for the provider
 * @throws Error when the ProviderConfig or its ProviderDefinition is not found, or
 *   when `baseUrl` or `apiKey` cannot be resolved from any source
 */
export async function resolveProviderEndpoint(
  bus: IMakaioBus,
  providerConfigId: string,
  protocol: ProtocolId,
): Promise<ProviderEndpoint> {
  const { baseUrl, credentials } = await resolveProviderResolution(bus, providerConfigId, protocol);

  if (!baseUrl) {
    throw new Error(
      `Could not resolve baseUrl for ProviderConfig '${providerConfigId}' with protocol '${protocol}'. ` +
        'Ensure the provider definition or config override declares an endpoint for this protocol.',
    );
  }

  const apiKey = credentials['apiKey'];

  if (!apiKey) {
    throw new Error(
      `Could not resolve apiKey for ProviderConfig '${providerConfigId}'. ` +
        'Store credentials via settings before using this provider.',
    );
  }

  return { baseUrl, apiKey };
}
