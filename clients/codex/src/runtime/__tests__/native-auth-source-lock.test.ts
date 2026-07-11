import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodexNativeAuthSourceLockPath,
  CodexNativeAuthSourceLockFinalizationError,
  executeCodexNativeAuthSourceLock,
  withCodexNativeAuthSourceLock,
} from '../native-auth-source-lock.js';

describe('Codex native-auth source lock', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('retains a committed result when sibling-lock cleanup becomes uncertain', async () => {
    const codexHome = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'makaio-codex-lock-'));
    const lockPath = buildCodexNativeAuthSourceLockPath(codexHome);
    tempDirs.push(codexHome, lockPath);

    const result = await executeCodexNativeAuthSourceLock(codexHome, async () => {
      await fs.writeFile(path.join(lockPath, 'cleanup-blocker'), 'committed');
      return 'committed';
    });

    expect(result).toEqual({ value: 'committed', coordination: 'uncertain' });
  });

  it('keeps the strict compatibility wrapper fail-closed on uncertain cleanup', async () => {
    const codexHome = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'makaio-codex-lock-'));
    const lockPath = buildCodexNativeAuthSourceLockPath(codexHome);
    tempDirs.push(codexHome, lockPath);

    await expect(
      withCodexNativeAuthSourceLock(codexHome, async () => {
        await fs.writeFile(path.join(lockPath, 'cleanup-blocker'), 'committed');
      }),
    ).rejects.toBeInstanceOf(CodexNativeAuthSourceLockFinalizationError);
  });

  it('serializes canonical and aliased CODEX_HOME identities across processes', async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'makaio-codex-lock-process-'));
    const codexHome = path.join(root, 'canonical');
    const aliasHome = path.join(root, 'alias');
    await fs.mkdir(codexHome);
    await fs.symlink(codexHome, aliasHome, 'dir');
    tempDirs.push(root, buildCodexNativeAuthSourceLockPath(codexHome));
    const fixture = path.join(import.meta.dirname, 'fixtures', 'native-auth-source-lock-child.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, aliasHome], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', (chunk: Buffer) => {
          if (chunk.toString().includes('LOCKED')) resolve();
          else reject(new Error('Child did not acquire the expected source lock.'));
        });
      });
      let parentEntered = false;
      const parent = withCodexNativeAuthSourceLock(codexHome, async () => {
        parentEntered = true;
      });
      const parentEnteredWhileChildLocked = parentEntered;
      const childExit = once(child, 'exit');
      child.stdin.end('release\n');
      const [exitCode] = (await childExit) as [number | null, NodeJS.Signals | null];
      await parent;

      expect(parentEnteredWhileChildLocked).toBe(false);
      expect(parentEntered).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 15_000);
});
