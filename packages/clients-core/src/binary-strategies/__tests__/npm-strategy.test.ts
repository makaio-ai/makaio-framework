/**
 * Tests for {@link NpmStrategy}.
 *
 * All I/O is injected via mock {@link StrategyDependencies} — no real `npm`
 * process is spawned and no file-system operations are performed.
 *
 * The npm strategy is pin-only: the descriptor must declare an exact version
 * and `execute` rejects any caller-supplied version that differs from that pin.
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
  package: '@openai/codex',
  version: '0.130.0',
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
    exec: vi.fn().mockResolvedValue(''),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    computeChecksum: vi.fn().mockResolvedValue(''),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// execute — pin-only behaviour
// ---------------------------------------------------------------------------

describe('NpmStrategy.execute', () => {
  let deps: StrategyDependencies;
  let onProgress: ReturnType<typeof vi.fn<StrategyProgressCallback>>;

  beforeEach(() => {
    deps = makeDeps();
    onProgress = vi.fn<StrategyProgressCallback>();
  });

  it('installs the exact descriptor package version under the target prefix', async () => {
    const strategy = new NpmStrategy(DESCRIPTOR, deps);

    const artifact = await strategy.execute('0.130.0', '/tmp/makaio/binaries/codex/0.130.0');

    expect(deps.exec).toHaveBeenCalledWith('npm', [
      'install',
      '@openai/codex@0.130.0',
      '--prefix',
      '/tmp/makaio/binaries/codex/0.130.0',
      '--no-save',
      '--ignore-scripts',
    ]);
    expect(artifact).toEqual({
      installPath: '/tmp/makaio/binaries/codex/0.130.0',
      version: '0.130.0',
      strategy: 'npm',
    });
  });

  it('rejects execution when the requested version differs from the descriptor pin', async () => {
    const strategy = new NpmStrategy(DESCRIPTOR, deps);

    await expect(strategy.execute('0.129.0', '/tmp/install')).rejects.toThrow(
      'npm managed install requested version 0.129.0 but descriptor pins 0.130.0',
    );
  });

  it('emits installing progress callbacks', async () => {
    const strategy = new NpmStrategy(DESCRIPTOR, deps);

    await strategy.execute('0.130.0', '/tmp/makaio/binaries/codex/0.130.0', onProgress);

    const stages = onProgress.mock.calls.map(([stage]) => stage);
    expect(stages).toContain('installing');
  });

  it('does not make any network or file-system calls', async () => {
    const strategy = new NpmStrategy(DESCRIPTOR, deps);

    await strategy.execute('0.130.0', '/tmp/makaio/binaries/codex/0.130.0');

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
    const strategy = new NpmStrategy(DESCRIPTOR, failingDeps);

    await expect(strategy.execute('0.130.0', '/tmp/install')).rejects.toThrow('ENOENT: npm not found');
  });
});
