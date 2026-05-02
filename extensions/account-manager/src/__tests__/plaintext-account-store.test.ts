import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PlaintextAccountStore } from '../stores/plaintext-account-store.js';
import { expectNoTempFiles, makeCredentialRecord } from './testing/credential-fixtures.js';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PlaintextAccountStore', () => {
  const tmpDirs: string[] = [];

  /**
   * Returns a store path nested one level deep inside the temp dir so that
   * directory-creation tests can assert the parent dir is created by the store
   * itself.
   */
  async function makeTmpStore(): Promise<{ storePath: string; store: PlaintextAccountStore }> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'plaintext-account-store-test-'));
    tmpDirs.push(tmpDir);
    const storePath = join(tmpDir, 'store', 'accounts.json');
    return { storePath, store: new PlaintextAccountStore(storePath) };
  }

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
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

    it('get returns null for a non-existent account when others exist', async () => {
      const { store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord({ id: 'account-1' }));
      const found = await store.get('claude-code', 'account-9999');
      expect(found).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Upsert semantics
  // -------------------------------------------------------------------------

  describe('upsert semantics', () => {
    it('updating an existing account does not duplicate it', async () => {
      const { store } = await makeTmpStore();
      const original = makeCredentialRecord({
        credential: {
          token: 'tok-original',
          fingerprint: 'fp-original',
          metadata: { planType: 'free' },
        },
        fingerprint: 'fp-original',
      });
      await store.upsert('claude-code', original);

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
      // No upsert — store file does not exist
      await expect(store.remove('claude-code', 'a1')).resolves.toBeUndefined();
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
  // File permissions
  // -------------------------------------------------------------------------

  describe('file permissions', () => {
    it('store file has 0o600 permissions after write', async () => {
      const { storePath, store } = await makeTmpStore();
      await store.upsert('claude-code', makeCredentialRecord());

      const fileStat = await stat(storePath);
      // Mask to the permission bits only (lower 12 bits)
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
      // Confirm the parent dir does not exist before the first write
      const storeDir = dirname(storePath);
      await expect(stat(storeDir)).rejects.toMatchObject({ code: 'ENOENT' });

      await store.upsert('claude-code', makeCredentialRecord());

      const dirStat = await stat(storeDir);
      // Verify the directory was created with 0o700
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
  // Persistence across instances
  // -------------------------------------------------------------------------

  describe('persistence', () => {
    it('data written by one instance is readable by a new instance at the same path', async () => {
      const { storePath, store: storeA } = await makeTmpStore();
      const account = makeCredentialRecord({ id: 'persistent' });
      await storeA.upsert('claude-code', account);

      // Create a brand-new instance pointing at the same path
      const storeB = new PlaintextAccountStore(storePath);
      const found = await storeB.get('claude-code', 'persistent');
      expect(found).toEqual(account);
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
      // Mutate the returned copy

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
  // Write serialization (withWriteLock chain)
  // -------------------------------------------------------------------------

  describe('write serialization', () => {
    it('concurrent upserts do not lose data', async () => {
      const { store } = await makeTmpStore();
      const accounts = Array.from({ length: 10 }, (_, i) => makeCredentialRecord({ id: `account-${i}` }));

      // Fire all upserts concurrently without awaiting individually
      await Promise.all(accounts.map((a) => store.upsert('claude-code', a)));

      const stored = await store.list('claude-code');
      expect(stored).toHaveLength(10);
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe('error propagation', () => {
    it('throws on a corrupt JSON file rather than silently returning empty', async () => {
      const { storePath, store } = await makeTmpStore();
      // Write valid data first so the directory exists, then corrupt the file
      await store.upsert('claude-code', makeCredentialRecord());
      await writeFile(storePath, 'not valid json', 'utf-8');

      // list() internally calls load() which should throw for bad JSON
      await expect(store.list('claude-code')).rejects.toThrow(SyntaxError);
    });

    it('propagates non-ENOENT filesystem errors', async () => {
      const { storePath } = await makeTmpStore();
      // Place a directory at the store path so readFile fails with EISDIR
      await mkdir(storePath, { recursive: true });
      const store = new PlaintextAccountStore(storePath);

      await expect(store.list('claude-code')).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });
});
