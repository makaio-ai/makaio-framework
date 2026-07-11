import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCodexNativeAuthSourceLockPath, withCodexNativeAuthSourceLock } from '@makaio/client-codex/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBackend } from '../backends/file-backend.js';
import type { ICredentialBackend } from '../backends/credential-backend.js';
import { CodexSource } from '../sources/codex-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';

/** Real file backend decorated only with mutation-entry observations. */
class ObservingCredentialBackend implements ICredentialBackend {
  public writeEntered = false;
  public clearEntered = false;

  /** @param delegate - Production file backend receiving each operation. */
  public constructor(private readonly delegate: FileBackend) {}

  public read(): Promise<string | null> {
    return this.delegate.read();
  }

  public async write(value: string): Promise<void> {
    this.writeEntered = true;
    await this.delegate.write(value);
  }

  public async clear(): Promise<void> {
    this.clearEntered = true;
    await this.delegate.clear();
  }
}

describe('CodexSource native source lock', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  /** Create one real CODEX_HOME for production lock and file-backend behavior. */
  async function makeCodexHome(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-account-source-'));
    tempDirs.push(dir);
    return fs.realpath(dir);
  }

  it('does not enter an account write while another native-auth source operation owns CODEX_HOME', async () => {
    const codexHome = await makeCodexHome();
    const backend = new ObservingCredentialBackend(new FileBackend(path.join(codexHome, 'auth.json')));
    const source = new CodexSource(backend, { codexHome });
    const token = '{"auth_mode":"apikey","OPENAI_API_KEY":"selected-account"}';
    let pendingWrite: Promise<void> | undefined;
    let writeEnteredWhileLocked = false;

    await withCodexNativeAuthSourceLock(codexHome, async () => {
      pendingWrite = source.write({ token, fingerprint: computeFingerprint(token), metadata: {} });
      writeEnteredWhileLocked = backend.writeEntered;
    });
    if (pendingWrite === undefined) throw new Error('Expected write to be scheduled.');
    await pendingWrite;

    expect(writeEnteredWhileLocked).toBe(false);
    expect(backend.writeEntered).toBe(true);
    await expect(fs.readFile(path.join(codexHome, 'auth.json'), 'utf-8')).resolves.toBe(token);
  });

  it('does not enter account clearing while another native-auth source operation owns CODEX_HOME', async () => {
    const codexHome = await makeCodexHome();
    const authPath = path.join(codexHome, 'auth.json');
    await fs.writeFile(authPath, '{"token":"initial"}', 'utf-8');
    const backend = new ObservingCredentialBackend(new FileBackend(authPath));
    const source = new CodexSource(backend, { codexHome });
    let pendingClear: Promise<void> | undefined;
    let clearEnteredWhileLocked = false;

    await withCodexNativeAuthSourceLock(codexHome, async () => {
      pendingClear = source.clear();
      clearEnteredWhileLocked = backend.clearEntered;
    });
    if (pendingClear === undefined) throw new Error('Expected clear to be scheduled.');
    await pendingClear;

    expect(clearEnteredWhileLocked).toBe(false);
    expect(backend.clearEntered).toBe(true);
    await expect(fs.access(authPath)).rejects.toThrow();
  });

  it('does not overwrite a newer native generation during prepared rollback', async () => {
    const codexHome = await makeCodexHome();
    const authPath = path.join(codexHome, 'auth.json');
    const previous = '{"auth_mode":"apikey","OPENAI_API_KEY":"previous"}';
    const target = '{"auth_mode":"apikey","OPENAI_API_KEY":"target"}';
    const refreshed = '{"auth_mode":"apikey","OPENAI_API_KEY":"refreshed"}';
    await fs.writeFile(authPath, previous, 'utf-8');
    const source = new CodexSource(new FileBackend(authPath), { codexHome });

    const prepared = await source.prepareNativeCredentialMutation({
      token: target,
      fingerprint: computeFingerprint(target),
      metadata: {},
    });
    await fs.writeFile(authPath, refreshed, 'utf-8');

    await expect(prepared.rollback()).resolves.toEqual({ status: 'superseded', coordination: 'released' });
    await expect(fs.readFile(authPath, 'utf-8')).resolves.toBe(refreshed);
  });

  it('rejects a mutable lexical alias before touching its redirected credential backend', async () => {
    const root = await makeCodexHome();
    const canonicalHome = path.join(root, 'canonical');
    const aliasHome = path.join(root, 'alias');
    const authPath = path.join(canonicalHome, 'auth.json');
    await fs.mkdir(canonicalHome);
    await fs.writeFile(authPath, 'previous', 'utf-8');
    await fs.symlink(canonicalHome, aliasHome, 'dir');
    const source = new CodexSource(new FileBackend(path.join(aliasHome, 'auth.json')), { codexHome: aliasHome });
    const secret = 'credential-through-retargetable-alias';

    const write = source.write({ token: secret, fingerprint: computeFingerprint(secret), metadata: {} });

    await expect(write).rejects.toThrow('codex native credential mutation failed');
    await expect(write).rejects.not.toThrow(secret);
    await expect(fs.readFile(authPath, 'utf-8')).resolves.toBe('previous');
  });

  it('does not expose backend credential context when a native write fails', async () => {
    const codexHome = await makeCodexHome();
    const secret = 'credential-that-must-not-escape';
    const source = new CodexSource(
      {
        read: async () => null,
        write: async (value) => {
          throw new Error(`backend rejected ${value}`);
        },
        clear: async () => undefined,
      },
      { codexHome },
    );

    const write = source.write({ token: secret, fingerprint: computeFingerprint(secret), metadata: {} });

    await expect(write).rejects.toThrow('codex native credential mutation failed');
    await expect(write).rejects.not.toThrow(secret);
  });

  it('retains a committed native write when only source-lock cleanup fails', async () => {
    const codexHome = await makeCodexHome();
    const authPath = path.join(codexHome, 'auth.json');
    const lockPath = buildCodexNativeAuthSourceLockPath(codexHome);
    tempDirs.push(lockPath);
    const delegate = new FileBackend(authPath);
    const source = new CodexSource(
      {
        read: () => delegate.read(),
        write: async (value) => {
          await delegate.write(value);
          await fs.writeFile(path.join(lockPath, 'cleanup-blocker'), 'committed');
        },
        clear: () => delegate.clear(),
      },
      { codexHome },
    );
    const token = '{"auth_mode":"apikey","OPENAI_API_KEY":"committed"}';

    await expect(
      source.write({ token, fingerprint: computeFingerprint(token), metadata: {} }),
    ).resolves.toBeUndefined();
    await expect(fs.readFile(authPath, 'utf-8')).resolves.toBe(token);
  });

  it('serializes file-mode configuration with every other native source mutation', async () => {
    const codexHome = await makeCodexHome();
    const configPath = path.join(codexHome, 'config.toml');
    const source = new CodexSource(new FileBackend(path.join(codexHome, 'auth.json')), { codexHome });
    let configure: Promise<void> | undefined;
    let configExistedWhileLocked = false;

    await withCodexNativeAuthSourceLock(codexHome, async () => {
      configure = source.configureFileMode();
      configExistedWhileLocked = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
    });
    if (configure === undefined) throw new Error('Expected configuration to be scheduled.');
    await configure;

    expect(configExistedWhileLocked).toBe(false);
    await expect(fs.readFile(configPath, 'utf-8')).resolves.toContain('cli_auth_credentials_store = "file"');
  });
});
