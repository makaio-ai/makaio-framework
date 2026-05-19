/// <reference types="bun-types" />
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DarwinAccountStore } from '../stores/darwin-account-store.js';
import { expectNoTempFiles, makeCredentialRecord } from './testing/credential-fixtures.js';

// ---------------------------------------------------------------------------
// Keychain mock
// ---------------------------------------------------------------------------

const keychainStore = new Map<string, string>();

const keychainReadMock = mock(async (service: string, account?: string) => {
  return keychainStore.get(`${service}:${account ?? ''}`) ?? null;
});

const keychainWriteMock = mock(async (service: string, account: string, value: string) => {
  keychainStore.set(`${service}:${account}`, value);
});

mock.module('../utils/security-cli.js', () => ({
  keychainRead: keychainReadMock,
  keychainWrite: keychainWriteMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'darwin')('DarwinAccountStore', () => {
  /** Root temp dir created per test for full isolation. */
  let tmpDir: string;

  /**
   * Creates a unique temp directory and returns a store path nested one level
   * deep so that directory-creation tests can assert the parent dir was created
   * by the store itself.
   * @returns The store path and a fresh DarwinAccountStore instance
   */
  async function makeTmpStore(): Promise<{ storePath: string; store: DarwinAccountStore }> {
    tmpDir = await mkdtemp(join(tmpdir(), 'darwin-account-store-test-'));
    const storePath = join(tmpDir, 'store', 'accounts.enc');
    return { storePath, store: new DarwinAccountStore(storePath) };
  }

  beforeEach(() => {
    keychainStore.clear();
    keychainReadMock.mockClear();
    keychainWriteMock.mockClear();
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    keychainStore.clear();
  });

  // -------------------------------------------------------------------------
  // Empty store
  // -------------------------------------------------------------------------

  describe('empty store', () => {
    it('list returns [] when the file does not exist', async () => {
      const { store } = await makeTmpStore();
      const accounts = await store.list('claude-code');
      expect(accounts).toEqual([]);
    });

    it('get returns null when the file does not exist', async () => {
      const { store } = await makeTmpStore();
      const account = await store.get('claude-code', 'account-1');
      expect(account).toBeNull();
    });

    it('does not touch the keychain when the store file is absent', async () => {
      const { store } = await makeTmpStore();
      await store.list('claude-code');
      expect(keychainReadMock).not.toHaveBeenCalled();
      expect(keychainWriteMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Basic CRUD round-trip
  // -------------------------------------------------------------------------

  describe('basic CRUD', () => {
    it('upsert then list round-trips the account', async () => {
      const { store } = await makeTmpStore();
      const account = makeCredentialRecord();
      await store.upsert('claude-code', account);
      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toEqual(account);
    });

    it('upsert then get round-trips the account', async () => {
      const { store } = await makeTmpStore();
      const account = makeCredentialRecord();
      await store.upsert('claude-code', account);
      const found = await store.get('claude-code', account.id);
      expect(found).toEqual(account);
    });

    it('get returns null for a non-existent ID when others exist', async () => {
      const { store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord({ id: 'account-1' }));
      const found = await store.get('claude-code', 'account-9999');
      expect(found).toBeNull();
    });

    it('remove deletes the account so list returns empty', async () => {
      const { store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord());
      await store.remove('claude-code', 'account-1');
      const accounts = await store.list('claude-code');
      expect(accounts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Encrypted on disk
  // -------------------------------------------------------------------------

  describe('encryption', () => {
    it('the store file is not plaintext JSON', async () => {
      const { storePath, store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord());

      // Read raw bytes — if encrypted, it must not be valid UTF-8 JSON
      const raw = await readFile(storePath);
      expect(() => JSON.parse(raw.toString('utf-8'))).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Upsert semantics
  // -------------------------------------------------------------------------

  describe('upsert semantics', () => {
    it('updating an existing account does not duplicate it', async () => {
      const { store } = await makeTmpStore();
      await store.upsert(
        'claude-code',
        makeCredentialRecord({
          credential: {
            token: 'tok-original',
            fingerprint: 'fp-original',
            metadata: { planType: 'free' },
          },
          fingerprint: 'fp-original',
        }),
      );
      const updated = makeCredentialRecord({
        credential: {
          token: 'tok-updated',
          fingerprint: 'fp-updated',
          metadata: { planType: 'pro' },
        },
        fingerprint: 'fp-updated',
      });
      await store.upsert('claude-code', updated);

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toEqual(updated);
    });

    it('inserting two accounts with different IDs stores both', async () => {
      const { store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord({ id: 'a1' }));
      await store.upsert('claude-code', makeCredentialRecord({ id: 'a2' }));

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Remove
  // -------------------------------------------------------------------------

  describe('remove', () => {
    it('removes the correct account and leaves others intact', async () => {
      const { store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord({ id: 'keep' }));
      await store.upsert('claude-code', makeCredentialRecord({ id: 'drop' }));

      await store.remove('claude-code', 'drop');

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.id).toBe('keep');
    });

    it('remove is a no-op for a non-existent account ID', async () => {
      const { store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord({ id: 'a1' }));
      await store.remove('claude-code', 'does-not-exist');

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
    });

    it('remove is a no-op when the clientId has no accounts', async () => {
      const { store } = await makeTmpStore();
      await expect(store.remove('claude-code', 'a1')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Persistence across instances
  // -------------------------------------------------------------------------

  describe('persistence', () => {
    it('data written by one instance is readable by a new instance at the same path', async () => {
      const { storePath, store: storeA } = await makeTmpStore();
      const account = makeCredentialRecord({ id: 'persistent' });
      await storeA.upsert('claude-code', account);

      // Fresh instance at same path — shares the mocked keychain entry
      const storeB = new DarwinAccountStore(storePath);
      const found = await storeB.get('claude-code', 'persistent');
      expect(found).toEqual(account);
    });
  });

  // -------------------------------------------------------------------------
  // Client isolation
  // -------------------------------------------------------------------------

  describe('client isolation', () => {
    it('accounts for different clientIds do not interfere', async () => {
      const { store } = await makeTmpStore();
      await store.upsert(
        'claude-code',
        makeCredentialRecord({
          id: 'a1',
          credential: {
            token: 'claude-token',
            fingerprint: 'fp-claude',
            metadata: {},
          },
          fingerprint: 'fp-claude',
        }),
      );
      await store.upsert(
        'codex',
        makeCredentialRecord({
          id: 'a1',
          credential: {
            token: 'codex-token',
            fingerprint: 'fp-codex',
            metadata: {},
          },
          fingerprint: 'fp-codex',
        }),
      );

      const claudeAccounts = await store.list('claude-code');
      const codexAccounts = await store.list('codex');

      expect(claudeAccounts).toHaveLength(1);
      expect(claudeAccounts[0]?.credential.token).toBe('claude-token');
      expect(codexAccounts).toHaveLength(1);
      expect(codexAccounts[0]?.credential.token).toBe('codex-token');
    });

    it('removing an account from one client does not affect another', async () => {
      const { store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord({ id: 'a1' }));
      await store.upsert('codex', makeCredentialRecord({ id: 'a1' }));

      await store.remove('claude-code', 'a1');

      const codexAccounts = await store.list('codex');
      expect(codexAccounts).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Clone isolation
  // -------------------------------------------------------------------------

  describe('clone isolation', () => {
    it('mutating a returned account from list does not affect the store', async () => {
      const { store } = await makeTmpStore();
      await store.upsert(
        'claude-code',
        makeCredentialRecord({
          credential: {
            token: 'tok-original',
            fingerprint: 'fp-original',
            metadata: { planType: 'free' },
          },
          fingerprint: 'fp-original',
        }),
      );

      const [returned] = await store.list('claude-code');
      returned!.credential.metadata['planType'] = 'mutated';

      const [stored] = await store.list('claude-code');
      expect(stored?.credential.metadata['planType']).toBe('free');
    });

    it('mutating a returned account from get does not affect the store', async () => {
      const { store } = await makeTmpStore();
      await store.upsert(
        'claude-code',
        makeCredentialRecord({
          id: 'a1',
          credential: {
            token: 'tok-original',
            fingerprint: 'fp-original',
            metadata: { planType: 'free' },
          },
          fingerprint: 'fp-original',
        }),
      );

      const returned = await store.get('claude-code', 'a1');
      returned!.credential.token = 'mutated';

      const stored = await store.get('claude-code', 'a1');
      expect(stored?.credential.token).toBe('tok-original');
    });
  });

  // -------------------------------------------------------------------------
  // File permissions
  // -------------------------------------------------------------------------

  describe('file permissions', () => {
    it('store file has 0o600 permissions after write', async () => {
      const { storePath, store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord());

      const fileStat = await stat(storePath);
      const mode = fileStat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  // -------------------------------------------------------------------------
  // Directory creation
  // -------------------------------------------------------------------------

  describe('directory creation', () => {
    it('creates parent directories with 0o700 if they do not exist', async () => {
      const { storePath, store } = await makeTmpStore();
      const storeDir = dirname(storePath);
      await expect(stat(storeDir)).rejects.toMatchObject({ code: 'ENOENT' });

      await store.upsert('claude-code', makeCredentialRecord());

      const dirStat = await stat(storeDir);
      const mode = dirStat.mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });

  // -------------------------------------------------------------------------
  // Atomic write
  // -------------------------------------------------------------------------

  describe('atomic write', () => {
    it('leaves no .tmp files behind after a successful write', async () => {
      const { storePath, store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord());
      await expectNoTempFiles(storePath);
    });
  });

  // -------------------------------------------------------------------------
  // Write serialization (withWriteLock chain)
  // -------------------------------------------------------------------------

  describe('write serialization', () => {
    it('concurrent upserts do not lose data', async () => {
      const { store } = await makeTmpStore();
      const accounts = Array.from({ length: 10 }, (_, i) => makeCredentialRecord({ id: `account-${i}` }));

      await Promise.all(accounts.map((a) => store.upsert('claude-code', a)));

      const stored = await store.list('claude-code');
      expect(stored).toHaveLength(10);
    });
  });

  // -------------------------------------------------------------------------
  // Missing key on read
  // -------------------------------------------------------------------------

  describe('missing key on read', () => {
    it('throws when ciphertext exists but the keychain entry is absent', async () => {
      const { storePath, store: storeA } = await makeTmpStore();
      // Write data with a key present in the mock keychain
      await storeA.upsert('claude-code', makeCredentialRecord());

      // Simulate the keychain entry disappearing (e.g. system restore / migration)
      keychainStore.clear();

      // A new instance has no cached key and must hit the keychain
      const storeB = new DarwinAccountStore(storePath);
      await expect(storeB.list('claude-code')).rejects.toThrow(
        'Encryption key is missing for the existing account-manager store',
      );
    });
  });
});
