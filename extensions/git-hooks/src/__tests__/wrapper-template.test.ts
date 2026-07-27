import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHookWrapper } from '../install/wrapper-template.js';

const tempDirs: string[] = [];
const RECEIVER_BOUNDARY_TIMEOUT_MS = 9_000;
const RECEIVER_TIMEOUT_GRACE_MS = 500;
const TEST_TIMEOUT_MS = 10_000;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('renderHookWrapper', () => {
  it('rejects invalid receiver timeout values before rendering shell input', () => {
    expect(() =>
      renderHookWrapper({
        hookName: 'post-commit',
        stateFile: '/tmp/.makaio-hooks.json',
        originalHook: undefined,
        receiverCommand: ['/bin/true'],
        receiverTimeoutSeconds: 0,
      }),
    ).toThrow('Receiver timeout must be a positive integer');
  });

  it(
    'bounds receiver delivery and preserves the original hook exit code',
    async () => {
      const dir = await makeTempDir('makaio-git-hook-wrapper-');
      const originalHook = path.join(dir, 'post-commit.pre-makaio');
      const wrapperPath = path.join(dir, 'post-commit');
      await fs.writeFile(originalHook, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
      await fs.writeFile(
        wrapperPath,
        renderHookWrapper({
          hookName: 'post-commit',
          stateFile: path.join(dir, '.makaio-hooks.json'),
          originalHook,
          receiverCommand: ['/bin/sleep', '10'],
        }),
        { mode: 0o755 },
      );

      const startedAt = Date.now();
      const { execa } = await import('execa');
      const result = await execa(wrapperPath, [], {
        cwd: dir,
        input: 'stdin payload',
        reject: false,
        timeout: RECEIVER_BOUNDARY_TIMEOUT_MS,
      });

      expect(Date.now() - startedAt).toBeLessThanOrEqual(RECEIVER_BOUNDARY_TIMEOUT_MS + RECEIVER_TIMEOUT_GRACE_MS);
      expect(result.exitCode).toBe(7);
    },
    TEST_TIMEOUT_MS,
  );
});
