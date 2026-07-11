import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';

import { ACCOUNT_MANAGER_ID } from './account-manager-id.js';

interface AccountAuthView {
  readonly mode: string;
  readonly method: {
    readonly owner: string;
    readonly clientId?: string;
  };
  readonly account?: {
    readonly managerId: string;
    readonly accountId: string;
  };
}

/**
 * Check whether inferred auth selects one exact account-manager account.
 * @param auth - Safe or runtime normalized auth view.
 * @param clientId - Expected client owner.
 * @param accountId - Expected selected account.
 * @returns Whether all selector coordinates match exactly.
 */
export function authSelectsAccount(auth: AccountAuthView, clientId: string, accountId: string): boolean {
  return (
    auth.mode === 'inferred' &&
    auth.method.owner === 'client' &&
    auth.method.clientId === clientId &&
    auth.account?.managerId === ACCOUNT_MANAGER_ID &&
    auth.account.accountId === accountId
  );
}

/**
 * Check whether inferred auth follows a newly activated account.
 * @param auth - Safe or runtime normalized auth view.
 * @param clientId - Client whose native account changed.
 * @param accountId - Account that is now active.
 * @returns Whether the config is current-native or selects this exact account.
 */
export function authFollowsActivatedAccount(auth: AccountAuthView, clientId: string, accountId: string): boolean {
  return (
    auth.mode === 'inferred' &&
    auth.method.owner === 'client' &&
    auth.method.clientId === clientId &&
    (auth.account === undefined || authSelectsAccount(auth, clientId, accountId))
  );
}

/** Minimal provider config identity needed for credential-change fan-out. */
export interface ResolvedProviderConfig {
  /** Stable provider config identifier. */
  providerConfigId: string;
  /** Provider definition this config is bound to. */
  definitionId: string;
}

/**
 * Resolve inferred provider configs affected when one account-manager client
 * activates an account.
 *
 * Inferred configs without an account selector follow the client's current
 * native account and therefore rebuild on every switch for that client.
 * Account-pinned configs rebuild only for their exact manager/account pair.
 * Lifecycle ownership (`managedBy`) is deliberately irrelevant to auth.
 * @param bus - Bus used for credential-free provider-config reads.
 * @param clientId - Client whose native account changed.
 * @param accountId - Account that is now active.
 * @returns Matching provider config identities.
 */
export async function resolveProviderConfigsForAccount(
  bus: IMakaioBus,
  clientId: string,
  accountId: string,
): Promise<ResolvedProviderConfig[]> {
  const configListResult = await bus.requestOptional(AdapterSubsystemSubjects.listProviderConfigs, {});
  if (!configListResult.handled) {
    return [];
  }

  return configListResult.data.configs
    .filter((config) => {
      return authFollowsActivatedAccount(config.auth, clientId, accountId);
    })
    .map((config) => ({
      providerConfigId: config.id,
      definitionId: config.definitionId,
    }));
}
