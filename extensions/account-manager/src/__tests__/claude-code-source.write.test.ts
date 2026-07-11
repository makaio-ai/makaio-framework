import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildClaudeCodeCredentialsKeychainService,
  cloneClaudeCodeNativeCredentialsForSession,
  removeClaudeCodeNativeCredentialsForSession,
  withClaudeCodeNativeCredentialSourceLock,
} from '@makaio/client-claude-code/runtime';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryBackend } from './testing/in-memory-backend.js';

/** In-memory keychain with a deterministic pause before one canonical write. */
class PausingKeychainStore {
  private readonly values = new Map<string, string>();
  public pause:
    | {
        readonly service: string;
        readonly account: string;
        readonly value: string;
        readonly started: () => void;
        readonly release: Promise<void>;
      }
    | undefined;

  public async read(service: string, account: string): Promise<string | null> {
    return this.values.get(this.key(service, account)) ?? null;
  }

  public async write(service: string, account: string, value: string): Promise<void> {
    const pause = this.pause;
    if (pause?.service === service && pause.account === account && pause.value === value) {
      pause.started();
      await pause.release;
    }
    this.values.set(this.key(service, account), value);
  }

  public async delete(service: string, account: string): Promise<void> {
    this.values.delete(this.key(service, account));
  }

  private key(service: string, account: string): string {
    return `${service}\0${account}`;
  }
}

/**
 * Builds a mock profile API response for the given account/org UUIDs.
 * @param opts - Profile field overrides.
 */
function _profileResponse(opts: {
  accountUuid?: string;
  orgUuid?: string;
  orgName?: string;
  email?: string;
}): Response {
  return new Response(
    JSON.stringify({
      account: {
        uuid: opts.accountUuid ?? 'acct-uuid-1',
        email: opts.email ?? 'user@example.com',
        full_name: 'Test User',
      },
      organization: {
        uuid: opts.orgUuid ?? 'org-uuid-1',
        name: opts.orgName ?? 'TestOrg',
      },
    }),
    { status: 200 },
  );
}

describe('ClaudeCodeSource', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  /** Create one real config directory suitable for the production source lock. */
  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-account-source-'));
    tempDirs.push(dir);
    return fs.realpath(dir);
  }

  describe('write()', () => {
    it('delegates the token to the backend', async () => {
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend, { installDir: await makeTempDir() });
      const credential = {
        token: JSON.stringify({ refreshToken: 'my-token' }),
        fingerprint: computeFingerprint('my-token'),
        metadata: {},
      };

      await source.write(credential);

      expect(await backend.read()).toBe(credential.token);
    });

    it('cannot be overwritten by a lease CAS that already owns the canonical source lock', async () => {
      const sourceConfigDir = await makeTempDir();
      const sessionDir = await makeTempDir();
      const account = 'makaio-lock-test-user';
      const sourceService = buildClaudeCodeCredentialsKeychainService();
      const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
      const initial = '{"refreshToken":"initial"}';
      const detachedRefresh = '{"refreshToken":"detached-refresh"}';
      const selectedAccount = '{"refreshToken":"selected-account"}';
      const store = new PausingKeychainStore();
      vi.stubEnv('USER', account);
      await store.write(sourceService, account, initial);
      await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
      await store.write(targetService, account, detachedRefresh);

      const leaseWriteStarted = Promise.withResolvers<void>();
      const continueLeaseWrite = Promise.withResolvers<void>();
      store.pause = {
        service: sourceService,
        account,
        value: detachedRefresh,
        started: leaseWriteStarted.resolve,
        release: continueLeaseWrite.promise,
      };
      const leaseRemoval = removeClaudeCodeNativeCredentialsForSession(sessionDir, store);
      await leaseWriteStarted.promise;

      let accountWriteEntered = false;
      const source = new ClaudeCodeSource(
        {
          read: async () => store.read(sourceService, account),
          write: async (value) => {
            accountWriteEntered = true;
            await store.write(sourceService, account, value);
          },
          clear: async () => store.delete(sourceService, account),
        },
        { installDir: sourceConfigDir },
      );
      const accountWrite = source.write({
        token: selectedAccount,
        fingerprint: computeFingerprint(selectedAccount),
        metadata: {},
      });

      const accountWriteEnteredWhileLeaseLocked = accountWriteEntered;
      continueLeaseWrite.resolve();
      await Promise.all([leaseRemoval, accountWrite]);

      expect(accountWriteEnteredWhileLeaseLocked).toBe(false);
      await expect(store.read(sourceService, account)).resolves.toBe(selectedAccount);
      await expect(fs.access(`${sourceConfigDir}.lock`)).rejects.toThrow();
    });
  });

  describe('clear()', () => {
    it('waits for the same canonical source lock before clearing credentials', async () => {
      const installDir = await makeTempDir();
      let clearEntered = false;
      const backend = new InMemoryBackend();
      await backend.write('credential');
      const source = new ClaudeCodeSource(
        {
          read: async () => backend.read(),
          write: async (value) => backend.write(value),
          clear: async () => {
            clearEntered = true;
            await backend.clear();
          },
        },
        { installDir },
      );
      let pendingClear: Promise<void> | undefined;
      let clearEnteredWhileLocked = false;

      await withClaudeCodeNativeCredentialSourceLock(installDir, async () => {
        pendingClear = source.clear();
        clearEnteredWhileLocked = clearEntered;
      });
      if (pendingClear === undefined) throw new Error('Expected clear to be scheduled.');
      await pendingClear;

      expect(clearEnteredWhileLocked).toBe(false);
      expect(clearEntered).toBe(true);
      await expect(backend.read()).resolves.toBeNull();
    });
  });
});
