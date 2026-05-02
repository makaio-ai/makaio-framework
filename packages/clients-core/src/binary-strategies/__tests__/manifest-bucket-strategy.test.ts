/**
 * Tests for {@link ManifestBucketStrategy}.
 *
 * All I/O is injected via mock {@link StrategyDependencies} — no real network
 * calls or file-system operations are performed.
 *
 * Strategy tests verify behavior through injected StrategyDependencies —
 * the I/O seam is the boundary. Integration tests with real HTTP belong
 * in a separate test layer.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestBucketInstallDescriptor } from '@makaio/contracts/client';
import { ManifestBucketStrategy } from '../manifest-bucket-strategy.js';
import type { StrategyDependencies, StrategyProgressCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal manifest-bucket descriptor used across tests. */
const BASE_DESCRIPTOR: ManifestBucketInstallDescriptor = {
  type: 'manifest-bucket',
  config: {
    baseUrl: 'https://storage.example.com/client',
    versionIndex: { latest: 'latest.txt' },
    manifestPath: 'manifest.json',
    manifestChecksumField: 'sha256',
    binaryPath: 'client-linux-x64.tar.gz',
    archiveFormat: 'tar.gz',
  },
};

/**
 * Build a full {@link StrategyDependencies} mock with sensible defaults.
 *
 * Individual tests override only the methods they need to control.
 * @param overrides - Partial overrides for the dependency mock.
 */
function makeDeps(overrides: Partial<StrategyDependencies> = {}): StrategyDependencies {
  return {
    fetchText: vi.fn().mockResolvedValue('1.2.3'),
    fetchJson: vi.fn().mockResolvedValue({ sha256: 'deadbeef' }),
    downloadFile: vi.fn().mockImplementation((_url, destPath) => Promise.resolve(destPath)),
    exec: vi.fn().mockResolvedValue(''),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    computeChecksum: vi.fn().mockResolvedValue('deadbeef'),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Build dependencies backed by real temp-file operations for cleanup tests.
 *
 * Network-facing operations remain deterministic fixtures; file creation,
 * extraction output, and archive deletion use the real filesystem so tests
 * assert observable disk state instead of only mock calls.
 * @param overrides - Partial overrides for specific test cases
 * @returns Strategy dependencies using real local file operations where relevant
 */
function makeFileBackedDeps(overrides: Partial<StrategyDependencies> = {}): StrategyDependencies {
  return makeDeps({
    downloadFile: vi.fn().mockImplementation(async (_url, destPath) => {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, 'archive');
      return destPath;
    }),
    extractArchive: vi.fn().mockImplementation(async (_archivePath, destDir) => {
      await fs.writeFile(path.join(destDir, 'extracted-client'), 'binary');
    }),
    deleteFile: vi.fn().mockImplementation(async (filePath) => {
      await fs.rm(filePath, { force: true });
    }),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// resolveLatestVersion
// ---------------------------------------------------------------------------

describe('ManifestBucketStrategy.resolveLatestVersion', () => {
  it('fetches the version index URL and trims whitespace', async () => {
    const deps = makeDeps({ fetchText: vi.fn().mockResolvedValue('  1.2.3\n') });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    const version = await strategy.resolveLatestVersion();

    expect(version).toBe('1.2.3');
    expect(deps.fetchText).toHaveBeenCalledOnce();
    expect(deps.fetchText).toHaveBeenCalledWith('https://storage.example.com/client/latest.txt');
  });

  it('propagates fetch errors', async () => {
    const deps = makeDeps({
      fetchText: vi.fn().mockRejectedValue(new Error('network failure')),
    });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.resolveLatestVersion()).rejects.toThrow('network failure');
  });

  it('throws when the version index returns an empty string', async () => {
    const deps = makeDeps({ fetchText: vi.fn().mockResolvedValue('') });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.resolveLatestVersion()).rejects.toThrow(/returned an empty version/);
  });

  it('throws when the version index returns only whitespace', async () => {
    const deps = makeDeps({ fetchText: vi.fn().mockResolvedValue('   \n  ') });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.resolveLatestVersion()).rejects.toThrow(/returned an empty version/);
  });
});

// ---------------------------------------------------------------------------
// execute — happy path
// ---------------------------------------------------------------------------

describe('ManifestBucketStrategy.execute (happy path)', () => {
  let deps: StrategyDependencies;
  let strategy: ManifestBucketStrategy;
  const onProgress = vi.fn<StrategyProgressCallback>();

  beforeEach(() => {
    deps = makeDeps();
    strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);
    onProgress.mockClear();
  });

  it('returns an InstallArtifact with the correct strategy and version', async () => {
    const artifact = await strategy.execute('1.2.3', '/install/dir', onProgress);

    expect(artifact).toEqual({
      installPath: '/install/dir',
      version: '1.2.3',
      strategy: 'manifest-bucket',
    });
  });

  it('fetches the manifest at the versioned URL', async () => {
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    expect(deps.fetchJson).toHaveBeenCalledWith('https://storage.example.com/client/1.2.3/manifest.json');
  });

  it('downloads the binary at the versioned URL', async () => {
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    expect(deps.downloadFile).toHaveBeenCalledWith(
      'https://storage.example.com/client/1.2.3/client-linux-x64.tar.gz',
      '/install/dir/client-linux-x64.tar.gz',
      expect.any(Function),
    );
  });

  it('computes the checksum of the downloaded archive', async () => {
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    expect(deps.computeChecksum).toHaveBeenCalledWith('/install/dir/client-linux-x64.tar.gz');
  });

  it('extracts the archive when archiveFormat is tar.gz', async () => {
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    expect(deps.extractArchive).toHaveBeenCalledWith('/install/dir/client-linux-x64.tar.gz', '/install/dir', 'tar.gz');
  });

  it('deletes the downloaded archive after extraction', async () => {
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    expect(deps.deleteFile).toHaveBeenCalledWith('/install/dir/client-linux-x64.tar.gz');
  });

  it('succeeds even when deleteFile rejects after extraction', async () => {
    const failDeps = makeDeps({
      deleteFile: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    const failStrategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, failDeps);

    const artifact = await failStrategy.execute('1.2.3', '/install/dir');

    expect(artifact.installPath).toBe('/install/dir');
    expect(artifact.version).toBe('1.2.3');
    expect(failDeps.extractArchive).toHaveBeenCalledOnce();
  });

  it('emits progress callbacks through the pipeline stages', async () => {
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    const stages = onProgress.mock.calls.map(([stage]) => stage);
    expect(stages).toContain('resolving');
    expect(stages).toContain('downloading');
    expect(stages).toContain('verifying');
    expect(stages).toContain('extracting');
    expect(stages).toContain('installing');
  });
});

// ---------------------------------------------------------------------------
// execute — raw format (no extraction)
// ---------------------------------------------------------------------------

describe('ManifestBucketStrategy.execute (raw format)', () => {
  it('skips archive extraction when archiveFormat is raw', async () => {
    const rawDescriptor: ManifestBucketInstallDescriptor = {
      ...BASE_DESCRIPTOR,
      config: { ...BASE_DESCRIPTOR.config, archiveFormat: 'raw' },
    };
    const deps = makeDeps();
    const strategy = new ManifestBucketStrategy(rawDescriptor, deps);

    await strategy.execute('1.0.0', '/install/dir');

    expect(deps.extractArchive).not.toHaveBeenCalled();
    expect(deps.deleteFile).not.toHaveBeenCalled();
  });

  it('skips archive extraction when archiveFormat is absent', async () => {
    const noFormatDescriptor: ManifestBucketInstallDescriptor = {
      ...BASE_DESCRIPTOR,
      config: { ...BASE_DESCRIPTOR.config, archiveFormat: undefined },
    };
    const deps = makeDeps();
    const strategy = new ManifestBucketStrategy(noFormatDescriptor, deps);

    await strategy.execute('1.0.0', '/install/dir');

    expect(deps.extractArchive).not.toHaveBeenCalled();
    expect(deps.deleteFile).not.toHaveBeenCalled();
  });

  it('keeps the downloaded file on disk for raw/no-format installs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-manifest-raw-'));
    const rawDescriptor: ManifestBucketInstallDescriptor = {
      ...BASE_DESCRIPTOR,
      config: { ...BASE_DESCRIPTOR.config, archiveFormat: undefined },
    };
    const deps = makeFileBackedDeps();
    const strategy = new ManifestBucketStrategy(rawDescriptor, deps);

    try {
      await strategy.execute('1.0.0', tmpDir);

      await expect(fs.readFile(path.join(tmpDir, 'client-linux-x64.tar.gz'), 'utf-8')).resolves.toBe('archive');
      expect(deps.deleteFile).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('ManifestBucketStrategy.execute (archive cleanup with real files)', () => {
  it('removes the downloaded archive from disk after extracting it', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-manifest-extract-'));
    const deps = makeFileBackedDeps();
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    try {
      await strategy.execute('1.2.3', tmpDir);

      await expect(fs.stat(path.join(tmpDir, 'client-linux-x64.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(tmpDir, 'extracted-client'), 'utf-8')).resolves.toBe('binary');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// execute — checksum mismatch
// ---------------------------------------------------------------------------

describe('ManifestBucketStrategy.execute (checksum verification)', () => {
  it('throws when the computed checksum does not match the manifest', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({ sha256: 'expected-hash' }),
      computeChecksum: vi.fn().mockResolvedValue('actual-hash'),
    });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.execute('1.2.3', '/install/dir')).rejects.toThrow(/Checksum mismatch/);
  });

  it('does not extract when checksum fails', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({ sha256: 'expected-hash' }),
      computeChecksum: vi.fn().mockResolvedValue('wrong-hash'),
    });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.execute('1.2.3', '/install/dir')).rejects.toThrow();
    expect(deps.extractArchive).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// execute — manifest shape errors
// ---------------------------------------------------------------------------

describe('ManifestBucketStrategy.execute (manifest validation)', () => {
  it('throws when the manifest is not a JSON object', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(['not', 'an', 'object']),
    });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.execute('1.2.3', '/install/dir')).rejects.toThrow(/must be a JSON object/);
  });

  it('throws when the manifest checksum field is missing', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({ other_field: 'value' }),
    });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.execute('1.2.3', '/install/dir')).rejects.toThrow(
      /missing a non-empty string field "sha256"/,
    );
  });

  it('throws when the manifest checksum field is an empty string', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({ sha256: '' }),
    });
    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);

    await expect(strategy.execute('1.2.3', '/install/dir')).rejects.toThrow(
      /missing a non-empty string field "sha256"/,
    );
  });
});

// ---------------------------------------------------------------------------
// execute — download progress forwarding
// ---------------------------------------------------------------------------

describe('ManifestBucketStrategy.execute (download progress)', () => {
  it('forwards fractional progress when Content-Length is known', async () => {
    const onProgress = vi.fn<StrategyProgressCallback>();

    // The callback fires synchronously inside the downloadFile mock so that
    // the progress tick happens before downloadFile resolves its promise.
    const deps = makeDeps({
      downloadFile: vi
        .fn()
        .mockImplementation(
          (_url: string, destPath: string, cb?: (downloaded: number, total: number | null) => void) => {
            cb?.(512, 1024);
            return Promise.resolve(destPath);
          },
        ),
    });

    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    const downloadingCalls = onProgress.mock.calls.filter(([stage]) => stage === 'downloading');
    const progressValues = downloadingCalls.map(([, progress]) => progress);
    expect(progressValues).toContain(50);
  });

  it('passes null progress when Content-Length is unknown', async () => {
    const onProgress = vi.fn<StrategyProgressCallback>();

    const deps = makeDeps({
      downloadFile: vi
        .fn()
        .mockImplementation(
          (_url: string, destPath: string, cb?: (downloaded: number, total: number | null) => void) => {
            cb?.(1024, null);
            return Promise.resolve(destPath);
          },
        ),
    });

    const strategy = new ManifestBucketStrategy(BASE_DESCRIPTOR, deps);
    await strategy.execute('1.2.3', '/install/dir', onProgress);

    const downloadingCalls = onProgress.mock.calls.filter(([stage]) => stage === 'downloading');
    expect(downloadingCalls.some(([, progress]) => progress === null)).toBe(true);
  });
});
