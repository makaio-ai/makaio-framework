import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext } from '@makaio/contracts';
import { type ProviderConfigFile, brandCredentialRecord } from '@makaio/contracts/config';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';

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
  const endpointOverrides = { ...(provider.endpoints ?? {}), ...(raw.endpointOverrides ?? {}) };
  return {
    providerConfigId,
    definitionId: provider.id,
    ...(Object.keys(endpointOverrides).length > 0 ? { endpointOverrides } : {}),
    credentialRefs: brandCredentialRecord(raw.credentials) ?? {},
    ...(provider.credentialEnvVars ? { credentialEnvVars: { ...provider.credentialEnvVars } } : {}),
  };
}
