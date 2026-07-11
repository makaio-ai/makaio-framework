import type { IMakaioBus } from '@makaio/bus-core';
import { CredentialSubjects, SessionSubjects, type ResolvedProviderContext } from '@makaio/contracts';
import { nextCredentialChangeSequence } from '@makaio/services-core/credential-change';
import { resolveRuntimeProviderContext } from '@makaio/services-core/provider-context';

import { authFollowsActivatedAccount, resolveProviderConfigsForAccount } from './provider-config-resolution.js';

/**
 * Fan credential rotation out to active sessions using normalized inferred
 * configs for this client and account.
 * @param bus - Bus used for config/session discovery and fan-out.
 * @param clientId - Account-manager client identifier.
 * @param activeAccountId - Newly active account ID.
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
  const uniqueConfigs = new Map(relevantConfigs.map((config) => [config.providerConfigId, config]));
  for (const config of uniqueConfigs.values()) {
    const sessionsByAdapter = new Map<string, typeof sessionList>();
    for (const session of sessionList) {
      const affectedAdapterNames = new Set(
        session.agents
          .filter((agent) => agent.providerConfigId === config.providerConfigId)
          .map((agent) => agent.adapterName),
      );
      for (const adapterName of affectedAdapterNames) {
        const sessions = sessionsByAdapter.get(adapterName) ?? [];
        sessions.push(session);
        sessionsByAdapter.set(adapterName, sessions);
      }
    }
    if (sessionsByAdapter.size === 0) {
      continue;
    }

    let changeSequence: ReturnType<typeof nextCredentialChangeSequence> | undefined;
    for (const [adapterName, affectedSessions] of sessionsByAdapter) {
      let providerContext: ResolvedProviderContext;
      try {
        providerContext = await resolveRuntimeProviderContext(bus, {
          adapterName,
          providerConfigId: config.providerConfigId,
        });
      } catch {
        console.warn('[AccountManager] provider config unavailable during credential fan-out:', {
          clientId,
          adapterName,
          providerConfigId: config.providerConfigId,
        });
        continue;
      }
      if (!authFollowsActivatedAccount(providerContext.auth, clientId, activeAccountId)) {
        continue;
      }

      changeSequence ??= nextCredentialChangeSequence(bus, config.providerConfigId);
      for (const session of affectedSessions) {
        const dispatchKey = JSON.stringify([session.sessionId, config.providerConfigId]);
        if (deliveredDispatches.has(dispatchKey)) {
          continue;
        }
        deliveredDispatches.add(dispatchKey);

        await bus
          .request(CredentialSubjects.changed, {
            sessionId: session.sessionId,
            changeSequence,
            providerContext,
          })
          .catch(() => {
            console.warn('[AccountManager] credential.changed dispatch failed:', {
              clientId,
              sessionId: session.sessionId,
              providerConfigId: config.providerConfigId,
            });
          });
      }
    }
  }
}
