import { afterEach, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { CredentialSubjects, type ResolvedProviderContext } from '@makaio/contracts';
import { buildStoredCredentialRef } from '@makaio/contracts/config';

import { activateProviderContext, ProviderContextActivationError } from './activate-provider-context.js';

/**
 * Build a normalized native-auth context with an optional account selection.
 * @param accountId - Optional account selected through the account manager.
 */
function makeInferredContext(accountId?: string): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId: 'cfg-native',
    definitionId: 'anthropic',
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native Claude Code' },
      ...(accountId ? { account: { managerId: 'account-manager', accountId } } : {}),
    },
  };
}

describe('activateProviderContext', () => {
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
  });

  it('is a no-op unless inferred auth selects a managed account', async () => {
    const bus = createBusInstance();
    await expect(activateProviderContext(bus, { state: 'unresolved' })).resolves.toBeUndefined();
    await expect(activateProviderContext(bus, makeInferredContext())).resolves.toBeUndefined();
    await expect(
      activateProviderContext(bus, {
        state: 'resolved',
        providerConfigId: 'cfg-explicit',
        definitionId: 'anthropic',
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          definition: {
            id: 'api-key',
            mode: 'explicit',
            label: 'API key',
            fields: [
              {
                id: 'apiKey',
                label: 'API key',
                required: true,
                secret: true,
                sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_API_KEY' }],
              },
            ],
          },
          credentialRefs: { apiKey: buildStoredCredentialRef('cfg-explicit', 'apiKey') },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('passes the complete normalized context to the activation handler', async () => {
    const bus = createBusInstance();
    const providerContext = makeInferredContext('account-1');
    let observed: unknown;
    cleanups.push(
      bus.on(CredentialSubjects.activate, (ctx) => {
        observed = ctx.payload;
        ctx.setResult({ success: true });
      }),
    );

    await activateProviderContext(bus, providerContext);
    expect(observed).toEqual({ providerContext });
  });

  it('fails with a typed error when the selected manager is unavailable', async () => {
    const error = await activateProviderContext(createBusInstance(), makeInferredContext('account-1')).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderContextActivationError);
    expect((error as ProviderContextActivationError).code).toBe('manager-unavailable');
  });

  it('preserves typed account and activation failures without exposing refs', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(CredentialSubjects.activate, (ctx) => {
        ctx.setResult({ success: false, code: 'account-not-found' });
      }),
    );

    const error = await activateProviderContext(bus, makeInferredContext('account-secret-coordinate')).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(ProviderContextActivationError);
    expect((error as ProviderContextActivationError).code).toBe('account-not-found');
    expect(String(error)).not.toContain('account-secret-coordinate');
  });

  it('normalizes handler exceptions to a credential-free activation failure', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(CredentialSubjects.activate, () => {
        throw new Error('upstream error containing secret-token-value');
      }),
    );

    const error = await activateProviderContext(bus, makeInferredContext('account-1')).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderContextActivationError);
    expect((error as ProviderContextActivationError).code).toBe('activation-failed');
    expect(String(error)).not.toContain('secret-token-value');
  });
});
