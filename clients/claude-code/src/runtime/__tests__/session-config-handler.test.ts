import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  symlinkError: undefined as NodeJS.ErrnoException | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    symlink: vi.fn((target: string, pathName: string, type?: string) => {
      if (fsMockState.symlinkError !== undefined) {
        return Promise.reject(fsMockState.symlinkError);
      }
      return actual.symlink(target, pathName, type as never);
    }),
  };
});

import { handleClaudeCodeSessionConfigSetup } from '../session-config-handler.js';

describe('handleClaudeCodeSessionConfigSetup', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    fsMockState.symlinkError = undefined;
    vi.mocked(fs.symlink).mockClear();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  /**
   * Create and track a temporary directory.
   * @param prefix - Directory name prefix.
   * @returns Temporary directory path.
   */
  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('uses native Claude config as immutable source when no profile base exists', async () => {
    const homeDir = await makeTempDir('makaio-claude-home-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    const nativeConfigDir = path.join(homeDir, '.claude');
    await fs.mkdir(nativeConfigDir, { recursive: true });
    await fs.writeFile(path.join(nativeConfigDir, 'settings.json'), '{"theme":"dark"}', 'utf-8');
    vi.stubEnv('HOME', homeDir);

    const result = await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sessionDir,
      platform: 'darwin',
    });

    await expect(fs.readFile(path.join(sessionDir, 'settings.json'), 'utf-8')).resolves.toBe('{"theme":"dark"}');
    await expect(fs.readFile(path.join(nativeConfigDir, 'settings.json'), 'utf-8')).resolves.toBe('{"theme":"dark"}');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: sessionDir });
  });

  it('copies credentials when Windows symlink creation is denied', async () => {
    const sourceDir = await makeTempDir('makaio-claude-source-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    await fs.writeFile(path.join(sourceDir, 'settings.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(sourceDir, '.credentials.json'), '{"token":"secret"}', 'utf-8');
    fsMockState.symlinkError = Object.assign(new Error('denied'), { code: 'EPERM' });

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sourceDir,
      platform: 'win32',
    });

    expect(fs.symlink).toHaveBeenCalled();
    await expect(fs.readFile(path.join(sessionDir, '.credentials.json'), 'utf-8')).resolves.toBe('{"token":"secret"}');
    await expect(fs.readFile(path.join(sourceDir, '.credentials.json'), 'utf-8')).resolves.toBe('{"token":"secret"}');
  });
});
