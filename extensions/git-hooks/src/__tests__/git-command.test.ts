import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LaunchStatus } from '@makaio/subprocess';
import { recordingLaunch } from '@makaio/subprocess/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { gitOutput, gitOutputOptional } from '../install/git-command.js';

const NON_COMPLETED_STATUSES: readonly Exclude<LaunchStatus, 'completed'>[] = [
  'failed',
  'cancelled',
  'timed-out',
  'output-limit',
  'spawn-failed',
  'stop-failed',
];

describe('gitOutput through the start port', () => {
  it('starts git directly with the given arguments, working directory, and bounds', async () => {
    const { launch, calls } = recordingLaunch({
      status: 'completed',
      output: { stdout: 'ignored\n', stderr: '' },
    });

    await gitOutput(['log', '-1', '--format=%H %s'], '/work/dir', launch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: 'git',
      args: ['log', '-1', '--format=%H %s'],
      cwd: '/work/dir',
      envMode: 'merge',
      timeoutMs: 30_000,
      output: { kind: 'capture', limitBytes: 10 * 1024 * 1024 },
    });
  });

  it('returns trimmed stdout of a completed command', async () => {
    const { launch } = recordingLaunch({
      status: 'completed',
      output: { stdout: '  refs/heads/main\n\n', stderr: 'warning: ignored' },
    });

    await expect(gitOutput(['symbolic-ref', 'HEAD'], '/work/dir', launch)).resolves.toBe('refs/heads/main');
  });

  it('returns an empty string for a completed command without output', async () => {
    const { launch } = recordingLaunch({ status: 'completed', output: { stdout: '', stderr: '' } });

    await expect(gitOutput(['status'], '/work/dir', launch)).resolves.toBe('');
  });

  it.each(NON_COMPLETED_STATUSES)('rejects with a fixed text naming only the status %s', async (status) => {
    const { launch } = recordingLaunch({
      status,
      output: { stdout: 'secret-stdout', stderr: 'secret-stderr' },
      message: 'secret-message',
    });

    const error = await gitOutput(['config', '--get', 'secret.key'], '/secret/dir', launch).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`git command ended with status ${status}`);
  });

  it('rejects when a completed command carries no captured output', async () => {
    const { launch } = recordingLaunch({ status: 'completed' });

    await expect(gitOutput(['status'], '/work/dir', launch)).rejects.toThrow('git command ended with status completed');
  });
});

describe('gitOutputOptional through the start port', () => {
  it('passes the same command and bounds to the port', async () => {
    const { launch, calls } = recordingLaunch({ status: 'completed', output: { stdout: 'x', stderr: '' } });

    await gitOutputOptional(['config', '--get', 'core.hooksPath'], '/work/dir', launch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'git',
      args: ['config', '--get', 'core.hooksPath'],
      cwd: '/work/dir',
      envMode: 'merge',
      timeoutMs: 30_000,
      output: { kind: 'capture', limitBytes: 10 * 1024 * 1024 },
    });
  });

  it('returns the trimmed stdout of a completed command', async () => {
    const { launch } = recordingLaunch({ status: 'completed', output: { stdout: '.githooks\n', stderr: '' } });

    await expect(gitOutputOptional(['config', '--get', 'core.hooksPath'], '/work/dir', launch)).resolves.toBe(
      '.githooks',
    );
  });

  it('returns undefined for empty output', async () => {
    const { launch } = recordingLaunch({ status: 'completed', output: { stdout: '\n', stderr: '' } });

    await expect(
      gitOutputOptional(['config', '--get', 'core.hooksPath'], '/work/dir', launch),
    ).resolves.toBeUndefined();
  });

  it.each(NON_COMPLETED_STATUSES)('returns undefined for status %s', async (status) => {
    const { launch } = recordingLaunch({ status, output: { stdout: 'value', stderr: '' } });

    await expect(
      gitOutputOptional(['config', '--get', 'core.hooksPath'], '/work/dir', launch),
    ).resolves.toBeUndefined();
  });
});

describe('git-command with real git', { timeout: 120_000 }, () => {
  const tempDirs: string[] = [];

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('runs git in a temporary repository and reads its output', async () => {
    const repo = await makeTempDir('makaio-git-command-');

    await gitOutput(['init', '--initial-branch=main'], repo);

    await expect(gitOutput(['rev-parse', '--is-inside-work-tree'], repo)).resolves.toBe('true');
    await expect(gitOutput(['symbolic-ref', '--short', 'HEAD'], repo)).resolves.toBe('main');
    await expect(gitOutputOptional(['config', '--local', '--get', 'core.hooksPath'], repo)).resolves.toBeUndefined();
  });

  it('passes an argument with spaces and quotes through unchanged', async () => {
    const repo = await makeTempDir('makaio-git-command-arg-');
    await gitOutput(['init', '--initial-branch=main'], repo);
    const value = `two words "quoted" 'single' $HOME`;

    await gitOutput(['config', '--local', 'makaio.test', value], repo);

    await expect(gitOutput(['config', '--local', '--get', 'makaio.test'], repo)).resolves.toBe(value);
  });

  it('rejects for a working directory that does not exist', async () => {
    const parent = await makeTempDir('makaio-git-command-missing-');
    const missing = path.join(parent, 'does-not-exist');

    await expect(gitOutput(['status'], missing)).rejects.toThrow('git command ended with status spawn-failed');
    await expect(gitOutputOptional(['status'], missing)).resolves.toBeUndefined();
  });
});
