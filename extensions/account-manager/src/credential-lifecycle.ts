import type { IMakaioBus } from '@makaio/bus-core';
import { CredentialSubjects, SessionSubjects } from '@makaio/contracts';
import { buildAccountManagerCredentialRef } from '@makaio/contracts/config';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { nextCredentialChangeSequence } from '@makaio/services-core/credential-change';
import { ClientStorageSubjects, type ClientRecord } from '@makaio/services-core/settings/storage';

import { resolveProviderConfigsForAccount } from './provider-config-resolution.js';

const ACCOUNT_MANAGER_REF_PREFIX = 'account-manager:';

/**
 * Build an opaque account-manager credential/source ref from stable coordinates.
 * @param clientId - Account-manager client identifier
 * @param accountId - Stable account identifier
 * @returns Collision-free opaque ref payload
 */
export function createAccountManagerRef(clientId: string, accountId: string): string {
  return buildAccountManagerCredentialRef(clientId, accountId);
}

/**
 * Parse an account-manager credential ref into client/account coordinates.
 *
 * The ref payload is a JSON tuple `[clientId, accountId]` prefixed by
 * `account-manager:` so both IDs stay opaque and may contain delimiters.
 * `accountId` is the stable UUID assigned at first detection (see
 * `CredentialTracker.handleNewAccount`). It is never derived from or equal to
 * a fingerprint — fingerprint transitions (UUID ↔ hash, rotation) flow through
 * `reconcileFingerprint`, which preserves the UUID `id`, so existing refs
 * remain valid across fingerprint-format changes.
 * @param ref - Credential reference to inspect
 * @returns Parsed parts, or null when the ref is not account-manager-owned
 */
export function parseAccountManagerRef(ref: string): { clientId: string; accountId: string } | null {
  if (!ref.startsWith(ACCOUNT_MANAGER_REF_PREFIX)) {
    return null;
  }

  try {
    const tuple = JSON.parse(ref.slice(ACCOUNT_MANAGER_REF_PREFIX.length)) as unknown;
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== 'string' ||
      typeof tuple[1] !== 'string' ||
      tuple[0].length === 0 ||
      tuple[1].length === 0
    ) {
      return null;
    }
    return { clientId: tuple[0], accountId: tuple[1] };
  } catch {
    return null;
  }
}

/**
 * Resolve the client record whose managed auth matches the provider definition.
 * @param bus - Bus used for client storage lookups
 * @param definitionId - Provider definition being activated
 * @returns Matching client record, or null when none exists
 */
export async function resolveClientByDefinitionId(
  bus: IMakaioBus,
  definitionId: string,
): Promise<Pick<ClientRecord, 'id' | 'defaultProviderId'> | null> {
  const { clients } = await bus.request(ClientStorageSubjects.list, {});
  return clients.find((client) => client.defaultProviderId === definitionId) ?? null;
}

/**
 * Resolve the client record for a known account-manager client ID.
 * @param bus - Bus used for client storage lookups
 * @param clientId - Account-manager client identifier
 * @returns Matching client record, or null when the registry has no entry
 */
export async function resolveClientById(
  bus: IMakaioBus,
  clientId: string,
): Promise<Pick<ClientRecord, 'id' | 'defaultProviderId'> | null> {
  const result = await bus.requestOptional(ClientStorageSubjects.get, { id: clientId });
  if (!result.handled) {
    return null;
  }
  return result.data.client;
}

/**
 * Check whether a provider config is owned by account-manager.
 *
 * Account-backed configs expose an `account-manager:` sourceRef. Sentinel configs
 * are also account-manager managed even though they do not carry a sourceRef.
 * @param bus - Bus used for provider-config lookups
 * @param providerConfigId - Provider config ID from the activation payload
 * @returns `true` when the config belongs to account-manager
 */
export async function isAccountManagerManagedProviderConfig(
  bus: IMakaioBus,
  providerConfigId: string,
): Promise<boolean> {
  const configListResult = await bus.requestOptional(AdapterSubsystemSubjects.listProviderConfigs, {});
  if (!configListResult.handled) {
    return false;
  }

  const config = configListResult.data.configs.find((entry) => entry.id === providerConfigId);
  if (!config) {
    return false;
  }

  return config.isSentinel || (config.sourceRef !== undefined && parseAccountManagerRef(config.sourceRef) !== null);
}

/**
 * Fan credential rotation out to active sessions using configs owned by this client.
 * @param bus - Bus used for config/session discovery and fanout
 * @param clientId - Account-manager client identifier
 * @param activeAccountId - Newly active account ID
 * @returns Resolves when all relevant sessions have been notified
 */
export async function emitCredentialChangedForClient(
  bus: IMakaioBus,
  clientId: string,
  activeAccountId: string,
): Promise<void> {
  const [relevantConfigs, sessionListResult] = await Promise.all([
    resolveProviderConfigsForAccount(bus, clientId, activeAccountId),
    bus.requestOptional(SessionSubjects.list, { status: 'active' }),
  ]);

  if (relevantConfigs.length === 0) {
    return;
  }

  const sessionList = sessionListResult.handled ? sessionListResult.data.sessions : [];
  if (sessionList.length === 0) {
    return;
  }

  const deliveredDispatches = new Set<string>();
  for (const config of relevantConfigs) {
    const affectedSessions = sessionList.filter((session) =>
      session.agents.some((agent) => agent.providerConfigId === config.providerConfigId),
    );
    if (affectedSessions.length === 0) {
      continue;
    }

    const { context: providerContext } = await bus.request(AdapterSubsystemSubjects.buildProviderContext, {
      providerConfigId: config.providerConfigId,
    });
    if (!providerContext) {
      console.warn('[AccountManager] provider config disappeared during credential fan-out:', {
        clientId,
        providerConfigId: config.providerConfigId,
      });
      continue;
    }
    const changeSequence = nextCredentialChangeSequence(bus, config.providerConfigId);

    for (const session of affectedSessions) {
      const dispatchKey = JSON.stringify([session.sessionId, config.providerConfigId]);
      if (deliveredDispatches.has(dispatchKey)) {
        continue;
      }
      deliveredDispatches.add(dispatchKey);

      await bus
        .request(CredentialSubjects.changed, {
          sessionId: session.sessionId,
          providerConfigId: config.providerConfigId,
          definitionId: providerContext.definitionId,
          changeSequence,
          credentialRefs: providerContext.credentialRefs,
        })
        .catch((error: unknown) => {
          console.warn('[AccountManager] credential.changed dispatch failed:', {
            clientId,
            sessionId: session.sessionId,
            providerConfigId: config.providerConfigId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}
