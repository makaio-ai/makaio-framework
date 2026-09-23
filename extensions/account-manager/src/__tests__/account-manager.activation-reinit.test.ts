import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { CredentialSubjects, type ResolvedProviderContext } from '@makaio/contracts';
import { AccountManager } from '../account-manager.js';
import { createDeferredValue } from '../activation-transaction-state.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';

/** An inferred account selection without a stored account. */
const providerContext: ResolvedProviderContext = {
  state: 'resolved',
  providerConfigId: 'reinit-activation-test',
  definitionId: 'anthropic',
  auth: {
    mode: 'inferred',
    method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
    definition: { id: 'native', mode: 'inferred', label: 'Native Claude Code' },
    account: { managerId: 'account-manager', accountId: '00000000-0000-0000-0000-000000000371' },
  },
};

describe('AccountManager activation lifecycle', () => {
  it('rejects a prepare captured before teardown after the same service is initialized again', async () => {
    const bus = createBusInstance();
    const store = new InMemoryAccountStore();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const manager = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 100_000,
      makaioCommand: 'makaio-test',
    });
    const entered = createDeferredValue<void>();
    const release = createDeferredValue<void>();
    let first = true;
    const unsubscribe = bus.on(
      CredentialSubjects.activation.prepare,
      async (ctx) => {
        if (first) {
          first = false;
          entered.resolve(undefined);
          await release.promise;
        }
        await ctx.next();
      },
      { priority: 100 },
    );

    try {
      await manager.init();
      const stale = bus.request(CredentialSubjects.activation.prepare, { providerContext });
      await entered.promise;
      await manager.destroy();
      await manager.init();
      release.resolve(undefined);

      await expect(stale).resolves.toEqual({ success: false, code: 'activation-failed' });
      await expect(bus.request(CredentialSubjects.activation.prepare, { providerContext })).resolves.toEqual({
        success: false,
        code: 'account-not-found',
      });
    } finally {
      release.resolve(undefined);
      await manager.destroy();
      unsubscribe();
    }
  });
});
