import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus, createBusInstance } from '@makaio/bus-core';
import {
  CredentialSubjects,
  SessionSubjects,
  defineAdapterProviderAuth,
  type ResolvedProviderContext,
} from '@makaio/contracts';
import {
  AdapterSubsystemSubjects,
  type AdapterRuntimeSnapshotResolution,
  type ProviderConfigFileRecord,
  type ProviderRuntimeSnapshot,
} from '@makaio/services-core/adapter-subsystem';
import { resetCredentialChangeSequences } from '@makaio/services-core/credential-change';

import { AccountManager } from '../account-manager.js';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';

/**
 * Create a test credential with a deterministic fingerprint.
 * @param token - Credential token used by the fixture.
 * @param meta - Optional credential metadata.
 */
function makeCredential(token: string, meta: Record<string, unknown> = {}): RawCredential {
  return { token, fingerprint: computeFingerprint(token), metadata: meta };
}

/**
 * Build normalized inferred auth for a current or account-pinned native client.
 * @param accountId - Optional account selected through the manager.
 * @param managerId - Account-manager identity recorded in the selector.
 */
function makeInferredAuth(accountId?: string, managerId = 'account-manager') {
  return {
    mode: 'inferred' as const,
    method: { owner: 'client' as const, clientId: 'claude-code', methodId: 'native' },
    ...(accountId ? { account: { managerId, accountId } } : {}),
  };
}

/**
 * Build a complete refs-only provider context for native Claude auth.
 * @param providerConfigId - Provider config represented by the context.
 * @param accountId - Optional native account selected by the context.
 */
function makeProviderContext(providerConfigId: string, accountId?: string): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId: 'anthropic',
    auth: {
      ...makeInferredAuth(accountId),
      definition: { id: 'native', mode: 'inferred', label: 'Native Claude Code' },
    },
  };
}

/**
 * Build the credential-free read model corresponding to a runtime context.
 * @param context - Runtime context summarized by the config record.
 */
function makeConfigRecord(context: ResolvedProviderContext): ProviderConfigFileRecord {
  if (context.auth.mode !== 'inferred') {
    throw new Error('Account-manager test config must use inferred authentication.');
  }
  return {
    id: context.providerConfigId,
    definitionId: context.definitionId,
    name: context.providerConfigId,
    modelFilterMode: 'show-all',
    isDefault: false,
    enabled: true,
    auth: {
      mode: 'inferred',
      method: context.auth.method,
      ...(context.auth.account ? { account: context.auth.account } : {}),
      hasCredentials: false,
    },
  };
}

/**
 * Build a validated atomic provider-runtime snapshot for the context helper.
 * @param context - Runtime context represented by the snapshot.
 */
function makeRuntimeSnapshot(context: ResolvedProviderContext): ProviderRuntimeSnapshot {
  return {
    config: makeConfigRecord(context),
    context,
    definition: {
      id: 'anthropic',
      packageName: '@makaio/provider-anthropic',
      name: 'Anthropic',
      availableModels: [],
      authMethods: [],
      defaultModelFilterMode: 'show-all',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/**
 * Build an adapter-qualified atomic runtime response for one fan-out consumer.
 * @param context - Runtime context represented by the response.
 * @param adapterName - Exact adapter selected by the consumer.
 */
function makeAdapterRuntimeResolution(
  context: ResolvedProviderContext,
  adapterName: string,
): AdapterRuntimeSnapshotResolution {
  return {
    status: 'resolved',
    runtime: {
      snapshot: makeRuntimeSnapshot(context),
      adapterName,
      adapterClientId: 'claude-code',
      adapterProviderAuth: defineAdapterProviderAuth({
        bindings: [
          {
            method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
            deliveries: [{ kind: 'native-client', clientId: 'claude-code' }],
          },
        ],
        scrubEnvVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
      }),
      compatibleProviderAuths: [],
      runtimePackages: {
        adapter: { packageName: `@makaio/adapter-${adapterName}` },
        provider: { packageName: '@makaio/provider-anthropic', definitionId: 'anthropic' },
        client: { packageName: '@makaio/client-claude-code', clientId: 'claude-code' },
      },
    },
  };
}

/**
 * Build one active session with agents bound to the supplied config IDs.
 * @param sessionId - Stable session identity.
 * @param providerConfigIds - Provider configs selected by the session agents.
 * @param adapterNames - Optional adapter names paired with the provider configs.
 */
function makeSession(sessionId: string, providerConfigIds: string[], adapterNames: string[] = []) {
  return {
    sessionId,
    createdAt: 1,
    lastActivityAt: 1,
    status: 'active' as const,
    agents: providerConfigIds.map((providerConfigId, index) => ({
      agentId: `agent-${index + 1}`,
      adapterId: `adapter-${index + 1}`,
      adapterName: adapterNames[index] ?? 'claude-code-cli',
      sessionId,
      role: index === 0 ? ('lead' as const) : ('member' as const),
      status: 'idle' as const,
      createdAt: 1,
      lastActivityAt: 1,
      providerConfigId,
    })),
  };
}

describe('AccountManager bus handlers', () => {
  let source: InMemoryCredentialSource;
  let store: InMemoryAccountStore;
  let service: AccountManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetCredentialChangeSequences(MakaioBus);
    source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    store = new InMemoryAccountStore();
    service = new AccountManager(MakaioBus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    vi.useRealTimers();
  });

  it('lists public accounts without credential material', async () => {
    source.setCredential(makeCredential('token-1'));
    await vi.advanceTimersByTimeAsync(1000);

    const result = await MakaioBus.request(AccountManagerSubjects.accounts.list, { clientId: 'claude-code' });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].id).toMatch(/^[0-9a-f-]+$/);
    expect('credential' in result.accounts[0]).toBe(false);
  });

  it('returns the active account and null before any account exists', async () => {
    await expect(
      MakaioBus.request(AccountManagerSubjects.accounts.getActive, { clientId: 'claude-code' }),
    ).resolves.toEqual({ account: null });

    source.setCredential(makeCredential('token-1'));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await MakaioBus.request(AccountManagerSubjects.accounts.getActive, { clientId: 'claude-code' });
    expect(result.account).toMatchObject({ active: true });
  });

  it('reports available credential sources', async () => {
    const result = await MakaioBus.request(AccountManagerSubjects.accounts.getSources, {});
    expect(result.sources).toContainEqual(
      expect.objectContaining({ clientId: 'claude-code', displayName: 'Claude Code', available: true }),
    );
  });

  it('credential.activate writes the exact normalized account selection to native storage', async () => {
    const accountId = '00000000-0000-0000-0000-000000000001';
    const target = makeCredential('token-target');
    await store.upsert('claude-code', {
      id: accountId,
      fingerprint: target.fingerprint,
      label: 'Target',
      metadata: {},
      active: false,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: target,
    });
    source.setCredential(makeCredential('token-other'));

    const result = await MakaioBus.request(CredentialSubjects.activate, {
      providerContext: makeProviderContext('provider-config-1', accountId),
    });

    expect(result).toEqual({ success: true });
    expect(source.getLastWritten()).toEqual(target);
    expect((await store.list('claude-code')).find((account) => account.active)?.id).toBe(accountId);
  });

  it('credential.activate refreshes the selected credential before writing', async () => {
    const accountId = '00000000-0000-0000-0000-000000000005';
    const expired = makeCredential('token-expired');
    const refreshed = makeCredential('token-refreshed');
    await store.upsert('claude-code', {
      id: accountId,
      fingerprint: expired.fingerprint,
      label: 'Expired',
      metadata: {},
      active: false,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: expired,
    });
    source.setCredential(null);
    source.setRefreshHandler(async () => ({ status: 'refreshed', credential: refreshed }));

    await expect(
      MakaioBus.request(CredentialSubjects.activate, {
        providerContext: makeProviderContext('provider-config-1', accountId),
      }),
    ).resolves.toEqual({ success: true });
    expect(source.getLastWritten()).toEqual(refreshed);
  });

  it('credential.activate reports a typed missing-account failure without mutating native state', async () => {
    const result = await MakaioBus.request(CredentialSubjects.activate, {
      providerContext: makeProviderContext('provider-config-1', 'missing-account'),
    });

    expect(result).toEqual({ success: false, code: 'account-not-found' });
    expect(source.getLastWritten()).toBeUndefined();
  });

  it('credential.activate falls through when another manager owns the selector', async () => {
    const context = makeProviderContext('provider-config-1', 'account-1');
    if (context.auth.mode !== 'inferred' || !context.auth.account) throw new Error('Expected inferred auth fixture.');
    context.auth.account.managerId = 'other-manager';

    await expect(MakaioBus.requestOptional(CredentialSubjects.activate, { providerContext: context })).resolves.toEqual(
      { handled: false },
    );
  });

  it('consumes prepared activation tokens exactly once', async () => {
    const accountId = '00000000-0000-0000-0000-000000000006';
    const target = makeCredential('token-transaction');
    await store.upsert('claude-code', {
      id: accountId,
      fingerprint: target.fingerprint,
      label: 'Transaction target',
      metadata: {},
      active: false,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: target,
    });

    const prepared = await MakaioBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-transaction', accountId),
    });
    if (!prepared.success) throw new Error('Expected activation transaction to prepare.');

    await expect(
      MakaioBus.request(CredentialSubjects.activation.commit, { transactionId: prepared.transactionId }),
    ).resolves.toEqual({ success: true });
    await expect(
      MakaioBus.request(CredentialSubjects.activation.commit, { transactionId: prepared.transactionId }),
    ).resolves.toEqual({ success: false, code: 'transaction-not-found' });
    await expect(
      MakaioBus.request(CredentialSubjects.activation.rollback, { transactionId: prepared.transactionId }),
    ).resolves.toEqual({ success: false, code: 'transaction-not-found' });
  });

  it('retains an in-flight finalization through shutdown and rejects competing terminal decisions', async () => {
    const accountId = '00000000-0000-0000-0000-000000000106';
    const target = makeCredential('token-finalization-in-flight');
    await store.upsert('claude-code', {
      id: accountId,
      fingerprint: target.fingerprint,
      label: 'In-flight target',
      metadata: {},
      active: false,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: target,
    });
    const commitStarted = Promise.withResolvers<void>();
    const continueCommit = Promise.withResolvers<void>();
    const appendTimeline = store.metadataStore.appendTimeline.bind(store.metadataStore);
    vi.spyOn(store.metadataStore, 'appendTimeline').mockImplementation(async (entry) => {
      commitStarted.resolve();
      await continueCommit.promise;
      await appendTimeline(entry);
    });

    const prepared = await MakaioBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-finalization-in-flight', accountId),
    });
    if (!prepared.success) throw new Error('Expected activation transaction to prepare.');
    const commit = MakaioBus.request(CredentialSubjects.activation.commit, {
      transactionId: prepared.transactionId,
    });
    await commitStarted.promise;

    let destroySettled = false;
    const destroy = service.destroy().then(() => {
      destroySettled = true;
    });
    await Promise.resolve();
    const settledBeforeCommit = destroySettled;
    const duplicateCommit = MakaioBus.request(CredentialSubjects.activation.commit, {
      transactionId: prepared.transactionId,
    });
    const conflictingRollback = MakaioBus.request(CredentialSubjects.activation.rollback, {
      transactionId: prepared.transactionId,
    });
    continueCommit.resolve();

    await expect(commit).resolves.toEqual({ success: true });
    await expect(duplicateCommit).resolves.toEqual({ success: false, code: 'transaction-not-found' });
    await expect(conflictingRollback).resolves.toEqual({ success: false, code: 'transaction-not-found' });
    await destroy;
    expect(settledBeforeCommit).toBe(false);
  });

  it('closes prepare admission before shutdown rolls back an accepted in-flight preparation', async () => {
    class PausingFirstWriteSource extends InMemoryCredentialSource {
      public readonly writeStarted = Promise.withResolvers<void>();
      public readonly continueWrite = Promise.withResolvers<void>();
      private writeCount = 0;

      public override async write(credential: RawCredential): Promise<void> {
        this.writeCount += 1;
        if (this.writeCount === 1) {
          this.writeStarted.resolve();
          await this.continueWrite.promise;
        }
        await super.write(credential);
      }
    }

    await service.destroy();
    const isolatedBus = createBusInstance();
    const pausingSource = new PausingFirstWriteSource('claude-code', 'Claude Code');
    const isolatedStore = new InMemoryAccountStore();
    service = new AccountManager(isolatedBus, {
      sources: [pausingSource],
      credentialStore: isolatedStore.credentialStore,
      metadataStore: isolatedStore.metadataStore,
      usageSnapshotStore: isolatedStore.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();
    const accountId = '00000000-0000-0000-0000-000000000107';
    const target = makeCredential('token-prepare-during-shutdown');
    await isolatedStore.upsert('claude-code', {
      id: accountId,
      fingerprint: target.fingerprint,
      label: 'Preparing target',
      metadata: {},
      active: false,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: target,
    });

    const acceptedPrepare = isolatedBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-accepted-before-shutdown', accountId),
    });
    await pausingSource.writeStarted.promise;
    let destroySettled = false;
    const destroy = service.destroy().then(() => {
      destroySettled = true;
    });
    const latePrepare = isolatedBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-rejected-during-shutdown', accountId),
    });
    await Promise.resolve();
    const settledBeforeWrite = destroySettled;
    pausingSource.continueWrite.resolve();

    await expect(acceptedPrepare).resolves.toEqual({ success: false, code: 'activation-failed' });
    await expect(latePrepare).resolves.toEqual({ success: false, code: 'activation-failed' });
    await destroy;
    expect(settledBeforeWrite).toBe(false);
    await expect(pausingSource.read()).resolves.toBeNull();
    await expect(isolatedStore.metadataStore.getActive('claude-code')).resolves.toBeNull();
  });

  it('keeps prepare admission closed when initialization fails after handlers register', async () => {
    await service.destroy();
    const isolatedBus = createBusInstance();
    const isolatedSource = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const isolatedStore = new InMemoryAccountStore();
    const accountId = '00000000-0000-0000-0000-000000000206';
    const target = makeCredential('token-never-admitted-during-init');
    await isolatedStore.upsert('claude-code', {
      id: accountId,
      fingerprint: target.fingerprint,
      label: 'Initialization target',
      metadata: {},
      active: false,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: target,
    });
    isolatedSource.setAvailable(false);
    const syncStarted = Promise.withResolvers<void>();
    const failSync = Promise.withResolvers<void>();
    const list = isolatedStore.metadataStore.list.bind(isolatedStore.metadataStore);
    let listCalls = 0;
    vi.spyOn(isolatedStore.metadataStore, 'list').mockImplementation(async (clientId) => {
      listCalls += 1;
      if (listCalls === 2) {
        syncStarted.resolve();
        await failSync.promise;
        throw new Error('startup account sync failed');
      }
      return list(clientId);
    });
    service = new AccountManager(isolatedBus, {
      sources: [isolatedSource],
      credentialStore: isolatedStore.credentialStore,
      metadataStore: isolatedStore.metadataStore,
      usageSnapshotStore: isolatedStore.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });

    const initialization = service.init();
    const initializationResult = initialization.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await syncStarted.promise;
    await expect(
      isolatedBus.request(CredentialSubjects.activation.prepare, {
        providerContext: makeProviderContext('provider-config-during-failed-init', accountId),
      }),
    ).resolves.toEqual({ success: false, code: 'activation-failed' });
    failSync.resolve();

    await expect(initializationResult).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'startup account sync failed' }),
    });
    expect(await isolatedSource.read()).toBeNull();
  });

  it('clears native credentials when rolling back to previous account absence', async () => {
    const accountId = '00000000-0000-0000-0000-000000000007';
    const target = makeCredential('token-first-native');
    await store.upsert('claude-code', {
      id: accountId,
      fingerprint: target.fingerprint,
      label: 'First native account',
      metadata: {},
      active: false,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: target,
    });
    source.setCredential(null);

    const prepared = await MakaioBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-first-native', accountId),
    });
    if (!prepared.success) throw new Error('Expected activation transaction to prepare.');
    expect(await source.read()).toEqual(target);

    await expect(
      MakaioBus.request(CredentialSubjects.activation.rollback, { transactionId: prepared.transactionId }),
    ).resolves.toEqual({ success: true });
    expect(await source.read()).toBeNull();
    expect(await store.metadataStore.getActive('claude-code')).toBeNull();
  });

  it('keeps the prepared durable selection when native rollback is superseded by a newer generation', async () => {
    const accountAId = '00000000-0000-0000-0000-000000000207';
    const accountBId = '00000000-0000-0000-0000-000000000208';
    const accountA = makeCredential('token-before-superseded-rollback');
    const accountB = makeCredential('token-prepared-before-refresh');
    const refreshedAccountB = makeCredential('token-refreshed-during-connector-start');
    await store.upsert('claude-code', {
      id: accountAId,
      fingerprint: accountA.fingerprint,
      label: 'Previous',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: accountA,
    });
    await store.upsert('claude-code', {
      id: accountBId,
      fingerprint: accountB.fingerprint,
      label: 'Prepared target',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: accountB,
    });
    source.setCredential(accountA);

    const prepared = await MakaioBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-superseded-rollback', accountBId),
    });
    if (!prepared.success) throw new Error('Expected activation transaction to prepare.');
    source.setCredential(refreshedAccountB);

    await expect(
      MakaioBus.request(CredentialSubjects.activation.rollback, { transactionId: prepared.transactionId }),
    ).resolves.toEqual({ success: false, code: 'rollback-failed' });
    expect(await source.read()).toEqual(refreshedAccountB);
    expect(await store.metadataStore.getActive('claude-code')).toMatchObject({ id: accountBId });
  });

  it('aborts and fully restores a prepare whose native write coordination is uncertain', async () => {
    class UncertainPreparedWriteSource extends InMemoryCredentialSource {
      public override async prepareNativeCredentialMutation(credential: RawCredential) {
        const prepared = await super.prepareNativeCredentialMutation(credential);
        return { ...prepared, coordination: 'uncertain' as const };
      }
    }

    await service.destroy();
    const isolatedBus = createBusInstance();
    const uncertainSource = new UncertainPreparedWriteSource('claude-code', 'Claude Code');
    const isolatedStore = new InMemoryAccountStore();
    service = new AccountManager(isolatedBus, {
      sources: [uncertainSource],
      credentialStore: isolatedStore.credentialStore,
      metadataStore: isolatedStore.metadataStore,
      usageSnapshotStore: isolatedStore.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();
    const accountAId = '00000000-0000-0000-0000-000000000209';
    const accountBId = '00000000-0000-0000-0000-00000000020a';
    const accountA = makeCredential('token-before-uncertain-write');
    const accountB = makeCredential('token-uncertain-write');
    await isolatedStore.upsert('claude-code', {
      id: accountAId,
      fingerprint: accountA.fingerprint,
      label: 'Previous',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: accountA,
    });
    await isolatedStore.upsert('claude-code', {
      id: accountBId,
      fingerprint: accountB.fingerprint,
      label: 'Uncertain target',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: accountB,
    });
    uncertainSource.setCredential(accountA);

    await expect(
      isolatedBus.request(CredentialSubjects.activation.prepare, {
        providerContext: makeProviderContext('provider-config-uncertain-write', accountBId),
      }),
    ).resolves.toEqual({ success: false, code: 'activation-failed' });
    expect(await uncertainSource.read()).toEqual(accountA);
    expect(await isolatedStore.metadataStore.getActive('claude-code')).toMatchObject({ id: accountAId });
  });

  it('surfaces uncertain rollback coordination after restoring native and durable state', async () => {
    class UncertainRollbackSource extends InMemoryCredentialSource {
      public override async prepareNativeCredentialMutation(credential: RawCredential) {
        const prepared = await super.prepareNativeCredentialMutation(credential);
        return {
          ...prepared,
          rollback: async () => ({ ...(await prepared.rollback()), coordination: 'uncertain' as const }),
        };
      }
    }

    await service.destroy();
    const isolatedBus = createBusInstance();
    const uncertainSource = new UncertainRollbackSource('claude-code', 'Claude Code');
    const isolatedStore = new InMemoryAccountStore();
    service = new AccountManager(isolatedBus, {
      sources: [uncertainSource],
      credentialStore: isolatedStore.credentialStore,
      metadataStore: isolatedStore.metadataStore,
      usageSnapshotStore: isolatedStore.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();
    const accountAId = '00000000-0000-0000-0000-00000000020b';
    const accountBId = '00000000-0000-0000-0000-00000000020c';
    const accountA = makeCredential('token-before-uncertain-rollback');
    const accountB = makeCredential('token-before-rollback');
    for (const account of [
      { id: accountAId, credential: accountA, active: true, detectedAt: 1 },
      { id: accountBId, credential: accountB, active: false, detectedAt: 2 },
    ]) {
      await isolatedStore.upsert('claude-code', {
        id: account.id,
        fingerprint: account.credential.fingerprint,
        label: account.active ? 'Previous' : 'Target',
        metadata: {},
        active: account.active,
        detectedAt: account.detectedAt,
        lastSeenAt: account.detectedAt,
        credential: account.credential,
      });
    }
    uncertainSource.setCredential(accountA);

    const prepared = await isolatedBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-uncertain-rollback', accountBId),
    });
    if (!prepared.success) throw new Error('Expected activation transaction to prepare.');
    await expect(
      isolatedBus.request(CredentialSubjects.activation.rollback, { transactionId: prepared.transactionId }),
    ).resolves.toEqual({ success: false, code: 'rollback-failed' });
    expect(await uncertainSource.read()).toEqual(accountA);
    expect(await isolatedStore.metadataStore.getActive('claude-code')).toMatchObject({ id: accountAId });
  });

  it('self-rolls back native and durable state when strict commit persistence fails', async () => {
    const accountAId = '00000000-0000-0000-0000-000000000008';
    const accountBId = '00000000-0000-0000-0000-000000000009';
    const accountA = makeCredential('token-before-commit');
    const accountB = makeCredential('token-commit-target');
    await store.upsert('claude-code', {
      id: accountAId,
      fingerprint: accountA.fingerprint,
      label: 'Before',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: accountA,
    });
    await store.upsert('claude-code', {
      id: accountBId,
      fingerprint: accountB.fingerprint,
      label: 'Target',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: accountB,
    });
    source.setCredential(accountA);
    vi.spyOn(store.metadataStore, 'appendTimeline').mockRejectedValueOnce(new Error('timeline unavailable'));

    const prepared = await MakaioBus.request(CredentialSubjects.activation.prepare, {
      providerContext: makeProviderContext('provider-config-strict-commit', accountBId),
    });
    if (!prepared.success) throw new Error('Expected activation transaction to prepare.');
    expect(await source.read()).toEqual(accountB);

    await expect(
      MakaioBus.request(CredentialSubjects.activation.commit, { transactionId: prepared.transactionId }),
    ).resolves.toEqual({ success: false, code: 'commit-failed' });
    expect(await source.read()).toEqual(accountA);
    expect(await store.metadataStore.getActive('claude-code')).toMatchObject({ id: accountAId });
  });

  it('switchAccount emits full normalized contexts for pinned and current-native configs', async () => {
    const accountA = '00000000-0000-0000-0000-00000000000a';
    const accountB = '00000000-0000-0000-0000-00000000000b';
    await seedSwitchAccounts(store, accountA, accountB);
    const pinned = makeProviderContext('cfg-account', accountB);
    const currentNative = makeProviderContext('cfg-native-current');
    const cleanups = registerFanoutFixtures(
      [pinned, currentNative],
      [makeSession('session-1', ['cfg-account', 'cfg-native-current'])],
    );
    const changedPayloads: unknown[] = [];
    cleanups.push(
      MakaioBus.on(CredentialSubjects.changed, (ctx) => {
        changedPayloads.push(ctx.payload);
        ctx.setResult({});
      }),
    );

    try {
      await expect(
        MakaioBus.request(AccountManagerSubjects.credentials.switch, {
          clientId: 'claude-code',
          accountId: accountB,
        }),
      ).resolves.toEqual({ success: true });
      expect(changedPayloads).toEqual([
        { sessionId: 'session-1', changeSequence: 1, providerContext: pinned },
        { sessionId: 'session-1', changeSequence: 1, providerContext: currentNative },
      ]);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('continues credential fan-out when one matching config disappears', async () => {
    const accountA = '00000000-0000-0000-0000-00000000001a';
    const accountB = '00000000-0000-0000-0000-00000000001b';
    await seedSwitchAccounts(store, accountA, accountB);
    const broken = makeProviderContext('cfg-broken', accountB);
    const good = makeProviderContext('cfg-good', accountB);
    const cleanups = registerFanoutFixtures(
      [broken, good],
      [makeSession('session-broken', ['cfg-broken']), makeSession('session-good', ['cfg-good'])],
      new Set(['cfg-broken']),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changedPayloads: unknown[] = [];
    cleanups.push(
      MakaioBus.on(CredentialSubjects.changed, (ctx) => {
        changedPayloads.push(ctx.payload);
        ctx.setResult({});
      }),
    );

    try {
      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: accountB,
      });
      expect(changedPayloads).toEqual([{ sessionId: 'session-good', changeSequence: 1, providerContext: good }]);
      expect(warnSpy).toHaveBeenCalledWith('[AccountManager] provider config unavailable during credential fan-out:', {
        clientId: 'claude-code',
        adapterName: 'claude-code-cli',
        providerConfigId: 'cfg-broken',
      });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      warnSpy.mockRestore();
    }
  });

  it('emits credential.changed once for duplicate config read rows', async () => {
    const accountA = '00000000-0000-0000-0000-00000000002a';
    const accountB = '00000000-0000-0000-0000-00000000002b';
    await seedSwitchAccounts(store, accountA, accountB);
    const context = makeProviderContext('cfg-overlap', accountB);
    const cleanups = registerFanoutFixtures([context, context], [makeSession('session-overlap', ['cfg-overlap'])]);
    const changedPayloads: unknown[] = [];
    cleanups.push(
      MakaioBus.on(CredentialSubjects.changed, (ctx) => {
        changedPayloads.push(ctx.payload);
        ctx.setResult({});
      }),
    );

    try {
      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: accountB,
      });
      expect(changedPayloads).toEqual([{ sessionId: 'session-overlap', changeSequence: 1, providerContext: context }]);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('resolves one atomic context per affected adapter and reuses it across sessions', async () => {
    const accountA = '00000000-0000-0000-0000-00000000003a';
    const accountB = '00000000-0000-0000-0000-00000000003b';
    await seedSwitchAccounts(store, accountA, accountB);
    const context = makeProviderContext('cfg-shared', accountB);
    const runtimeReads: Array<{ adapterName: string; providerConfigId: string }> = [];
    const cleanups = registerFanoutFixtures(
      [context],
      [
        makeSession('session-cli-1', ['cfg-shared'], ['claude-code-cli']),
        makeSession('session-cli-2', ['cfg-shared'], ['claude-code-cli']),
        makeSession('session-sdk', ['cfg-shared'], ['claude-agent-sdk']),
      ],
      new Set(),
      runtimeReads,
    );
    const changedPayloads: unknown[] = [];
    cleanups.push(
      MakaioBus.on(CredentialSubjects.changed, (ctx) => {
        changedPayloads.push(ctx.payload);
        ctx.setResult({});
      }),
    );

    try {
      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: accountB,
      });

      expect(runtimeReads).toEqual([
        { adapterName: 'claude-code-cli', providerConfigId: 'cfg-shared' },
        { adapterName: 'claude-agent-sdk', providerConfigId: 'cfg-shared' },
      ]);
      expect(changedPayloads).toEqual([
        { sessionId: 'session-cli-1', changeSequence: 1, providerContext: context },
        { sessionId: 'session-cli-2', changeSequence: 1, providerContext: context },
        { sessionId: 'session-sdk', changeSequence: 1, providerContext: context },
      ]);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('labels and removes accounts through the public handlers', async () => {
    source.setCredential(makeCredential('token-1'));
    await vi.advanceTimersByTimeAsync(1000);
    const accountId = (await store.list('claude-code'))[0].id;

    await expect(
      MakaioBus.request(AccountManagerSubjects.accounts.label, {
        clientId: 'claude-code',
        accountId,
        label: 'Work',
      }),
    ).resolves.toEqual({ success: true });
    expect((await store.list('claude-code'))[0].label).toBe('Work');

    await expect(
      MakaioBus.request(AccountManagerSubjects.accounts.remove, { clientId: 'claude-code', accountId }),
    ).resolves.toEqual({ success: true });
    expect(await store.list('claude-code')).toHaveLength(0);
  });

  it('configureFileMode reports unsupported sources', async () => {
    const result = await MakaioBus.request(AccountManagerSubjects.credentials.configureFileMode, {
      clientId: 'claude-code',
    });
    expect(result).toMatchObject({ success: false });
  });

  it('configureFileMode invokes a supported source', async () => {
    let called = false;
    class FileModeSupportedSource extends InMemoryCredentialSource {
      public async configureFileMode(): Promise<void> {
        called = true;
      }
    }

    const isolatedBus = createBusInstance();
    const isolatedStore = new InMemoryAccountStore();
    const isolatedService = new AccountManager(isolatedBus, {
      sources: [new FileModeSupportedSource('claude-code-fm', 'Claude Code FM')],
      credentialStore: isolatedStore.credentialStore,
      metadataStore: isolatedStore.metadataStore,
      usageSnapshotStore: isolatedStore.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await isolatedService.init();
    try {
      await expect(
        isolatedBus.request(AccountManagerSubjects.credentials.configureFileMode, { clientId: 'claude-code-fm' }),
      ).resolves.toEqual({ success: true });
      expect(called).toBe(true);
    } finally {
      await isolatedService.destroy();
    }
  });
});

/**
 * Seed an active A account and inactive B account for switch tests.
 * @param store - In-memory account store populated for the switch.
 * @param accountA - Initially active account identifier.
 * @param accountB - Initially inactive account identifier.
 */
async function seedSwitchAccounts(store: InMemoryAccountStore, accountA: string, accountB: string): Promise<void> {
  const credentialA = makeCredential(`token-${accountA}`);
  const credentialB = makeCredential(`token-${accountB}`);
  await store.upsert('claude-code', {
    id: accountA,
    fingerprint: credentialA.fingerprint,
    label: 'A',
    metadata: {},
    active: true,
    detectedAt: 1,
    lastSeenAt: 1,
    credential: credentialA,
  });
  await store.upsert('claude-code', {
    id: accountB,
    fingerprint: credentialB.fingerprint,
    label: 'B',
    metadata: {},
    active: false,
    detectedAt: 1,
    lastSeenAt: 1,
    credential: credentialB,
  });
}

/**
 * Register config, runtime-snapshot, and active-session fan-out fixtures.
 * @param contexts - Provider contexts exposed through the runtime handlers.
 * @param sessions - Active sessions returned by the session-list handler.
 * @param missingConfigIds - Config IDs resolved as missing.
 * @param runtimeReads - Collector for adapter-qualified runtime requests.
 */
function registerFanoutFixtures(
  contexts: ResolvedProviderContext[],
  sessions: ReturnType<typeof makeSession>[],
  missingConfigIds: ReadonlySet<string> = new Set(),
  runtimeReads: Array<{ adapterName: string; providerConfigId: string }> = [],
): Array<() => void> {
  const contextById = new Map(contexts.map((context) => [context.providerConfigId, context]));
  return [
    MakaioBus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      ctx.setResult({ configs: contexts.map(makeConfigRecord) });
    }),
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      runtimeReads.push(ctx.payload);
      const context = contextById.get(ctx.payload.providerConfigId);
      if (!context || missingConfigIds.has(ctx.payload.providerConfigId)) {
        ctx.setResult({ status: 'error', code: 'provider-config-not-found' });
        return;
      }
      ctx.setResult(makeAdapterRuntimeResolution(context, ctx.payload.adapterName));
    }),
    MakaioBus.on(SessionSubjects.list, (ctx) => {
      ctx.setResult({ sessions, total: sessions.length });
    }),
  ];
}
