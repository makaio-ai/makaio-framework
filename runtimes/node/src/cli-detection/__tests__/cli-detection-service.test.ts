import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCLI, detectCLIs, probeExecutableVersion, resolveExecutablePath } from '../cli-detection-service.js';

const temporaryDirectories: string[] = [];
const resolvedPath = (binary: string): Promise<string> => Promise.resolve(`/usr/local/bin/${binary}`);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CLI detection', () => {
  it.skipIf(process.platform === 'win32')('resolves the first executable in PATH order', async () => {
    const firstDirectory = await createTemporaryDirectory();
    const secondDirectory = await createTemporaryDirectory();
    const executableName = 'makaio-cli-detection-fixture';
    const expectedPath = join(secondDirectory, executableName);
    await writeFile(expectedPath, '#!/bin/sh\nexit 0\n');
    await chmod(expectedPath, 0o755);

    await expect(
      resolveExecutablePath(executableName, {
        PATH: [firstDirectory, secondDirectory].join(':'),
      }),
    ).resolves.toBe(expectedPath);
  });

  it('returns the resolved path and parsed version', async () => {
    const probeVersion = vi.fn(async () => 'claude version 1.0.51');

    await expect(detectCLI('claude', resolvedPath, probeVersion)).resolves.toEqual({
      binary: 'claude',
      found: true,
      path: '/usr/local/bin/claude',
      version: '1.0.51',
    });
    expect(probeVersion).toHaveBeenCalledWith('/usr/local/bin/claude');
  });

  it.skipIf(process.platform === 'win32')('force-kills a version probe that ignores SIGTERM', async () => {
    const directory = await createTemporaryDirectory();
    const executablePath = join(directory, 'ignores-term');
    await writeFile(executablePath, "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n");
    await chmod(executablePath, 0o755);

    await expect(probeExecutableVersion(executablePath, 250, 25)).rejects.toMatchObject({
      timedOut: true,
      isForcefullyTerminated: true,
    });
  });

  it.skipIf(process.platform !== 'win32')('executes Windows command shims', async () => {
    const directory = await createTemporaryDirectory();
    const executablePath = join(directory, 'version-fixture.cmd');
    await writeFile(executablePath, '@echo off\r\necho fixture 1.2.3\r\n');

    await expect(probeExecutableVersion(executablePath, 1_000, 100)).resolves.toBe('fixture 1.2.3');
  });

  it('does not probe an unresolved binary', async () => {
    const probeVersion = vi.fn(async () => '1.0.0');

    await expect(detectCLI('missing', async () => undefined, probeVersion)).resolves.toEqual({
      binary: 'missing',
      found: false,
    });
    expect(probeVersion).not.toHaveBeenCalled();
  });

  it('returns not found when the version probe fails or emits no stdout', async () => {
    await expect(
      detectCLI('broken', resolvedPath, async () => {
        throw new Error('probe failed');
      }),
    ).resolves.toEqual({ binary: 'broken', found: false });
    await expect(detectCLI('silent', resolvedPath, async () => '')).resolves.toEqual({
      binary: 'silent',
      found: false,
    });
  });

  it('uses unknown when successful version output contains no semantic version', async () => {
    await expect(detectCLI('weird', resolvedPath, async () => 'some weird output')).resolves.toEqual({
      binary: 'weird',
      found: true,
      path: '/usr/local/bin/weird',
      version: 'unknown',
    });
  });

  it('detects multiple binaries in parallel and preserves request order', async () => {
    const releaseFirstProbe = Promise.withResolvers<string>();
    const probeVersion = vi.fn(async (executablePath: string) => {
      if (executablePath.endsWith('/claude')) {
        return releaseFirstProbe.promise;
      }
      if (executablePath.endsWith('/gemini')) {
        releaseFirstProbe.resolve('claude 1.0.51');
        return 'gemini 2.1.0';
      }
      throw new Error('probe failed');
    });

    await expect(detectCLIs(['claude', 'gemini', 'codex'], resolvedPath, probeVersion)).resolves.toEqual([
      { binary: 'claude', found: true, path: '/usr/local/bin/claude', version: '1.0.51' },
      { binary: 'gemini', found: true, path: '/usr/local/bin/gemini', version: '2.1.0' },
      { binary: 'codex', found: false },
    ]);
    expect(probeVersion).toHaveBeenCalledTimes(3);
  });

  it('handles an empty request', async () => {
    const probeVersion = vi.fn(async () => '1.0.0');

    await expect(detectCLIs([], resolvedPath, probeVersion)).resolves.toEqual([]);
    expect(probeVersion).not.toHaveBeenCalled();
  });
});

/**
 * Create a temporary directory tracked for cleanup.
 * @returns Absolute temporary directory path.
 */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'makaio-cli-detection-'));
  temporaryDirectories.push(directory);
  return directory;
}
