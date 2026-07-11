import { afterEach, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AdapterSubsystemSubjects, type ProviderConfigFileRecord } from '@makaio/services-core/adapter-subsystem';

import { resolveProviderConfigsForAccount } from '../provider-config-resolution.js';

const CLIENT_ID = 'claude-code';
const ACCOUNT_ID = 'acc-test-123';

/**
 * Build one credential-free provider config read model.
 * @param id - Stable provider config identifier.
 * @param auth - Credential-free auth summary.
 * @param managedBy - Optional lifecycle manager identity.
 * @returns Provider config read-model fixture.
 */
function makeConfig(
  id: string,
  auth: ProviderConfigFileRecord['auth'],
  managedBy?: ProviderConfigFileRecord['managedBy'],
): ProviderConfigFileRecord {
  return {
    id,
    definitionId: 'anthropic',
    name: id,
    modelFilterMode: 'show-all',
    isDefault: false,
    enabled: true,
    auth,
    ...(managedBy ? { managedBy } : {}),
  };
}

/**
 * Build one inferred native-auth summary for the test client.
 * @param account - Optional exact native-account selector.
 * @returns Inferred auth summary fixture.
 */
function makeInferredAuth(account?: { managerId: string; accountId: string }): ProviderConfigFileRecord['auth'] {
  return {
    mode: 'inferred',
    method: { owner: 'client', clientId: CLIENT_ID, methodId: 'native' },
    ...(account ? { account } : {}),
    hasCredentials: false,
  };
}

describe('resolveProviderConfigsForAccount', () => {
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
  });

  it('returns an empty result when provider-config reads are unavailable', async () => {
    await expect(resolveProviderConfigsForAccount(createBusInstance(), CLIENT_ID, ACCOUNT_ID)).resolves.toEqual([]);
  });

  it('matches an account-pinned inferred config by exact manager, client, and account identity', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            makeConfig('cfg-pinned', makeInferredAuth({ managerId: 'account-manager', accountId: ACCOUNT_ID })),
          ],
        });
      }),
    );

    await expect(resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID)).resolves.toEqual([
      { providerConfigId: 'cfg-pinned', definitionId: 'anthropic' },
    ]);
  });

  it('matches inferred configs without a selector because they follow the current native account', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({ configs: [makeConfig('cfg-native-current', makeInferredAuth())] });
      }),
    );

    await expect(resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID)).resolves.toEqual([
      { providerConfigId: 'cfg-native-current', definitionId: 'anthropic' },
    ]);
  });

  it('rejects mismatched managers, accounts, clients, and explicit auth', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            makeConfig('cfg-manager', makeInferredAuth({ managerId: 'other-manager', accountId: ACCOUNT_ID })),
            makeConfig('cfg-account', makeInferredAuth({ managerId: 'account-manager', accountId: 'other' })),
            makeConfig('cfg-client', {
              mode: 'inferred',
              method: { owner: 'client', clientId: 'codex', methodId: 'native' },
              hasCredentials: false,
            }),
            makeConfig('cfg-explicit', {
              mode: 'explicit',
              method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
              hasCredentials: true,
            }),
          ],
        });
      }),
    );

    await expect(resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID)).resolves.toEqual([]);
  });

  it('keeps lifecycle ownership independent from account selection', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            makeConfig('cfg-user-owned', makeInferredAuth({ managerId: 'account-manager', accountId: ACCOUNT_ID })),
            makeConfig('cfg-client-managed', makeInferredAuth(), { kind: 'client', clientId: CLIENT_ID }),
          ],
        });
      }),
    );

    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result.map(({ providerConfigId }) => providerConfigId)).toEqual(['cfg-user-owned', 'cfg-client-managed']);
  });
});
