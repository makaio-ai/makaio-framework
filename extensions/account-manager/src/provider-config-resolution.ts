import type { IMakaioBus } from '@makaio/bus-core';
import { buildAccountManagerCredentialRef } from '@makaio/contracts/config';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ClientStorageSubjects } from '@makaio/services-core/settings/storage';

/**
 * Resolved provider config context for an account-manager account.
 *
 * Carries the minimal fields needed to route credential changes and to
 * identify the owning provider definition.
 */
export interface ResolvedProviderConfig {
  /** Stable provider config identifier. */
  providerConfigId: string;
  /** Provider definition this config is bound to. */
  definitionId: string;
  /** Whether this config is the sentinel (default) config for the definition. */
  isSentinel: boolean;
}

/**
 * Resolve the provider configs that are owned by a given account-manager account.
 *
 * A config is considered owned when either:
 * - Its `sourceRef` matches the account-manager credential ref for
 *   `(clientId, accountId)` (direct binding), or
 * - It is a sentinel config whose `definitionId` matches the client's
 *   `defaultProviderId` (sentinel fallback, only applicable when the client
 *   record is available).
 *
 * Returns an empty array when the adapter subsystem is unavailable.
 * Falls back to direct `sourceRef` matching only when no client record exists.
 * Direct account-bound configs are returned before sentinel fallbacks so callers
 * that need one primary route prefer account-specific credentials.
 * @param bus - Bus used for provider-config and client-storage lookups
 * @param clientId - Account-manager client identifier
 * @param accountId - Stable account identifier
 * @returns Matching provider configs, or an empty array when none apply
 */
export async function resolveProviderConfigsForAccount(
  bus: IMakaioBus,
  clientId: string,
  accountId: string,
): Promise<ResolvedProviderConfig[]> {
  const [configListResult, clientResult] = await Promise.all([
    bus.requestOptional(AdapterSubsystemSubjects.listProviderConfigs, {}),
    bus.requestOptional(ClientStorageSubjects.get, { id: clientId }),
  ]);

  if (!configListResult.handled) {
    return [];
  }

  const client = clientResult.handled ? clientResult.data.client : null;
  const accountRef = buildAccountManagerCredentialRef(clientId, accountId);
  return configListResult.data.configs
    .filter((config) => {
      if (config.sourceRef === accountRef) {
        return true;
      }
      return (
        client?.defaultProviderId !== undefined && config.isSentinel && config.definitionId === client.defaultProviderId
      );
    })
    .sort((a, b) => Number(a.isSentinel) - Number(b.isSentinel))
    .map((config) => ({
      providerConfigId: config.id,
      definitionId: config.definitionId,
      isSentinel: config.isSentinel,
    }));
}
