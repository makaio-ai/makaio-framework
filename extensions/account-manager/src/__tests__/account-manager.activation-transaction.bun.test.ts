/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { IAccountMetadataStore, StoredAccount, AccountTimelineEntry } from '../interfaces/account-store.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import { AccountManager } from '../account-manager.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import {
  InMemoryAccountCredentialStore,
  InMemoryAccountMetadataStore,
  InMemoryAccountUsageSnapshotStore,
} from './testing/in-memory-store.js';

function makeCredential(token: string): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: {},
  };
}

async function seedAccount(
  metadataStore: IAccountMetadataStore,
  credentialStore: InMemoryAccountCredentialStore,
  account: StoredAccount,
): Promise<void> {
  await metadataStore.upsert('claude-code', {
    id: account.id,
    label: account.label,
    metadata: account.metadata,
    active: account.active,
    detectedAt: account.detectedAt,
    lastSeenAt: account.lastSeenAt,
  });
  await credentialStore.upsert('claude-code', {
    id: account.id,
    fingerprint: account.fingerprint,
    credential: account.credential,
  });
}

describe('AccountManager activation transaction', () => {
  let source: InMemoryCredentialSource;
  let credentialStore: InMemoryAccountCredentialStore;
  let usageSnapshotStore: InMemoryAccountUsageSnapshotStore;

  beforeEach(() => {
    jest.useFakeTimers();
    source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    credentialStore = new InMemoryAccountCredentialStore();
    usageSnapshotStore = new InMemoryAccountUsageSnapshotStore();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not mutate native storage when durable activation state cannot be persisted', async () => {
    class FailingDeactivateMetadataStore extends InMemoryAccountMetadataStore {
      public override async deactivateAll(clientId: string): Promise<void> {
        void clientId;
        throw new Error('deactivateAll failed');
      }
    }

    const metadataStore = new FailingDeactivateMetadataStore();
    const service = new AccountManager(MakaioBus, {
      sources: [source],
      credentialStore,
      metadataStore,
      usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const accountA = {
      id: 'account-a',
      fingerprint: makeCredential('token-a').fingerprint,
      label: 'A',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: makeCredential('token-a'),
    } satisfies StoredAccount;
    const accountB = {
      id: 'account-b',
      fingerprint: makeCredential('token-b').fingerprint,
      label: 'B',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: makeCredential('token-b'),
    } satisfies StoredAccount;

    await seedAccount(metadataStore, credentialStore, accountA);
    await seedAccount(metadataStore, credentialStore, accountB);

    try {
      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: 'account-b',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('deactivateAll failed');
      expect(source.getLastWritten()).toBeUndefined();
      expect(await metadataStore.getActive('claude-code')).toMatchObject({ id: 'account-a' });
    } finally {
      await service.destroy();
    }
  });

  it('rolls back durable activation state when native storage write fails', async () => {
    class RejectingWriteSource extends InMemoryCredentialSource {
      public override async write(): Promise<void> {
        throw new Error('native write failed');
      }
    }

    const rejectingSource = new RejectingWriteSource('claude-code', 'Claude Code');
    const metadataStore = new InMemoryAccountMetadataStore();
    const service = new AccountManager(MakaioBus, {
      sources: [rejectingSource],
      credentialStore,
      metadataStore,
      usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const accountA = {
      id: 'account-a',
      fingerprint: makeCredential('token-a').fingerprint,
      label: 'A',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: makeCredential('token-a'),
    } satisfies StoredAccount;
    const accountB = {
      id: 'account-b',
      fingerprint: makeCredential('token-b').fingerprint,
      label: 'B',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: makeCredential('token-b'),
    } satisfies StoredAccount;

    await seedAccount(metadataStore, credentialStore, accountA);
    await seedAccount(metadataStore, credentialStore, accountB);

    try {
      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: 'account-b',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('native write failed');
      expect(await metadataStore.getActive('claude-code')).toMatchObject({ id: 'account-a' });
      expect(await credentialStore.get('claude-code', 'account-a')).toMatchObject({
        credential: accountA.credential,
      });
      expect(await credentialStore.get('claude-code', 'account-b')).toMatchObject({
        credential: accountB.credential,
      });
    } finally {
      await service.destroy();
    }
  });

  it('preserves fresher prepared credentials when native storage write fails', async () => {
    class RejectingWriteSource extends InMemoryCredentialSource {
      public override async write(): Promise<void> {
        throw new Error('native write failed');
      }
    }

    const rejectingSource = new RejectingWriteSource('claude-code', 'Claude Code');
    const metadataStore = new InMemoryAccountMetadataStore();
    const service = new AccountManager(MakaioBus, {
      sources: [rejectingSource],
      credentialStore,
      metadataStore,
      usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const staleCredential: RawCredential = { token: 'token-b-stale', fingerprint: 'b', metadata: {} };
    const fresherNativeCredential: RawCredential = { token: 'token-b-fresher', fingerprint: 'b', metadata: {} };
    const accountA = {
      id: 'account-a',
      fingerprint: makeCredential('token-a').fingerprint,
      label: 'A',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: makeCredential('token-a'),
    } satisfies StoredAccount;
    const accountB = {
      id: 'account-b',
      fingerprint: staleCredential.fingerprint,
      label: 'B',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: staleCredential,
    } satisfies StoredAccount;

    await seedAccount(metadataStore, credentialStore, accountA);
    await seedAccount(metadataStore, credentialStore, accountB);
    rejectingSource.setCredentialKeyExtractor((token) => token.split('-')[1] ?? null);
    rejectingSource.setCredential(fresherNativeCredential);

    try {
      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: 'account-b',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('native write failed');
      expect(await metadataStore.getActive('claude-code')).toMatchObject({ id: 'account-a' });
      expect(await credentialStore.get('claude-code', 'account-b')).toMatchObject({
        credential: fresherNativeCredential,
        fingerprint: fresherNativeCredential.fingerprint,
      });
    } finally {
      await service.destroy();
    }
  });

  it('keeps the switch successful when only timeline persistence fails', async () => {
    class FailingTimelineMetadataStore extends InMemoryAccountMetadataStore {
      public override async appendTimeline(entry: AccountTimelineEntry): Promise<void> {
        void entry;
        throw new Error('timeline append failed');
      }
    }

    const metadataStore = new FailingTimelineMetadataStore();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const service = new AccountManager(MakaioBus, {
      sources: [source],
      credentialStore,
      metadataStore,
      usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const accountA = {
      id: 'account-a',
      fingerprint: makeCredential('token-a').fingerprint,
      label: 'A',
      metadata: {},
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
      credential: makeCredential('token-a'),
    } satisfies StoredAccount;
    const accountB = {
      id: 'account-b',
      fingerprint: makeCredential('token-b').fingerprint,
      label: 'B',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: makeCredential('token-b'),
    } satisfies StoredAccount;

    await seedAccount(metadataStore, credentialStore, accountA);
    await seedAccount(metadataStore, credentialStore, accountB);

    try {
      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: 'account-b',
      });

      expect(result.success).toBe(true);
      expect(source.getLastWritten()).toEqual(accountB.credential);
      expect(await metadataStore.getActive('claude-code')).toMatchObject({ id: 'account-b' });
      expect(warnSpy).toHaveBeenCalledWith(
        '[AccountManager] timeline append failed after successful activation:',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
      await service.destroy();
    }
  });
});
