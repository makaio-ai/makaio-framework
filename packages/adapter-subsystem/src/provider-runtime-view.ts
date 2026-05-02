import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext } from '@makaio/contracts';
import { type ProviderConfigFile, brandCredentialRecord } from '@makaio/contracts/config';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import type { ProviderRecord } from '@makaio/services-core/settings/storage';

/**
 * Build provider context from one captured raw provider-config snapshot.
 * @param bus - Bus used to resolve provider-definition metadata.
 * @param providerConfigId - Provider config identifier.
 * @param raw - Raw canonical provider-config file from the captured snapshot.
 * @returns Bus-safe runtime provider context.
 */
export async function buildProviderContextFromRaw(
  bus: IMakaioBus,
  providerConfigId: string,
  raw: ProviderConfigFile,
): Promise<ProviderContext> {
  const { provider } = await bus.request(ProviderStorageSubjects.get, { id: raw.definitionId });
  if (!provider) {
    throw new Error(`ProviderDefinition '${raw.definitionId}' not found for config '${providerConfigId}'`);
  }
  const providers = await listProvidersForAmbientCredentials(bus, provider);
  const endpointOverrides = { ...(provider.endpoints ?? {}), ...(raw.endpointOverrides ?? {}) };
  const ambientCredentialEnvVars = collectCredentialEnvVars(providers);
  return {
    providerConfigId,
    definitionId: provider.id,
    ...(Object.keys(endpointOverrides).length > 0 ? { endpointOverrides } : {}),
    credentialRefs: brandCredentialRecord(raw.credentials) ?? {},
    ...(provider.credentialEnvVars ? { credentialEnvVars: { ...provider.credentialEnvVars } } : {}),
    ...(ambientCredentialEnvVars.length > 0 ? { ambientCredentialEnvVars } : {}),
  };
}

/**
 * Reads all known providers for ambient credential cleanup, falling back to the
 * selected provider when storage listing is unavailable during early boot.
 * @param bus - Bus used to query provider storage
 * @param provider - Selected provider definition for this context
 * @returns Provider definitions visible for ambient credential discovery
 */
async function listProvidersForAmbientCredentials(
  bus: IMakaioBus,
  provider: ProviderRecord,
): Promise<readonly ProviderRecord[]> {
  try {
    const providerListResult = await bus.requestOptional(ProviderStorageSubjects.list, {});
    return providerListResult.handled ? providerListResult.data.providers : [provider];
  } catch (error) {
    console.debug('[AdapterSubsystem] Provider list unavailable for ambient credential discovery', error);
    return [provider];
  }
}

/**
 * Collect provider credential env var names from provider records.
 * @param providers - Provider records visible to the host
 * @returns Unique credential environment variable names
 */
function collectCredentialEnvVars(providers: readonly ProviderRecord[]): string[] {
  return [
    ...new Set(
      providers.flatMap((provider) => (provider.credentialEnvVars ? Object.values(provider.credentialEnvVars) : [])),
    ),
  ];
}
