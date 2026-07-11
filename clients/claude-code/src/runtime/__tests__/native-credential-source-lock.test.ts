import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeCredentialSourceLock,
  NativeCredentialSourceLockFinalizationError,
  withCredentialSourceLock,
} from '../native-credential-source-lock.js';

describe('Claude Code native credential source lock', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('retains a committed result when lock cleanup becomes uncertain', async () => {
    const sourceDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'makaio-claude-lock-'));
    tempDirs.push(sourceDir, `${sourceDir}.lock`);

    const result = await executeCredentialSourceLock(sourceDir, async () => {
      await fs.writeFile(path.join(`${sourceDir}.lock`, 'cleanup-blocker'), 'committed');
      return 'committed';
    });

    expect(result).toEqual({ value: 'committed', coordination: 'uncertain' });
  });

  it('keeps the strict compatibility wrapper fail-closed on uncertain cleanup', async () => {
    const sourceDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'makaio-claude-lock-'));
    tempDirs.push(sourceDir, `${sourceDir}.lock`);

    await expect(
      withCredentialSourceLock(sourceDir, async () => {
        await fs.writeFile(path.join(`${sourceDir}.lock`, 'cleanup-blocker'), 'committed');
      }),
    ).rejects.toBeInstanceOf(NativeCredentialSourceLockFinalizationError);
  });
});
