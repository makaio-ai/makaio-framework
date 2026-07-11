/**
 * Codex native auth lease implementation tests.
 *
 * Files use real temporary-directory I/O. Keyring cases use an in-memory
 * implementation of the same service/account contract because CI must never
 * touch a developer's operating-system credential store.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCodexAuthKeyringAccount,
  buildCodexNativeAuthSourceLockPath,
  CODEX_AUTH_KEYRING_SERVICE,
  CODEX_AUTH_LEASE_METADATA_FILE,
  CodexNativeAuthStore,
  identifyCodexAuthHome,
  withCodexNativeAuthSourceLock,
  type CodexAuthHomeIdentity,
  type CodexEffectiveCredentialRead,
  type CodexAuthStoreBackend,
  type CodexAuthStoreMode,
} from '../native-auth-store.js';
import type { CodexKeyringCredentialStore } from '../native-keyring-credential-store.js';
import { CodexSessionConfigHandler } from '../session-config-handler.js';

/** In-memory keyring with injectable operation failures. */
class MemoryKeyring implements CodexKeyringCredentialStore {
  public readonly values = new Map<string, string>();
  public failRead: Error | undefined;
  public failWriteAccount: string | undefined;
  public failDeleteAccount: string | undefined;

  public async read(service: string, account: string): Promise<string | null> {
    if (this.failRead !== undefined) throw this.failRead;
    return this.values.get(this.key(service, account)) ?? null;
  }

  public async write(service: string, account: string, value: string): Promise<void> {
    if (account === this.failWriteAccount) throw new Error(`keyring rejected ${value}`);
    this.values.set(this.key(service, account), value);
  }

  public async delete(service: string, account: string): Promise<void> {
    if (account === this.failDeleteAccount) throw new Error('keyring rejected secret-bearing-delete-context');
    this.values.delete(this.key(service, account));
  }

  public get(account: string): string | undefined {
    return this.values.get(this.key(CODEX_AUTH_KEYRING_SERVICE, account));
  }

  public set(account: string, value: string): void {
    this.values.set(this.key(CODEX_AUTH_KEYRING_SERVICE, account), value);
  }

  private key(service: string, account: string): string {
    return `${service}\0${account}`;
  }
}

/** Real native store with an observation counter around canonical saves. */
class CountingNativeAuthStore extends CodexNativeAuthStore {
  public saveCount = 0;

  public override async saveConfigured(
    identity: CodexAuthHomeIdentity,
    mode: CodexAuthStoreMode,
    value: string,
  ): Promise<void> {
    this.saveCount += 1;
    await super.saveConfigured(identity, mode, value);
  }
}

/** Native store that pauses its first canonical save while retaining the CAS lock. */
class PausingNativeAuthStore extends CountingNativeAuthStore {
  public constructor(
    keyring: CodexKeyringCredentialStore,
    private readonly onSaveStarted: () => void,
    private readonly continueSave: Promise<void>,
  ) {
    super(keyring);
  }

  public override async saveConfigured(
    identity: CodexAuthHomeIdentity,
    mode: CodexAuthStoreMode,
    value: string,
  ): Promise<void> {
    this.onSaveStarted();
    await this.continueSave;
    await super.saveConfigured(identity, mode, value);
  }
}

/** Native store that pauses the canonical setup read while its source lock remains held. */
class PausingSetupReadNativeAuthStore extends CodexNativeAuthStore {
  public constructor(
    keyring: CodexKeyringCredentialStore,
    private readonly onReadStarted: () => void,
    private readonly continueRead: Promise<void>,
  ) {
    super(keyring);
  }

  public override async readEffective(
    identity: CodexAuthHomeIdentity,
    mode: CodexAuthStoreMode,
  ): Promise<CodexEffectiveCredentialRead> {
    this.onReadStarted();
    await this.continueRead;
    return super.readEffective(identity, mode);
  }
}

/** Native store that fails only after target materialization for rollback coverage. */
class VerificationFailureNativeAuthStore extends CodexNativeAuthStore {
  public override async readBackend(
    _identity: CodexAuthHomeIdentity,
    _backend: CodexAuthStoreBackend,
  ): Promise<string | null> {
    throw new Error('target verification unavailable');
  }
}

/** Native store that swaps the target path immediately before setup rollback. */
class RedirectingVerificationFailureStore extends CodexNativeAuthStore {
  public constructor(
    keyring: CodexKeyringCredentialStore,
    private readonly redirectTarget: () => Promise<void>,
  ) {
    super(keyring);
  }

  public override async readBackend(
    _identity: CodexAuthHomeIdentity,
    _backend: CodexAuthStoreBackend,
  ): Promise<string | null> {
    await this.redirectTarget();
    throw new Error('target verification unavailable');
  }
}

/**
 * Build one production-shaped setup request.
 * @param sessionDir - Isolated session CODEX_HOME.
 * @param baseConfigDir - Canonical source CODEX_HOME.
 * @param configInheritance - Requested config-copy policy.
 * @returns Session config setup request.
 */
function makeSetupRequest(
  sessionDir: string,
  baseConfigDir: string,
  configInheritance: 'auth-only' | 'full' | 'empty' = 'auth-only',
) {
  return { sessionDir, baseConfigDir, platform: 'linux' as const, configInheritance };
}

/**
 * Collect nested aggregate messages without serializing secret-bearing causes.
 * @param error - Error or aggregate to flatten.
 * @returns Safe nested error messages.
 */
function collectErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(collectErrorMessages)];
  }
  return [error instanceof Error ? error.message : String(error)];
}

describe('CodexSessionConfigHandler', () => {
  let rootDir: string;
  let baseDir: string;
  let sessionDir: string;
  let keyring: MemoryKeyring;
  let handler: CodexSessionConfigHandler;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-auth-'));
    baseDir = path.join(rootDir, 'base');
    sessionDir = path.join(rootDir, 'session');
    await fs.mkdir(baseDir, { recursive: true });
    keyring = new MemoryKeyring();
    handler = new CodexSessionConfigHandler(new CodexNativeAuthStore(keyring), path.join(rootDir, 'native'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('inherits full config while keeping file auth isolated', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'model = "gpt-5"\n', 'utf-8');
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"source"}', 'utf-8');

    const result = await handler.setup(makeSetupRequest(sessionDir, baseDir, 'full'));

    expect(result).toEqual({ env: { CODEX_HOME: sessionDir }, authMaterialized: true });
    await expect(fs.readFile(path.join(sessionDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"source"}');
    const config = await fs.readFile(path.join(sessionDir, 'config.toml'), 'utf-8');
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('check_for_update_on_startup = false');
  });

  it('auth-only inherits no general config and preserves the native storage mode', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'model = "gpt-5"\n', 'utf-8');
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"source"}', 'utf-8');

    await handler.setup(makeSetupRequest(sessionDir, baseDir));

    const config = await fs.readFile(path.join(sessionDir, 'config.toml'), 'utf-8');
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('check_for_update_on_startup = false');
    expect(config).not.toContain('model = "gpt-5"');
  });

  it('empty inheritance neither reads nor clones canonical native auth', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"source-secret"}');

    const result = await handler.setup(makeSetupRequest(sessionDir, baseDir, 'empty'));

    expect(result.authMaterialized).toBe(false);
    await expect(fs.access(path.join(sessionDir, 'auth.json'))).rejects.toThrow();
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    expect(keyring.get(targetAccount)).toBeUndefined();
    expect(await fs.readFile(path.join(sessionDir, 'config.toml'), 'utf-8')).not.toContain(
      'cli_auth_credentials_store',
    );
  });

  it('reports missing file auth without retaining a stale target', async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"stale"}');

    const result = await handler.setup(makeSetupRequest(sessionDir, baseDir));

    expect(result.authMaterialized).toBe(false);
    await expect(fs.access(path.join(sessionDir, 'auth.json'))).rejects.toThrow();
  });

  it('uses the native CODEX_HOME when no profile source is configured', async () => {
    const nativeDir = path.join(rootDir, 'native');
    await fs.mkdir(nativeDir, { recursive: true });
    await fs.writeFile(path.join(nativeDir, 'auth.json'), '{"token":"native"}', 'utf-8');

    const result = await handler.setup(makeSetupRequest(sessionDir, sessionDir));

    expect(result.authMaterialized).toBe(true);
    await expect(fs.readFile(path.join(sessionDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"native"}');
  });

  it('rejects a symlink lease target before reading or writing native auth', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"canonical"}', 'utf-8');
    const redirectedDir = path.join(rootDir, 'redirected-target');
    await fs.mkdir(redirectedDir);
    await fs.symlink(redirectedDir, sessionDir, 'dir');

    await expect(handler.setup(makeSetupRequest(sessionDir, baseDir))).rejects.toThrow(
      'lease target must be a stable directory',
    );

    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"canonical"}');
    await expect(fs.access(path.join(redirectedDir, 'auth.json'))).rejects.toThrow();
  });

  it('pins a symlink source to its canonical CODEX_HOME for later write-back', async () => {
    const canonicalSource = path.join(rootDir, 'canonical-source');
    const replacementSource = path.join(rootDir, 'replacement-source');
    const sourceLink = path.join(rootDir, 'source-link');
    await Promise.all([fs.mkdir(canonicalSource), fs.mkdir(replacementSource)]);
    await fs.writeFile(path.join(canonicalSource, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await fs.writeFile(path.join(replacementSource, 'auth.json'), '{"token":"replacement"}', 'utf-8');
    await fs.symlink(canonicalSource, sourceLink, 'dir');
    await handler.setup(makeSetupRequest(sessionDir, sourceLink));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"refreshed"}', 'utf-8');
    await fs.rm(sourceLink);
    await fs.symlink(replacementSource, sourceLink, 'dir');

    await handler.teardown({ sessionDir, platform: 'linux' });

    await expect(fs.readFile(path.join(canonicalSource, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"refreshed"}');
    await expect(fs.readFile(path.join(replacementSource, 'auth.json'), 'utf-8')).resolves.toBe(
      '{"token":"replacement"}',
    );
  });

  it('rejects a source alias that resolves to the lease target before modifying credentials', async () => {
    await fs.mkdir(sessionDir);
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"must-remain"}', 'utf-8');
    const sourceAlias = path.join(rootDir, 'source-alias');
    await fs.symlink(sessionDir, sourceAlias, 'dir');

    await expect(handler.setup(makeSetupRequest(sessionDir, sourceAlias))).rejects.toThrow(
      'source and lease target must be different directories',
    );

    await expect(fs.readFile(path.join(sessionDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"must-remain"}');
    await expect(fs.access(path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE))).rejects.toThrow();
  });

  it('writes a changed file credential back when the canonical generation still matches', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"refreshed"}', 'utf-8');

    await expect(handler.teardown({ sessionDir, platform: 'linux' })).resolves.toEqual({ success: true });

    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"refreshed"}');
  });

  it('does not rewrite an unchanged file credential', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    const before = await fs.stat(path.join(baseDir, 'auth.json'));

    await handler.teardown({ sessionDir, platform: 'linux' });

    const after = await fs.stat(path.join(baseDir, 'auth.json'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it('lets a changed canonical generation win a refresh conflict', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"lease-refresh"}', 'utf-8');
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"canonical-newer"}', 'utf-8');

    await handler.teardown({ sessionDir, platform: 'linux' });

    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"canonical-newer"}');
  });

  it('treats a canonical storage-mode change as a generation conflict', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"lease-refresh"}', 'utf-8');
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');

    await handler.teardown({ sessionDir, platform: 'linux' });

    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"initial"}');
  });

  it('serializes independent handler write-backs so the second CAS observes the new source generation', async () => {
    const secondSessionDir = path.join(rootDir, 'session-two');
    const saveStarted = Promise.withResolvers<void>();
    const firstSaveGate = Promise.withResolvers<void>();
    const firstStore = new PausingNativeAuthStore(keyring, saveStarted.resolve, firstSaveGate.promise);
    const secondStore = new CountingNativeAuthStore(keyring);
    const firstHandler = new CodexSessionConfigHandler(firstStore);
    const secondHandler = new CodexSessionConfigHandler(secondStore);
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await Promise.all([
      firstHandler.setup(makeSetupRequest(sessionDir, baseDir)),
      secondHandler.setup(makeSetupRequest(secondSessionDir, baseDir)),
    ]);
    await Promise.all([
      fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"refresh-one"}', 'utf-8'),
      fs.writeFile(path.join(secondSessionDir, 'auth.json'), '{"token":"refresh-two"}', 'utf-8'),
    ]);

    const firstTeardown = firstHandler.teardown({ sessionDir, platform: 'linux' });
    await saveStarted.promise;
    const secondTeardown = secondHandler.teardown({ sessionDir: secondSessionDir, platform: 'linux' });
    firstSaveGate.resolve();
    await Promise.all([firstTeardown, secondTeardown]);

    expect(firstStore.saveCount).toBe(1);
    expect(secondStore.saveCount).toBe(0);
    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"refresh-one"}');
    await expect(fs.access(buildCodexNativeAuthSourceLockPath(baseDir))).rejects.toThrow();
  });

  it('holds the canonical source lock across setup read, digest, and target clone', async () => {
    const readStarted = Promise.withResolvers<void>();
    const continueRead = Promise.withResolvers<void>();
    const pausingStore = new PausingSetupReadNativeAuthStore(keyring, readStarted.resolve, continueRead.promise);
    const pausingHandler = new CodexSessionConfigHandler(pausingStore);
    const initial = '{"token":"initial"}';
    const selected = '{"token":"selected-account"}';
    await fs.writeFile(path.join(baseDir, 'auth.json'), initial, 'utf-8');

    const setup = pausingHandler.setup(makeSetupRequest(sessionDir, baseDir));
    await readStarted.promise;
    let accountWriteEntered = false;
    const accountWrite = withCodexNativeAuthSourceLock(baseDir, async () => {
      accountWriteEntered = true;
      await fs.writeFile(path.join(baseDir, 'auth.json'), selected, 'utf-8');
    });
    const accountWriteEnteredDuringClone = accountWriteEntered;
    continueRead.resolve();
    await Promise.all([setup, accountWrite]);

    expect(accountWriteEnteredDuringClone).toBe(false);
    await expect(fs.readFile(path.join(sessionDir, 'auth.json'), 'utf-8')).resolves.toBe(initial);
    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe(selected);
  });

  it('finishes a lease CAS before a competing canonical account write can enter', async () => {
    const saveStarted = Promise.withResolvers<void>();
    const continueSave = Promise.withResolvers<void>();
    const pausingStore = new PausingNativeAuthStore(keyring, saveStarted.resolve, continueSave.promise);
    const pausingHandler = new CodexSessionConfigHandler(pausingStore);
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await pausingHandler.setup(makeSetupRequest(sessionDir, baseDir));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"lease-refresh"}', 'utf-8');

    const teardown = pausingHandler.teardown({ sessionDir, platform: 'linux' });
    await saveStarted.promise;
    let accountWriteEntered = false;
    const accountWrite = withCodexNativeAuthSourceLock(baseDir, async () => {
      accountWriteEntered = true;
      await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"selected-account"}', 'utf-8');
    });

    const accountWriteEnteredWhileLeaseLocked = accountWriteEntered;
    continueSave.resolve();
    await Promise.all([teardown, accountWrite]);

    expect(accountWriteEnteredWhileLeaseLocked).toBe(false);
    expect(pausingStore.saveCount).toBe(1);
    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"selected-account"}');
  });

  it('clones and refreshes keyring auth using Codex 0.130 identities', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"initial"}');

    const result = await handler.setup(makeSetupRequest(sessionDir, baseDir));
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    expect(result.authMaterialized).toBe(true);
    expect(keyring.get(targetAccount)).toBe('{"token":"initial"}');
    await expect(fs.access(path.join(sessionDir, 'auth.json'))).rejects.toThrow();

    keyring.set(targetAccount, '{"token":"refreshed"}');
    await handler.teardown({ sessionDir, platform: 'linux' });

    expect(keyring.get(sourceAccount)).toBe('{"token":"refreshed"}');
    expect(keyring.get(targetAccount)).toBeUndefined();
  });

  it('uses file fallback for auto mode when the keyring is unavailable', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "auto"\n');
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"file-fallback"}', 'utf-8');
    keyring.failRead = new Error('unavailable and secret-file-fallback');

    const result = await handler.setup(makeSetupRequest(sessionDir, baseDir));

    expect(result.authMaterialized).toBe(true);
    await expect(fs.readFile(path.join(sessionDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"file-fallback"}');
  });

  it('prefers keyring over file when auto mode can read both', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "auto"\n');
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"file"}', 'utf-8');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"keyring"}');

    const result = await handler.setup(makeSetupRequest(sessionDir, baseDir));

    expect(result.authMaterialized).toBe(true);
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    expect(keyring.get(targetAccount)).toBe('{"token":"keyring"}');
    await expect(fs.access(path.join(sessionDir, 'auth.json'))).rejects.toThrow();
  });

  it('moves an auto-mode file refresh to keyring when keyring save becomes available', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "auto"\n');
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"refreshed"}', 'utf-8');

    await handler.teardown({ sessionDir, platform: 'linux' });

    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    expect(keyring.get(sourceAccount)).toBe('{"token":"refreshed"}');
    await expect(fs.access(path.join(baseDir, 'auth.json'))).rejects.toThrow();
  });

  it('preserves a fresher auto-mode file fallback when the unchanged target keyring becomes readable again', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "auto"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"initial"}');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    expect(keyring.get(targetAccount)).toBe('{"token":"initial"}');

    // Codex auto-save falls back to auth.json when keyring save fails. The old
    // target keyring entry can remain and must not hide this fresher file.
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"file-refresh"}', 'utf-8');
    await handler.teardown({ sessionDir, platform: 'linux' });

    expect(keyring.get(sourceAccount)).toBe('{"token":"file-refresh"}');
    expect(keyring.get(targetAccount)).toBeUndefined();
  });

  it('keeps a successful auto-mode keyring save successful when stale file cleanup fails', async () => {
    const store = new CodexNativeAuthStore(keyring);
    const identity = await identifyCodexAuthHome(baseDir);
    await fs.mkdir(path.join(baseDir, 'auth.json'));

    await expect(store.saveConfigured(identity, 'auto', '{"token":"keyring-wins"}')).resolves.toBeUndefined();

    expect(keyring.get(identity.keyringAccount)).toBe('{"token":"keyring-wins"}');
    expect((await fs.stat(path.join(baseDir, 'auth.json'))).isDirectory()).toBe(true);
  });

  it('persists only strict secret-free metadata with restrictive permissions', async () => {
    const credential = '{"access_token":"metadata-must-not-contain-this"}';
    await fs.writeFile(path.join(baseDir, 'auth.json'), credential, 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));

    const metadataPath = path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE);
    const metadata = await fs.readFile(metadataPath, 'utf-8');
    expect(metadata).not.toContain('metadata-must-not-contain-this');
    expect(metadata).toContain(createHash('sha256').update(credential).digest('hex'));
    if (process.platform !== 'win32') {
      expect((await fs.stat(metadataPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed on corrupt metadata while deleting the target keyring credential', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"initial"}');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    await fs.writeFile(path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE), '{"token":"do-not-echo"}');

    await expect(handler.teardown({ sessionDir, platform: 'linux' })).rejects.toThrow(
      'lease metadata is invalid; write-back was skipped',
    );
    expect(keyring.get(targetAccount)).toBeUndefined();
    expect(keyring.get(sourceAccount)).toBe('{"token":"initial"}');
  });

  it('fails closed when an active materialized lease loses its metadata marker', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"must-not-write-back"}', 'utf-8');
    await fs.rm(path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE));

    await expect(handler.teardown({ sessionDir, platform: 'linux' })).rejects.toThrow(
      'lease metadata is missing; write-back was skipped',
    );

    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"initial"}');
    await expect(fs.access(path.join(sessionDir, 'auth.json'))).rejects.toThrow();
  });

  it('rejects a valid marker that changes any trusted active generation field', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    await fs.writeFile(path.join(sessionDir, 'auth.json'), '{"token":"must-not-write-back"}', 'utf-8');
    const markerPath = path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE);
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf-8')) as {
      sourceGenerationDigest: string;
      initialTargetDigest: string;
    };
    const redirectedDigest = createHash('sha256').update('redirected-generation').digest('hex');
    marker.sourceGenerationDigest = redirectedDigest;
    marker.initialTargetDigest = redirectedDigest;
    await fs.writeFile(markerPath, JSON.stringify(marker));

    await expect(handler.teardown({ sessionDir, platform: 'linux' })).rejects.toThrow(
      'lease generation metadata changed; write-back was skipped',
    );

    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe('{"token":"initial"}');
  });

  it('rejects a validly shaped marker that redirects the target identity', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"initial"}');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    const markerPath = path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE);
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf-8')) as {
      targetIdentity: CodexAuthHomeIdentity;
    };
    marker.targetIdentity = await identifyCodexAuthHome(baseDir);
    await fs.writeFile(markerPath, JSON.stringify(marker));

    await expect(handler.teardown({ sessionDir, platform: 'linux' })).rejects.toThrow(
      'lease target identity is invalid; write-back was skipped',
    );

    expect(keyring.get(sourceAccount)).toBe('{"token":"initial"}');
  });

  it('never follows a replaced lease symlink into the canonical keyring during cleanup', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"canonical"}');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    expect(keyring.get(targetAccount)).toBe('{"token":"canonical"}');
    await fs.rm(sessionDir, { recursive: true });
    await fs.symlink(baseDir, sessionDir, 'dir');

    let failure: unknown;
    try {
      await handler.teardown({ sessionDir, platform: 'linux' });
    } catch (error) {
      failure = error;
    }

    expect(collectErrorMessages(failure)).toContain('Codex native-auth lease target is unsafe; write-back was skipped');
    expect(keyring.get(sourceAccount)).toBe('{"token":"canonical"}');
    expect(keyring.get(targetAccount)).toBeUndefined();
    await expect(fs.readFile(path.join(baseDir, 'config.toml'), 'utf-8')).resolves.toContain('keyring');
  });

  it('cleans a derived target keyring identity when metadata is missing after restart', async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    keyring.set(targetAccount, '{"token":"orphan"}');
    const restartedHandler = new CodexSessionConfigHandler(new CodexNativeAuthStore(keyring));

    await restartedHandler.teardown({ sessionDir, platform: 'linux' });

    expect(keyring.get(targetAccount)).toBeUndefined();
  });

  it('sanitizes keyring write-back errors and still deletes target credentials', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"initial"}');
    await handler.setup(makeSetupRequest(sessionDir, baseDir));
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    keyring.set(targetAccount, '{"token":"super-secret-refreshed"}');
    keyring.failWriteAccount = sourceAccount;

    let failure: unknown;
    try {
      await handler.teardown({ sessionDir, platform: 'linux' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('keyring write failed');
    expect(String(failure)).not.toContain('super-secret-refreshed');
    expect(keyring.get(targetAccount)).toBeUndefined();
  });

  it.each([
    'file',
    'empty',
  ] as const)('always removes a stale target keyring credential for %s leases', async (mode) => {
    if (mode === 'file') {
      await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"file"}', 'utf-8');
    }
    await handler.setup(makeSetupRequest(sessionDir, baseDir, mode === 'empty' ? 'empty' : 'auth-only'));
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    keyring.set(targetAccount, '{"token":"stale-target-keyring"}');

    await handler.teardown({ sessionDir, platform: 'linux' });

    expect(keyring.get(targetAccount)).toBeUndefined();
    await expect(fs.access(path.join(sessionDir, 'auth.json'))).rejects.toThrow();
  });

  it('attempts both target cleanup backends and reports sanitized aggregate failures', async () => {
    await handler.setup(makeSetupRequest(sessionDir, baseDir, 'empty'));
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    keyring.set(targetAccount, '{"token":"must-not-escape"}');
    keyring.failDeleteAccount = targetAccount;
    await fs.mkdir(path.join(sessionDir, 'auth.json'));

    let failure: unknown;
    try {
      await handler.teardown({ sessionDir, platform: 'linux' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors.map(String).join('\n')).toContain('keyring cleanup failed');
    expect(aggregate.errors.map(String).join('\n')).toContain('credential cleanup failed');
    expect(aggregate.errors.map(String).join('\n')).not.toContain('secret-bearing-delete-context');
    expect(aggregate.errors.map(String).join('\n')).not.toContain('must-not-escape');
  });

  it('rolls back a keyring target when setup fails after materialization', async () => {
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const sourceAccount = await buildCodexAuthKeyringAccount(baseDir);
    keyring.set(sourceAccount, '{"token":"initial"}');
    const failingHandler = new CodexSessionConfigHandler(new VerificationFailureNativeAuthStore(keyring));

    await expect(failingHandler.setup(makeSetupRequest(sessionDir, baseDir))).rejects.toThrow(
      'target verification unavailable',
    );

    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    expect(keyring.get(targetAccount)).toBeUndefined();
  });

  it('rolls back both target backends when file-auth setup fails after materialization', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"initial"}', 'utf-8');
    await fs.mkdir(sessionDir);
    const targetAccount = await buildCodexAuthKeyringAccount(sessionDir);
    keyring.set(targetAccount, '{"token":"stale-keyring"}');
    const failingHandler = new CodexSessionConfigHandler(new VerificationFailureNativeAuthStore(keyring));

    await expect(failingHandler.setup(makeSetupRequest(sessionDir, baseDir))).rejects.toThrow(
      'target verification unavailable',
    );

    await expect(fs.access(path.join(sessionDir, 'auth.json'))).rejects.toThrow();
    expect(keyring.get(targetAccount)).toBeUndefined();
  });

  it('does not follow a target symlink introduced immediately before setup rollback', async () => {
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"canonical-must-remain"}', 'utf-8');
    const failingStore = new RedirectingVerificationFailureStore(keyring, async () => {
      await fs.rm(sessionDir, { recursive: true });
      await fs.symlink(baseDir, sessionDir, 'dir');
    });
    const failingHandler = new CodexSessionConfigHandler(failingStore);

    await expect(failingHandler.setup(makeSetupRequest(sessionDir, baseDir))).rejects.toThrow(
      'Codex session config setup and cleanup both failed',
    );

    await expect(fs.readFile(path.join(baseDir, 'auth.json'), 'utf-8')).resolves.toBe(
      '{"token":"canonical-must-remain"}',
    );
  });
});

describe('Codex keyring identity', () => {
  it('uses cli|sha256(canonical CODEX_HOME).slice(0, 16)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-identity-'));
    try {
      const canonicalHome = path.join(rootDir, 'canonical');
      const linkedHome = path.join(rootDir, 'linked');
      await fs.mkdir(canonicalHome);
      await fs.symlink(canonicalHome, linkedHome, 'dir');
      const expected = `cli|${createHash('sha256')
        .update(await fs.realpath(canonicalHome))
        .digest('hex')
        .slice(0, 16)}`;

      expect(await buildCodexAuthKeyringAccount(linkedHome)).toBe(expected);
      expect((await identifyCodexAuthHome(linkedHome)).keyringAccount).toBe(expected);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
