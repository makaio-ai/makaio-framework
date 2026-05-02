/**
 * Tests for {@link NpmStrategy}.
 *
 * All I/O is injected via mock {@link StrategyDependencies} — no real `npm`
 * process is spawned and no file-system operations are performed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NpmInstallDescriptor } from '@makaio/contracts/client';
import { NpmStrategy } from '../npm-strategy.js';
import type { StrategyDependencies, StrategyProgressCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Standard npm descriptor used across tests. */
const DESCRIPTOR: NpmInstallDescriptor = {
  type: 'npm',
  package: '@anthropic-ai/claude-code',
};

/**
 * Build a full {@link StrategyDependencies} mock with sensible defaults.
 * @param overrides - Partial overrides for the dependency mock.
 */
function makeDeps(overrides: Partial<StrategyDependencies> = {}): StrategyDependencies {
  return {
    fetchText: vi.fn().mockResolvedValue(''),
    fetchJson: vi.fn().mockResolvedValue({}),
    downloadFile: vi.fn().mockImplementation((_url, destPath) => Promise.resolve(destPath)),
    exec: vi.fn().mockResolvedValue('"1.0.0"'),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    computeChecksum: vi.fn().mockResolvedValue(''),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveLatestVersion
// ---------------------------------------------------------------------------

describe('NpmStrategy.resolveLatestVersion', () => {
  it('runs npm view with --json and strips surrounding quotes', async () => {
    const deps = makeDeps({ exec: vi.fn().mockResolvedValue('"2.3.4"') });
    const strategy = new NpmStrategy(DESCRIPTOR, deps);

    const version = await strategy.resolveLatestVersion();

    expect(version).toBe('2.3.4');
    expect(deps.exec).toHaveBeenCalledOnce();
    expect(deps.exec).toHaveBeenCalledWith('npm', ['view', '@anthropic-ai/claude-code', 'version', '--json']);
  });

  it('handles output without surrounding quotes', async () => {
    const deps = makeDeps({ exec: vi.fn().mockResolvedValue('1.0.0') });
    const strategy = new NpmStrategy(DESCRIPTOR, deps);

    const version = await strategy.resolveLatestVersion();

    expect(version).toBe('1.0.0');
  });

  it('propagates exec errors', async () => {
    const deps = makeDeps({
      exec: vi.fn().mockRejectedValue(new Error('npm not found')),
    });
    const strategy = new NpmStrategy(DESCRIPTOR, deps);

    await expect(strategy.resolveLatestVersion()).rejects.toThrow('npm not found');
  });
});

// ---------------------------------------------------------------------------
// execute — happy path
// ---------------------------------------------------------------------------

describe('NpmStrategy.execute', () => {
  let deps: StrategyDependencies;
  let strategy: NpmStrategy;
  let onProgress: ReturnType<typeof vi.fn<StrategyProgressCallback>>;

  beforeEach(() => {
    deps = makeDeps({ exec: vi.fn().mockResolvedValue('') });
    strategy = new NpmStrategy(DESCRIPTOR, deps);
    onProgress = vi.fn<StrategyProgressCallback>();
  });

  it('returns an InstallArtifact pointing to targetDir', async () => {
    const artifact = await strategy.execute('1.0.0', '/install/dir', onProgress);

    expect(artifact).toEqual({
      installPath: '/install/dir',
      version: '1.0.0',
      strategy: 'npm',
    });
  });

  it('runs npm install with the pinned package spec and --prefix', async () => {
    await strategy.execute('1.0.0', '/install/dir', onProgress);

    expect(deps.exec).toHaveBeenCalledWith('npm', [
      'install',
      '@anthropic-ai/claude-code@1.0.0',
      '--prefix',
      '/install/dir',
      '--no-save',
      '--ignore-scripts',
    ]);
  });

  it('includes the correct version in the package spec', async () => {
    await strategy.execute('3.1.4', '/my/target', onProgress);

    expect(deps.exec).toHaveBeenCalledWith('npm', [
      'install',
      '@anthropic-ai/claude-code@3.1.4',
      '--prefix',
      '/my/target',
      '--no-save',
      '--ignore-scripts',
    ]);
  });

  it('emits installing progress callbacks', async () => {
    await strategy.execute('1.0.0', '/install/dir', onProgress);

    const stages = onProgress.mock.calls.map(([stage]) => stage);
    expect(stages).toContain('installing');
  });

  it('does not make any network or file-system calls', async () => {
    await strategy.execute('1.0.0', '/install/dir', onProgress);

    expect(deps.fetchText).not.toHaveBeenCalled();
    expect(deps.fetchJson).not.toHaveBeenCalled();
    expect(deps.downloadFile).not.toHaveBeenCalled();
    expect(deps.extractArchive).not.toHaveBeenCalled();
    expect(deps.deleteFile).not.toHaveBeenCalled();
    expect(deps.computeChecksum).not.toHaveBeenCalled();
  });

  it('propagates exec errors from npm install', async () => {
    const failingDeps = makeDeps({
      exec: vi.fn().mockRejectedValue(new Error('ENOENT: npm not found')),
    });
    const failingStrategy = new NpmStrategy(DESCRIPTOR, failingDeps);

    await expect(failingStrategy.execute('1.0.0', '/install/dir')).rejects.toThrow('ENOENT: npm not found');
  });

  it('works correctly for unscoped package names', async () => {
    const descriptor: NpmInstallDescriptor = { type: 'npm', package: 'typescript' };
    const strategy2 = new NpmStrategy(descriptor, deps);

    await strategy2.execute('5.0.0', '/install/dir');

    expect(deps.exec).toHaveBeenCalledWith('npm', [
      'install',
      'typescript@5.0.0',
      '--prefix',
      '/install/dir',
      '--no-save',
      '--ignore-scripts',
    ]);
  });
});
