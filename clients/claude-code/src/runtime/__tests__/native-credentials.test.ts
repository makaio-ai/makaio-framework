import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeCodeCredentialsKeychainService,
  type ClaudeCodeFilesystemCredentialOperations,
  type ClaudeCodeKeychainCredentialStore,
  cloneClaudeCodeNativeCredentialsForSession,
  clearClaudeCodeNativeCredentialsForSession,
  inheritClaudeCodeNativeCredentialsForSession,
  removeClaudeCodeNativeCredentialsForSession,
} from '../native-credentials.js';

describe('Claude Code native credentials', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  /**
   * Build filesystem operations for tests that need to observe link/copy
   * decisions without creating platform-sensitive symlinks in temp dirs.
   * @returns Credential filesystem operations backed by lightweight fakes.
   */
  function createFakeFilesystemOperations(): ClaudeCodeFilesystemCredentialOperations {
    return {
      access: vi.fn(async () => undefined),
      copyFile: vi.fn(async () => undefined),
      stat: vi.fn(async () => undefined as never),
      symlink: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
  }

  /**
   * Create an isolated credential store with Keychain-like persistence
   * semantics: values are addressed by service and account, reads return
   * `null` when absent, and deletes remove only the addressed credential.
   * @returns In-memory keychain credential store for unit tests.
   */
  function createMemoryKeychainStore(): ClaudeCodeKeychainCredentialStore {
    const values = new Map<string, string>();
    const key = (service: string, account: string): string => `${service}\0${account}`;
    return {
      async read(service, account) {
        return values.get(key(service, account)) ?? null;
      },
      async write(service, account, value) {
        values.set(key(service, account), value);
      },
      async delete(service, account) {
        values.delete(key(service, account));
      },
    };
  }

  it('builds the native Claude Code credentials service name without a config dir', () => {
    expect(buildClaudeCodeCredentialsKeychainService()).toBe('Claude Code-credentials');
  });

  it('builds the session credentials service name from the CLAUDE_CONFIG_DIR hash', () => {
    const configDir = '/tmp/makaio claude session';
    const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').substring(0, 8);

    expect(buildClaudeCodeCredentialsKeychainService(configDir)).toBe(`Claude Code-credentials-${hash}`);
  });

  it('includes Claude Code custom OAuth suffix in source and session service names', () => {
    vi.stubEnv('CLAUDE_CODE_CUSTOM_OAUTH_URL', 'https://oauth.example.test');
    const configDir = '/tmp/makaio-claude-session';
    const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').substring(0, 8);

    expect(buildClaudeCodeCredentialsKeychainService()).toBe('Claude Code-custom-oauth-credentials');
    expect(buildClaudeCodeCredentialsKeychainService(configDir)).toBe(`Claude Code-custom-oauth-credentials-${hash}`);
  });

  it('clones the native macOS credential into the session service without returning the secret', async () => {
    const sessionDir = '/tmp/makaio-claude-session';
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const expectedService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', 'makaio-test-user');
    await store.write(sourceService, 'makaio-test-user', '{"claudeAiOauth":{"refreshToken":"secret"}}');

    const result = await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store);

    expect(result).toEqual({ prepared: true });
    await expect(store.read(expectedService, 'makaio-test-user')).resolves.toBe(
      '{"claudeAiOauth":{"refreshToken":"secret"}}',
    );
    await expect(store.read(sourceService, 'makaio-test-user')).resolves.toBe(
      '{"claudeAiOauth":{"refreshToken":"secret"}}',
    );
  });

  it('removes the session credential when the native source credential is absent', async () => {
    const sessionDir = '/tmp/makaio-claude-session';
    const expectedService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', 'makaio-test-user');
    await store.write(expectedService, 'makaio-test-user', '{"claudeAiOauth":{"refreshToken":"stale"}}');

    const result = await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store);

    expect(result).toEqual({ prepared: false, reason: 'source-missing' });
    await expect(store.read(expectedService, 'makaio-test-user')).resolves.toBeNull();
  });

  it('removes a stale session credential', async () => {
    const sessionDir = '/tmp/makaio-claude-session';
    const expectedService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = process.env.USER || os.userInfo().username;
    const store = createMemoryKeychainStore();
    await store.write(expectedService, account, '{"claudeAiOauth":{"refreshToken":"stale"}}');

    await removeClaudeCodeNativeCredentialsForSession(sessionDir, store);

    await expect(store.read(expectedService, account)).resolves.toBeNull();
  });

  it('routes darwin inheritance and cleanup through the keychain credential store', async () => {
    const sessionDir = '/tmp/makaio-claude-session';
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = process.env.USER || os.userInfo().username;
    const store = createMemoryKeychainStore();
    await store.write(sourceService, account, '{"claudeAiOauth":{"refreshToken":"secret"}}');

    const inherited = await inheritClaudeCodeNativeCredentialsForSession(
      {
        sourceConfigDir: '/tmp/source-is-ignored-on-darwin',
        sessionDir,
        platform: 'darwin',
      },
      createFakeFilesystemOperations(),
      store,
    );

    expect(inherited).toEqual({ prepared: true });
    await expect(store.read(targetService, account)).resolves.toBe('{"claudeAiOauth":{"refreshToken":"secret"}}');

    await clearClaudeCodeNativeCredentialsForSession(
      { sessionDir, platform: 'darwin' },
      createFakeFilesystemOperations(),
      store,
    );

    await expect(store.read(targetService, account)).resolves.toBeNull();
  });

  it('inherits filesystem credentials through a symlink on non-macOS platforms', async () => {
    const sourceDir = '/tmp/makaio-claude-source';
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = createFakeFilesystemOperations();

    const result = await inheritClaudeCodeNativeCredentialsForSession(
      {
        sourceConfigDir: sourceDir,
        sessionDir,
        platform: 'linux',
      },
      operations,
    );

    expect(result).toEqual({ prepared: true });
    expect(operations.unlink).toHaveBeenCalledWith(path.join(sessionDir, '.credentials.json'));
    expect(operations.symlink).toHaveBeenCalledWith(
      path.join(sourceDir, '.credentials.json'),
      path.join(sessionDir, '.credentials.json'),
    );
    expect(operations.copyFile).not.toHaveBeenCalled();
  });

  it('copies filesystem credentials when Windows symlink creation is denied', async () => {
    const sourceDir = '/tmp/makaio-claude-source';
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = {
      ...createFakeFilesystemOperations(),
      symlink: vi.fn(async () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
    } satisfies ClaudeCodeFilesystemCredentialOperations;

    const result = await inheritClaudeCodeNativeCredentialsForSession(
      {
        sourceConfigDir: sourceDir,
        sessionDir,
        platform: 'win32',
      },
      operations,
    );

    expect(result).toEqual({ prepared: true });
    expect(operations.symlink).toHaveBeenCalled();
    expect(operations.copyFile).toHaveBeenCalledWith(
      path.join(sourceDir, '.credentials.json'),
      path.join(sessionDir, '.credentials.json'),
    );
  });

  it('reports source-missing when credential file does not exist on non-macOS platforms', async () => {
    const sourceDir = '/tmp/makaio-claude-source';
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = createFakeFilesystemOperations();
    vi.mocked(operations.access).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    const result = await inheritClaudeCodeNativeCredentialsForSession(
      {
        sourceConfigDir: sourceDir,
        sessionDir,
        platform: 'linux',
      },
      operations,
    );

    expect(result).toEqual({ prepared: false, reason: 'source-missing' });
    expect(operations.unlink).toHaveBeenCalledWith(path.join(sessionDir, '.credentials.json'));
  });

  it('inherits filesystem credentials with real file operations', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-credentials-'));
    try {
      const sourceDir = path.join(rootDir, 'source');
      const sessionDir = path.join(rootDir, 'session');
      await fs.mkdir(sourceDir);
      await fs.mkdir(sessionDir);
      await fs.writeFile(path.join(sourceDir, '.credentials.json'), '{"refreshToken":"initial"}', 'utf-8');

      const result = await inheritClaudeCodeNativeCredentialsForSession({
        sourceConfigDir: sourceDir,
        sessionDir,
        platform: 'linux',
      });

      expect(result).toEqual({ prepared: true });
      expect(await fs.readlink(path.join(sessionDir, '.credentials.json'))).toBe(
        path.join(sourceDir, '.credentials.json'),
      );

      await fs.writeFile(path.join(sourceDir, '.credentials.json'), '{"refreshToken":"rotated"}', 'utf-8');
      await expect(fs.readFile(path.join(sessionDir, '.credentials.json'), 'utf-8')).resolves.toBe(
        '{"refreshToken":"rotated"}',
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('propagates unusable filesystem credential verification errors', async () => {
    const sourceDir = '/tmp/makaio-claude-source';
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = {
      ...createFakeFilesystemOperations(),
      stat: vi.fn(async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }),
    } satisfies ClaudeCodeFilesystemCredentialOperations;

    await expect(
      inheritClaudeCodeNativeCredentialsForSession(
        {
          sourceConfigDir: sourceDir,
          sessionDir,
          platform: 'linux',
        },
        operations,
      ),
    ).rejects.toThrow('permission denied');
  });

  it('refreshes stale filesystem credentials from the selected source config dir', async () => {
    const sourceDir = '/tmp/makaio-claude-source';
    const sessionDir = '/tmp/makaio-claude-session';
    const calls: string[] = [];
    const operations = createFakeFilesystemOperations();
    vi.mocked(operations.unlink).mockImplementation(async () => {
      calls.push('unlink');
    });
    vi.mocked(operations.symlink).mockImplementation(async () => {
      calls.push('symlink');
    });

    const result = await inheritClaudeCodeNativeCredentialsForSession(
      {
        sourceConfigDir: sourceDir,
        sessionDir,
        platform: 'linux',
      },
      operations,
    );

    expect(result).toEqual({ prepared: true });
    expect(calls).toEqual(['unlink', 'symlink']);
  });

  it('keeps filesystem credentials in place when source and session config dirs match', async () => {
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = createFakeFilesystemOperations();

    const result = await inheritClaudeCodeNativeCredentialsForSession(
      {
        sourceConfigDir: sessionDir,
        sessionDir,
        platform: 'linux',
      },
      operations,
    );

    expect(result).toEqual({ prepared: true });
    expect(operations.symlink).not.toHaveBeenCalled();
    expect(operations.unlink).not.toHaveBeenCalled();
  });

  it('clears filesystem credentials for non-macOS session dirs', async () => {
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = createFakeFilesystemOperations();

    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'linux' }, operations);

    expect(operations.unlink).toHaveBeenCalledWith(path.join(sessionDir, '.credentials.json'));
  });
});
