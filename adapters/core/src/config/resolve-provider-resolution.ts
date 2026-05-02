import type { ProtocolId } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import type { ProviderConfigFileRecord } from '@makaio/services-core/adapter-subsystem';
import type { ProviderRecord } from '@makaio/services-core/settings/storage';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import type { IMakaioBus } from '@makaio/bus-core';
import { resolveConnectorCredentials } from './resolve-connector-credentials.js';

/**
 * Fully resolved provider data returned by {@link resolveProviderResolution}.
 *
 * Callers use this to build protocol-specific outputs (e.g. adapter config,
 * HTTP endpoint) without duplicating the lookup chain.
 */
export interface ProviderResolution {
  /** Bus-safe provider config read model from the adapter subsystem. */
  config: ProviderConfigFileRecord;
  /** The ProviderDefinition record referenced by the config. */
  definition: ProviderRecord;
  /**
   * Resolved base URL for the requested protocol.
   * `null` when neither the config override nor the definition declares an
   * endpoint for the requested protocol.
   */
  baseUrl: string | null;
  /**
   * Plaintext credentials resolved from the config's credential refs.
   * Empty object when no credentials are configured or none resolve.
   */
  credentials: Record<string, string>;
}

/**
 * Resolve a ProviderConfig to its full runtime data: config record,
 * definition record, endpoint URL, and plaintext credentials.
 *
 * Encapsulates the common lookup chain shared by the adapter config factory
 * and the provider endpoint resolver:
 * 1. `AdapterSubsystemSubjects.getProviderConfig` for the canonical read model
 * 2. `AdapterSubsystemSubjects.buildProviderContext` for runtime credential refs and endpoint overrides
 * 3. `ProviderStorageSubjects.get` for provider-definition metadata
 * 4. `context.endpointOverrides?.[protocol] ?? definition.endpoints?.[protocol]`
 * 5. Opens a DirectChannel via `CredentialSubjects.getChannelToken` and
 *    resolves each credential ref; the channel is closed after use.
 *
 * Callers keep only their differing post-resolution logic (e.g., strict
 * `baseUrl` / `apiKey` validation for HTTP bridges vs. nullable `baseUrl`
 * for adapter factories that allow env-var fallbacks).
 * @param bus - Bus instance for storage and credential requests
 * @param providerConfigId - UUID of the ProviderConfig to resolve
 * @param protocol - Wire protocol used to select the correct endpoint URL
 * @returns Fully resolved provider data
 * @throws Error when the ProviderConfig or its ProviderDefinition is not found
 */
export async function resolveProviderResolution(
  bus: IMakaioBus,
  providerConfigId: string,
  protocol: ProtocolId,
): Promise<ProviderResolution> {
  const { config } = await bus.request(AdapterSubsystemSubjects.getProviderConfig, { id: providerConfigId });
  if (!config) {
    throw new Error(`ProviderConfig '${providerConfigId}' not found`);
  }
  // ProviderContext intentionally carries only bus-safe runtime context, not
  // the ProviderRecord; keep the definition read explicit instead of widening
  // the subsystem runtime seam with storage-owned records.
  const { context } = await bus.request(AdapterSubsystemSubjects.buildProviderContext, { providerConfigId });
  if (!context) {
    throw new Error(`ProviderConfig '${providerConfigId}' not found`);
  }
  if (context.definitionId !== config.definitionId) {
    throw new Error(`ProviderConfig '${providerConfigId}' changed during resolution; retry`);
  }

  const { provider: definition } = await bus.request(ProviderStorageSubjects.get, { id: context.definitionId });

  if (!definition) {
    throw new Error(`ProviderDefinition '${config.definitionId}' not found for config '${providerConfigId}'`);
  }

  const baseUrl = context.endpointOverrides?.[protocol] ?? definition.endpoints?.[protocol] ?? null;

  const credentials = await resolveConnectorCredentials(bus, context.credentialRefs);

  return { config, definition, baseUrl, credentials };
}
