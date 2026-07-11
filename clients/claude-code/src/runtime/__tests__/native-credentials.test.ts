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
  const leaseMetadataFilename = '.makaio-native-auth-lease.json';
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  /**
   * Create a real session directory for metadata and filesystem lifecycle tests.
   * @returns Newly created temporary directory.
   */
  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-native-auth-'));
    tempDirs.push(dir);
    return dir;
  }

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
   * Build real filesystem operations with the Windows permission failure that
   * activates Claude Code's detached-copy fallback.
   * @returns Operations that copy instead of symlinking credentials.
   */
  function createWindowsCopyOperations(): ClaudeCodeFilesystemCredentialOperations {
    return {
      access: fs.access,
      copyFile: vi.fn(fs.copyFile),
      stat: fs.stat,
      symlink: vi.fn(async () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
      unlink: fs.unlink,
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
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const expectedService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', 'makaio-test-user');
    await store.write(sourceService, 'makaio-test-user', '{"claudeAiOauth":{"refreshToken":"secret"}}');

    const result = await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);

    expect(result).toEqual({ prepared: true });
    await expect(store.read(expectedService, 'makaio-test-user')).resolves.toBe(
      '{"claudeAiOauth":{"refreshToken":"secret"}}',
    );
    await expect(store.read(sourceService, 'makaio-test-user')).resolves.toBe(
      '{"claudeAiOauth":{"refreshToken":"secret"}}',
    );
    const metadataText = await fs.readFile(path.join(sessionDir, leaseMetadataFilename), 'utf-8');
    expect(metadataText).not.toContain('refreshToken');
    expect((await fs.stat(path.join(sessionDir, leaseMetadataFilename))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(metadataText)).toEqual({
      version: 1,
      backend: 'keychain',
      source: {
        service: sourceService,
        account: 'makaio-test-user',
        configDir: sourceConfigDir,
        identity: 'global',
        generation: createHash('sha256').update('{"claudeAiOauth":{"refreshToken":"secret"}}').digest('hex'),
      },
      target: {
        service: expectedService,
        account: 'makaio-test-user',
        configDir: sessionDir,
        initialDigest: createHash('sha256').update('{"claudeAiOauth":{"refreshToken":"secret"}}').digest('hex'),
      },
    });
  });

  it('does not turn a Linux symlink permission failure into a detached credential copy', async () => {
    const sourceDir = '/tmp/makaio-claude-source';
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = {
      ...createFakeFilesystemOperations(),
      symlink: vi.fn(async () => {
        throw Object.assign(new Error('secret-value /private/native/path'), { code: 'EACCES' });
      }),
    } satisfies ClaudeCodeFilesystemCredentialOperations;

    const error = await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'linux' },
      operations,
    ).catch((cause: unknown) => cause);
    expect((error as Error).message).toBe('Claude Code native credential setup failed (filesystem-materialization)');
    expect((error as Error).message).not.toContain('secret-value');
    expect((error as Error).message).not.toContain('/private');
    expect(operations.copyFile).not.toHaveBeenCalled();
  });

  it('removes the session credential when the native source credential is absent', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const expectedService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', 'makaio-test-user');
    await store.write(expectedService, 'makaio-test-user', '{"claudeAiOauth":{"refreshToken":"stale"}}');

    const result = await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);

    expect(result).toEqual({ prepared: false, reason: 'source-missing' });
    await expect(store.read(expectedService, 'makaio-test-user')).resolves.toBeNull();
    await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();
  });

  it('removes a stale session credential', async () => {
    const sessionDir = await makeTempDir();
    const expectedService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = process.env.USER || os.userInfo().username;
    const store = createMemoryKeychainStore();
    await store.write(expectedService, account, '{"claudeAiOauth":{"refreshToken":"stale"}}');

    await removeClaudeCodeNativeCredentialsForSession(sessionDir, store);

    await expect(store.read(expectedService, account)).resolves.toBeNull();
  });

  it('routes darwin inheritance and cleanup through the keychain credential store', async () => {
    const sessionDir = await makeTempDir();
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

  it('removes an unchanged Keychain clone without rewriting the canonical credential', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    const write = vi.spyOn(store, 'write');

    await removeClaudeCodeNativeCredentialsForSession(sessionDir, store);

    expect(write).not.toHaveBeenCalled();
    await expect(store.read(sourceService, account)).resolves.toBe('{"refreshToken":"initial"}');
    await expect(store.read(targetService, account)).resolves.toBeNull();
    await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();
  });

  it('writes a refreshed Keychain clone back when the canonical generation is unchanged', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    await store.write(targetService, account, '{"refreshToken":"refreshed"}');

    await removeClaudeCodeNativeCredentialsForSession(sessionDir, store);

    await expect(store.read(sourceService, account)).resolves.toBe('{"refreshToken":"refreshed"}');
    await expect(store.read(targetService, account)).resolves.toBeNull();
  });

  it('keeps a concurrently changed canonical Keychain credential and discards the detached refresh', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    await store.write(targetService, account, '{"refreshToken":"detached-refresh"}');
    await store.write(sourceService, account, '{"refreshToken":"canonical-refresh"}');

    await removeClaudeCodeNativeCredentialsForSession(sessionDir, store);

    await expect(store.read(sourceService, account)).resolves.toBe('{"refreshToken":"canonical-refresh"}');
    await expect(store.read(targetService, account)).resolves.toBeNull();
  });

  it('uses persisted Keychain identities when environment-derived identities change before teardown', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    vi.stubEnv('USER', 'setup-user');
    vi.stubEnv('CLAUDE_CODE_CUSTOM_OAUTH_URL', 'https://oauth.example.test');
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const store = createMemoryKeychainStore();
    await store.write(sourceService, 'setup-user', '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    await store.write(targetService, 'setup-user', '{"refreshToken":"refreshed"}');
    vi.stubEnv('USER', 'teardown-user');
    vi.stubEnv('CLAUDE_CODE_CUSTOM_OAUTH_URL', '');

    await removeClaudeCodeNativeCredentialsForSession(sessionDir, store);

    await expect(store.read(sourceService, 'setup-user')).resolves.toBe('{"refreshToken":"refreshed"}');
    await expect(store.read(targetService, 'setup-user')).resolves.toBeNull();
  });

  it('uses CLAUDE_SECURESTORAGE_CONFIG_DIR as the canonical Keychain source identity', async () => {
    const requestedSourceConfigDir = await makeTempDir();
    const secureStorageConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const account = 'makaio-test-user';
    vi.stubEnv('USER', account);
    vi.stubEnv('CLAUDE_CONFIG_DIR', requestedSourceConfigDir);
    vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', secureStorageConfigDir);
    const sourceService = buildClaudeCodeCredentialsKeychainService(secureStorageConfigDir);
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const store = createMemoryKeychainStore();
    await store.write(sourceService, account, '{"refreshToken":"secure-storage"}');

    const result = await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, requestedSourceConfigDir);

    expect(result).toEqual({ prepared: true });
    await expect(store.read(targetService, account)).resolves.toBe('{"refreshToken":"secure-storage"}');
    expect(JSON.parse(await fs.readFile(path.join(sessionDir, leaseMetadataFilename), 'utf-8'))).toMatchObject({
      source: {
        service: sourceService,
        configDir: secureStorageConfigDir,
        identity: 'scoped',
      },
      target: {
        service: targetService,
        configDir: sessionDir,
      },
    });
  });

  it("uses Claude Code's safe fallback account for an invalid USER value", async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', 'unsafe account name');
    await store.write(sourceService, 'claude-code-user', '{"refreshToken":"safe-account"}');

    const result = await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);

    expect(result).toEqual({ prepared: true });
    await expect(store.read(targetService, 'claude-code-user')).resolves.toBe('{"refreshToken":"safe-account"}');
    await expect(store.read(targetService, 'unsafe account name')).resolves.toBeNull();
  });

  it('keeps a missing canonical Keychain source missing when the detached clone refreshed', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    await store.write(targetService, account, '{"refreshToken":"detached-refresh"}');
    await store.delete(sourceService, account);

    await removeClaudeCodeNativeCredentialsForSession(sessionDir, store);

    await expect(store.read(sourceService, account)).resolves.toBeNull();
    await expect(store.read(targetService, account)).resolves.toBeNull();
  });

  it('reconciles a stale Keychain clone before replacing it during setup', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    await store.write(targetService, account, '{"refreshToken":"stale-lease-refresh"}');

    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);

    await expect(store.read(sourceService, account)).resolves.toBe('{"refreshToken":"stale-lease-refresh"}');
    await expect(store.read(targetService, account)).resolves.toBe('{"refreshToken":"stale-lease-refresh"}');
  });

  it('serializes two independent Keychain lease writebacks against one canonical source', async () => {
    const sourceConfigDir = await makeTempDir();
    const firstSessionDir = await makeTempDir();
    const secondSessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const firstTargetService = buildClaudeCodeCredentialsKeychainService(firstSessionDir);
    const secondTargetService = buildClaudeCodeCredentialsKeychainService(secondSessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(firstSessionDir, store, sourceConfigDir);
    await cloneClaudeCodeNativeCredentialsForSession(secondSessionDir, store, sourceConfigDir);
    await store.write(firstTargetService, account, '{"refreshToken":"first-refresh"}');
    await store.write(secondTargetService, account, '{"refreshToken":"second-refresh"}');
    const originalWrite = store.write.bind(store);
    let canonicalWriteCount = 0;
    vi.spyOn(store, 'write').mockImplementation(async (service, requestedAccount, value) => {
      if (service === sourceService && requestedAccount === account) canonicalWriteCount += 1;
      await originalWrite(service, requestedAccount, value);
    });

    await Promise.all([
      removeClaudeCodeNativeCredentialsForSession(firstSessionDir, store),
      removeClaudeCodeNativeCredentialsForSession(secondSessionDir, store),
    ]);

    expect(canonicalWriteCount).toBe(1);
    expect(['{"refreshToken":"first-refresh"}', '{"refreshToken":"second-refresh"}']).toContain(
      await store.read(sourceService, account),
    );
    await expect(store.read(firstTargetService, account)).resolves.toBeNull();
    await expect(store.read(secondTargetService, account)).resolves.toBeNull();
    await expect(fs.access(`${sourceConfigDir}.lock`)).rejects.toThrow();
  });

  it('surfaces a sanitized reconciliation failure after deleting the Keychain target', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    await store.write(targetService, account, '{"refreshToken":"refreshed"}');
    const originalRead = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (service, requestedAccount) => {
      if (service === sourceService) throw new Error('secret-value /private/keychain/path');
      return originalRead(service, requestedAccount);
    });

    const error = await removeClaudeCodeNativeCredentialsForSession(sessionDir, store).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Claude Code native credential teardown failed (keychain-reconcile)');
    expect((error as Error).message).not.toContain('secret-value');
    expect((error as Error).message).not.toContain('/private');
    await expect(originalRead(targetService, account)).resolves.toBeNull();
    await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();
  });

  it('strictly rejects modified lease metadata while still removing the derived Keychain target', async () => {
    const sessionDir = await makeTempDir();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(targetService, account, '{"refreshToken":"session-secret"}');
    await fs.writeFile(
      path.join(sessionDir, leaseMetadataFilename),
      JSON.stringify({ version: 1, backend: 'keychain', credential: 'session-secret' }),
      'utf-8',
    );

    const error = await removeClaudeCodeNativeCredentialsForSession(sessionDir, store).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Claude Code native credential teardown failed (metadata-invalid)');
    expect((error as Error).message).not.toContain('session-secret');
    await expect(store.read(targetService, account)).resolves.toBeNull();
    await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();
  });

  it('rejects a redirected Keychain source identity without writing to it', async () => {
    const sourceConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceService = buildClaudeCodeCredentialsKeychainService();
    const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
    const redirectedService = `${sourceService}-deadbeef`;
    const account = 'makaio-test-user';
    const store = createMemoryKeychainStore();
    vi.stubEnv('USER', account);
    await store.write(sourceService, account, '{"refreshToken":"initial"}');
    await store.write(redirectedService, account, '{"doNotTouch":true}');
    await cloneClaudeCodeNativeCredentialsForSession(sessionDir, store, sourceConfigDir);
    await store.write(targetService, account, '{"refreshToken":"detached-refresh"}');
    const metadataPath = path.join(sessionDir, leaseMetadataFilename);
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as {
      source: { service: string };
    };
    metadata.source.service = redirectedService;
    await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf-8');

    const error = await removeClaudeCodeNativeCredentialsForSession(sessionDir, store).catch((cause: unknown) => cause);

    expect((error as Error).message).toBe('Claude Code native credential teardown failed (metadata-identity)');
    await expect(store.read(sourceService, account)).resolves.toBe('{"refreshToken":"initial"}');
    await expect(store.read(redirectedService, account)).resolves.toBe('{"doNotTouch":true}');
    await expect(store.read(targetService, account)).resolves.toBeNull();
    await expect(fs.access(metadataPath)).rejects.toThrow();
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
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    await fs.writeFile(path.join(sourceDir, '.credentials.json'), '{"refreshToken":"initial"}', 'utf-8');
    const operations = createWindowsCopyOperations();

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
    await expect(fs.readFile(path.join(sessionDir, '.credentials.json'), 'utf-8')).resolves.toBe(
      '{"refreshToken":"initial"}',
    );
    const metadataText = await fs.readFile(path.join(sessionDir, leaseMetadataFilename), 'utf-8');
    expect(metadataText).not.toContain('refreshToken');
    expect(JSON.parse(metadataText)).toEqual({
      version: 1,
      backend: 'filesystem-copy',
      source: {
        credentialPath: path.join(sourceDir, '.credentials.json'),
        generation: createHash('sha256').update('{"refreshToken":"initial"}').digest('hex'),
      },
      target: {
        credentialPath: path.join(sessionDir, '.credentials.json'),
        initialDigest: createHash('sha256').update('{"refreshToken":"initial"}').digest('hex'),
      },
    });
  });

  it('writes a refreshed Windows credential copy back when the source generation is unchanged', async () => {
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceCredentialPath = path.join(sourceDir, '.credentials.json');
    const targetCredentialPath = path.join(sessionDir, '.credentials.json');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"initial"}', 'utf-8');
    const operations = createWindowsCopyOperations();
    await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'win32' },
      operations,
    );
    await fs.writeFile(targetCredentialPath, '{"refreshToken":"refreshed"}', 'utf-8');

    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'win32' }, operations);

    await expect(fs.readFile(sourceCredentialPath, 'utf-8')).resolves.toBe('{"refreshToken":"refreshed"}');
    await expect(fs.access(targetCredentialPath)).rejects.toThrow();
    await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();
  });

  it('keeps a concurrently changed Windows source and discards the detached refresh', async () => {
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceCredentialPath = path.join(sourceDir, '.credentials.json');
    const targetCredentialPath = path.join(sessionDir, '.credentials.json');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"initial"}', 'utf-8');
    const operations = createWindowsCopyOperations();
    await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'win32' },
      operations,
    );
    await fs.writeFile(targetCredentialPath, '{"refreshToken":"detached-refresh"}', 'utf-8');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"canonical-refresh"}', 'utf-8');

    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'win32' }, operations);

    await expect(fs.readFile(sourceCredentialPath, 'utf-8')).resolves.toBe('{"refreshToken":"canonical-refresh"}');
    await expect(fs.access(targetCredentialPath)).rejects.toThrow();
  });

  it('keeps a deleted Windows source missing and discards the detached refresh', async () => {
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceCredentialPath = path.join(sourceDir, '.credentials.json');
    const targetCredentialPath = path.join(sessionDir, '.credentials.json');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"initial"}', { encoding: 'utf-8', mode: 0o600 });
    const operations = createWindowsCopyOperations();
    await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'win32' },
      operations,
    );
    await fs.writeFile(targetCredentialPath, '{"refreshToken":"detached-refresh"}', 'utf-8');
    await fs.rm(sourceCredentialPath);

    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'win32' }, operations);

    await expect(fs.access(sourceCredentialPath)).rejects.toThrow();
    await expect(fs.access(targetCredentialPath)).rejects.toThrow();
    await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();
  });

  it('preserves owner-only mode during an atomic Windows credential writeback', async () => {
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceCredentialPath = path.join(sourceDir, '.credentials.json');
    const targetCredentialPath = path.join(sessionDir, '.credentials.json');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"initial"}', { encoding: 'utf-8', mode: 0o600 });
    const operations = createWindowsCopyOperations();
    await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'win32' },
      operations,
    );
    await fs.writeFile(targetCredentialPath, '{"refreshToken":"refreshed"}', 'utf-8');

    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'win32' }, operations);

    expect((await fs.stat(sourceCredentialPath)).mode & 0o777).toBe(0o600);
    await expect(fs.access(`${sourceDir}.lock`)).rejects.toThrow();
  });

  it('rejects a redirected filesystem source identity without touching that path', async () => {
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const redirectedDir = await makeTempDir();
    const sourceCredentialPath = path.join(sourceDir, '.credentials.json');
    const targetCredentialPath = path.join(sessionDir, '.credentials.json');
    const redirectedPath = path.join(redirectedDir, 'unrelated-auth.json');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"initial"}', 'utf-8');
    await fs.writeFile(redirectedPath, '{"doNotTouch":true}', 'utf-8');
    const operations = createWindowsCopyOperations();
    await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'win32' },
      operations,
    );
    const metadataPath = path.join(sessionDir, leaseMetadataFilename);
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as {
      source: { credentialPath: string };
    };
    metadata.source.credentialPath = redirectedPath;
    await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf-8');
    await fs.writeFile(targetCredentialPath, '{"refreshToken":"detached-refresh"}', 'utf-8');

    const error = await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'win32' }, operations).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Claude Code native credential teardown failed (metadata-identity)');
    await expect(fs.readFile(redirectedPath, 'utf-8')).resolves.toBe('{"doNotTouch":true}');
    await expect(fs.access(targetCredentialPath)).rejects.toThrow();
    await expect(fs.access(metadataPath)).rejects.toThrow();
  });

  it('removes an unchanged Windows credential copy without rewriting the source', async () => {
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceCredentialPath = path.join(sourceDir, '.credentials.json');
    const targetCredentialPath = path.join(sessionDir, '.credentials.json');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"initial"}', 'utf-8');
    const initialStat = await fs.stat(sourceCredentialPath);
    const operations = createWindowsCopyOperations();
    await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'win32' },
      operations,
    );

    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'win32' }, operations);

    expect((await fs.stat(sourceCredentialPath)).ino).toBe(initialStat.ino);
    await expect(fs.readFile(sourceCredentialPath, 'utf-8')).resolves.toBe('{"refreshToken":"initial"}');
    await expect(fs.access(targetCredentialPath)).rejects.toThrow();
  });

  it('reports a sanitized Windows reconciliation error after removing the detached target', async () => {
    const sourceDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const sourceCredentialPath = path.join(sourceDir, '.credentials.json');
    const targetCredentialPath = path.join(sessionDir, '.credentials.json');
    await fs.writeFile(sourceCredentialPath, '{"refreshToken":"initial"}', 'utf-8');
    const operations = createWindowsCopyOperations();
    await inheritClaudeCodeNativeCredentialsForSession(
      { sourceConfigDir: sourceDir, sessionDir, platform: 'win32' },
      operations,
    );
    await fs.writeFile(targetCredentialPath, '{"refreshToken":"refreshed"}', 'utf-8');
    await fs.rm(sourceCredentialPath);
    await fs.mkdir(sourceCredentialPath);

    const error = await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'win32' }, operations).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Claude Code native credential teardown failed (filesystem-reconcile)');
    expect((error as Error).message).not.toContain(sourceDir);
    await expect(fs.access(targetCredentialPath)).rejects.toThrow();
    await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();
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

  it('does not let ambient config identity override an explicit filesystem profile source', async () => {
    const ambientConfigDir = await makeTempDir();
    const profileConfigDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    vi.stubEnv('CLAUDE_CONFIG_DIR', ambientConfigDir);
    vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', '/ambient/secure-storage');
    await fs.writeFile(path.join(ambientConfigDir, '.credentials.json'), '{"refreshToken":"ambient"}', 'utf-8');
    await fs.writeFile(path.join(profileConfigDir, '.credentials.json'), '{"refreshToken":"profile"}', 'utf-8');

    const result = await inheritClaudeCodeNativeCredentialsForSession({
      sourceConfigDir: profileConfigDir,
      sessionDir,
      platform: 'linux',
    });

    expect(result).toEqual({ prepared: true });
    expect(await fs.readlink(path.join(sessionDir, '.credentials.json'))).toBe(
      path.join(profileConfigDir, '.credentials.json'),
    );
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
      await expect(fs.access(path.join(sessionDir, leaseMetadataFilename))).rejects.toThrow();

      await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: 'linux' });

      await expect(fs.readFile(path.join(sourceDir, '.credentials.json'), 'utf-8')).resolves.toBe(
        '{"refreshToken":"rotated"}',
      );
      await expect(fs.access(path.join(sessionDir, '.credentials.json'))).rejects.toThrow();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('sanitizes unusable filesystem credential verification errors', async () => {
    const sourceDir = '/tmp/makaio-claude-source';
    const sessionDir = '/tmp/makaio-claude-session';
    const operations = {
      ...createFakeFilesystemOperations(),
      stat: vi.fn(async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }),
    } satisfies ClaudeCodeFilesystemCredentialOperations;

    const error = await inheritClaudeCodeNativeCredentialsForSession(
      {
        sourceConfigDir: sourceDir,
        sessionDir,
        platform: 'linux',
      },
      operations,
    ).catch((cause: unknown) => cause);

    expect((error as Error).message).toBe('Claude Code native credential setup failed (filesystem-materialization)');
    expect((error as Error).message).not.toContain('permission denied');
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
