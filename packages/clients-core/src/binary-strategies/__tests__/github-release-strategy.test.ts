/**
 * Tests for {@link GithubReleaseStrategy}.
 *
 * All network-facing I/O is injected via mock {@link StrategyDependencies}.
 * File-backed cleanup tests use temp directories to assert observable disk
 * state while keeping HTTP deterministic.
 *
 * Platform-dependent behaviour (`process.platform` / `process.arch`) is tested
 * by constructing descriptors whose `assetPattern` maps cover the actual test
 * host platform, plus negative-path tests using a deliberately unmapped key.
 *
 * Strategy tests verify behavior through injected StrategyDependencies —
 * the I/O seam is the boundary. Integration tests with real HTTP belong
 * in a separate test layer.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubReleaseInstallDescriptor } from '@makaio/contracts/client';
import { GithubReleaseStrategy } from '../github-release-strategy.js';
import type { StrategyDependencies, StrategyProgressCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The platform key the strategy will compute at runtime. */
const PLATFORM_KEY = `${process.platform}-${process.arch}`;

/**
 * A dummy GitHub release API response with matching and non-matching assets.
 * @param tagName - The git tag name for the release (e.g. `'v1.0.0'`).
 * @param assetNames - List of asset file names to include in the response.
 */
function makeReleaseResponse(tagName: string, assetNames: string[]) {
  return {
    tag_name: tagName,
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `https://github.example.com/releases/download/${tagName}/${name}`,
    })),
  };
}

/**
 * Build a full {@link StrategyDependencies} mock with sensible defaults.
 * @param overrides - Partial overrides.
 */
function makeDeps(overrides: Partial<StrategyDependencies> = {}): StrategyDependencies {
  const latestRelease = makeReleaseResponse('v2.0.0', [`client-${PLATFORM_KEY}.tar.gz`]);
  const taggedRelease = makeReleaseResponse('v1.5.0', [`client-${PLATFORM_KEY}.tar.gz`]);

  return {
    fetchText: vi.fn().mockResolvedValue(''),
    fetchJson: vi
      .fn()
      .mockImplementation((url: string) => Promise.resolve(url.endsWith('/latest') ? latestRelease : taggedRelease)),
    downloadFile: vi.fn().mockImplementation((_url, destPath) => Promise.resolve(destPath)),
    exec: vi.fn().mockResolvedValue(''),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    computeChecksum: vi.fn().mockResolvedValue(''),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Build dependencies backed by real temp-file operations for cleanup tests.
 *
 * GitHub API and download URLs remain deterministic fixtures; archive creation,
 * extraction output, and archive deletion use the real filesystem so cleanup
 * coverage asserts disk state instead of only mock calls.
 * @param overrides - Partial overrides for specific test cases.
 * @returns Strategy dependencies using real local file operations where relevant.
 */
function makeFileBackedDeps(overrides: Partial<StrategyDependencies> = {}): StrategyDependencies {
  return makeDeps({
    downloadFile: vi.fn().mockImplementation(async (_url, destPath) => {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, 'archive');
      return destPath;
    }),
    extractArchive: vi.fn().mockImplementation(async (archivePath, destDir) => {
      const archive = await fs.readFile(archivePath, 'utf-8');
      await fs.writeFile(path.join(destDir, 'extracted-client'), `binary:${archive}`);
    }),
    deleteFile: vi.fn().mockImplementation(async (filePath) => {
      await fs.rm(filePath, { force: true });
    }),
    ...overrides,
  });
}

/**
 * Minimal descriptor that maps the current host platform.
 * @param overrides - Partial overrides merged onto the default descriptor.
 */
function makeDescriptor(overrides: Partial<GithubReleaseInstallDescriptor> = {}): GithubReleaseInstallDescriptor {
  return {
    type: 'github-release',
    repo: 'acme/my-tool',
    assetPattern: { [PLATFORM_KEY]: `client-${PLATFORM_KEY}` },
    archiveFormat: 'tar.gz',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveLatestVersion
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.resolveLatestVersion', () => {
  it('fetches the latest release endpoint and returns tag_name', async () => {
    const deps = makeDeps();
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    const version = await strategy.resolveLatestVersion();

    expect(version).toBe('v2.0.0');
    expect(deps.fetchJson).toHaveBeenCalledWith('https://api.github.com/repos/acme/my-tool/releases/latest');
  });

  it('propagates fetch errors', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockRejectedValue(new Error('rate limited')),
    });
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await expect(strategy.resolveLatestVersion()).rejects.toThrow('rate limited');
  });

  it('throws when the API response is not a release object', async () => {
    const deps = makeDeps({ fetchJson: vi.fn().mockResolvedValue(null) });
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await expect(strategy.resolveLatestVersion()).rejects.toThrow(/must be a JSON object/);
  });
});

// ---------------------------------------------------------------------------
// execute — asset selection
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.execute (asset selection)', () => {
  let deps: StrategyDependencies;
  let onProgress: StrategyProgressCallback;

  beforeEach(() => {
    deps = makeDeps();
    onProgress = vi.fn();
  });

  it('selects the asset whose name contains the platform pattern', async () => {
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);
    const artifact = await strategy.execute('v1.5.0', '/install/dir', onProgress);

    expect(artifact.installPath).toBe('/install/dir');
    expect(artifact.version).toBe('v1.5.0');
    expect(artifact.strategy).toBe('github-release');

    expect(deps.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining(`client-${PLATFORM_KEY}`),
      expect.stringContaining(`client-${PLATFORM_KEY}`),
      expect.any(Function),
    );
  });

  it('throws when no asset matches the platform pattern', async () => {
    const descriptor = makeDescriptor({
      assetPattern: { [PLATFORM_KEY]: 'nonexistent-pattern-xyz' },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(
      /No release asset matching "nonexistent-pattern-xyz"/,
    );
  });

  it('throws when there is no pattern for the current platform', async () => {
    const descriptor = makeDescriptor({
      assetPattern: { 'fakeos-fakearch': 'client-fakeos-fakearch.tar.gz' },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(
      new RegExp(`No asset pattern for platform key "${PLATFORM_KEY}"`),
    );
  });

  it('uses the releases/tags/{version} endpoint for the given version', async () => {
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);
    await strategy.execute('v1.5.0', '/install/dir', onProgress);

    expect(deps.fetchJson).toHaveBeenCalledWith('https://api.github.com/repos/acme/my-tool/releases/tags/v1.5.0');
  });
});

// ---------------------------------------------------------------------------
// execute — extraction
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.execute (extraction)', () => {
  it('extracts the archive using the descriptor archiveFormat', async () => {
    const deps = makeDeps();
    const strategy = new GithubReleaseStrategy(makeDescriptor({ archiveFormat: 'tar.gz' }), deps);

    await strategy.execute('v1.5.0', '/install/dir');

    expect(deps.extractArchive).toHaveBeenCalledWith(
      expect.stringContaining(`client-${PLATFORM_KEY}`),
      '/install/dir',
      'tar.gz',
    );
  });

  it('deletes the downloaded archive after extraction', async () => {
    const deps = makeDeps();
    const strategy = new GithubReleaseStrategy(makeDescriptor({ archiveFormat: 'tar.gz' }), deps);

    await strategy.execute('v1.5.0', '/install/dir');

    expect(deps.deleteFile).toHaveBeenCalledWith(expect.stringContaining(`client-${PLATFORM_KEY}`));
  });

  it('succeeds even when deleteFile rejects after extraction', async () => {
    const deps = makeDeps({
      deleteFile: vi.fn().mockRejectedValue(new Error('permission denied')),
    });
    const strategy = new GithubReleaseStrategy(makeDescriptor({ archiveFormat: 'tar.gz' }), deps);

    const artifact = await strategy.execute('v1.5.0', '/install/dir');

    expect(artifact.installPath).toBe('/install/dir');
    expect(artifact.version).toBe('v1.5.0');
    expect(deps.extractArchive).toHaveBeenCalledOnce();
  });

  it('extracts zip archives when archiveFormat is zip', async () => {
    const assetName = `client-${PLATFORM_KEY}.zip`;
    const release = makeReleaseResponse('v1.5.0', [assetName]);
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    const descriptor = makeDescriptor({ archiveFormat: 'zip' });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await strategy.execute('v1.5.0', '/install/dir');

    expect(deps.extractArchive).toHaveBeenCalledWith(expect.stringContaining(assetName), '/install/dir', 'zip');
  });
});

describe('GithubReleaseStrategy.execute (archive cleanup with real files)', () => {
  it('removes the downloaded archive from disk after extracting it', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-github-release-extract-'));
    const deps = makeFileBackedDeps();
    const strategy = new GithubReleaseStrategy(makeDescriptor({ archiveFormat: 'tar.gz' }), deps);
    const archivePath = path.join(tmpDir, `client-${PLATFORM_KEY}.tar.gz`);

    try {
      await strategy.execute('v1.5.0', tmpDir);

      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(tmpDir, 'extracted-client'), 'utf-8')).resolves.toBe('binary:archive');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// execute — progress callbacks
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.execute (progress callbacks)', () => {
  it('emits resolving, downloading, extracting, and installing stages', async () => {
    const deps = makeDeps();
    const onProgress = vi.fn<StrategyProgressCallback>();
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await strategy.execute('v1.5.0', '/install/dir', onProgress);

    const stages = onProgress.mock.calls.map(([stage]) => stage);
    expect(stages).toContain('resolving');
    expect(stages).toContain('downloading');
    expect(stages).toContain('extracting');
    expect(stages).toContain('installing');
  });

  it('forwards fractional download progress when Content-Length is known', async () => {
    const onProgress = vi.fn<StrategyProgressCallback>();

    // Fire the progress callback synchronously inside the downloadFile mock so
    // the tick happens before the promise resolves.
    const deps = makeDeps({
      downloadFile: vi
        .fn()
        .mockImplementation(
          (_url: string, destPath: string, cb?: (downloaded: number, total: number | null) => void) => {
            cb?.(250, 1000);
            return Promise.resolve(destPath);
          },
        ),
    });

    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);
    await strategy.execute('v1.5.0', '/install/dir', onProgress);

    const downloadingCalls = onProgress.mock.calls.filter(([stage]) => stage === 'downloading');
    const progressValues = downloadingCalls.map(([, progress]) => progress);
    expect(progressValues).toContain(25);
  });
});

// ---------------------------------------------------------------------------
// execute — release API shape validation
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.execute (API shape validation)', () => {
  it('throws when the tagged release response is malformed', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue('not-an-object'),
    });
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(/must be a JSON object/);
  });

  it('throws when assets list is missing', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({ tag_name: 'v1.5.0' }),
    });
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(/Unexpected response from GitHub API/);
  });

  it('throws when the assets array contains a null entry', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: 'v1.5.0',
        assets: [null],
      }),
    });
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(
      /asset entr.*missing required "name" or "browser_download_url"/,
    );
  });

  it('throws when an asset entry is missing browser_download_url', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue({
        tag_name: 'v1.5.0',
        assets: [{ name: `client-${PLATFORM_KEY}.tar.gz` }],
      }),
    });
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(
      /asset entr.*missing required "name" or "browser_download_url"/,
    );
  });
});

// ---------------------------------------------------------------------------
// execute — ambiguous asset matching
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.execute (ambiguous asset matching)', () => {
  it('throws when multiple assets match the platform pattern', async () => {
    // Simulate a release that has the archive AND a sidecar (.sha256) that
    // both contain the pattern string — the strategy must reject this.
    const assetName = `client-${PLATFORM_KEY}.tar.gz`;
    const sidecarName = `client-${PLATFORM_KEY}.tar.gz.sha256`;
    const release = makeReleaseResponse('v1.5.0', [assetName, sidecarName]);
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    // The pattern matches both asset names.
    const descriptor = makeDescriptor({
      assetPattern: { [PLATFORM_KEY]: `client-${PLATFORM_KEY}` },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(/Ambiguous release asset pattern/);
  });

  it('includes the conflicting asset names in the ambiguity error', async () => {
    const assetName = `client-${PLATFORM_KEY}.tar.gz`;
    const sidecarName = `client-${PLATFORM_KEY}.tar.gz.sha256`;
    const release = makeReleaseResponse('v1.5.0', [assetName, sidecarName]);
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    const descriptor = makeDescriptor({
      assetPattern: { [PLATFORM_KEY]: `client-${PLATFORM_KEY}` },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(
      new RegExp(`${assetName}.*${sidecarName}|${sidecarName}.*${assetName}`),
    );
  });
});

// ---------------------------------------------------------------------------
// execute — path traversal sanitization (SEC-1)
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.execute (path traversal sanitization)', () => {
  it('strips directory components from asset.name when building the download destination', async () => {
    const traversalName = `../../etc/cron.d/evil-client-${PLATFORM_KEY}.tar.gz`;
    const release = makeReleaseResponse('v1.5.0', [traversalName]);
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    const descriptor = makeDescriptor({
      assetPattern: { [PLATFORM_KEY]: `client-${PLATFORM_KEY}` },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await strategy.execute('v1.5.0', '/install/dir');

    // The download destination must not escape targetDir — only the basename is used.
    expect(deps.downloadFile).toHaveBeenCalledOnce();
    const [, destPath] = (deps.downloadFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(destPath).toBe(`/install/dir/evil-client-${PLATFORM_KEY}.tar.gz`);
  });
});

// ---------------------------------------------------------------------------
// execute — asset shape validation (SEC-2)
// ---------------------------------------------------------------------------

describe('GithubReleaseStrategy.execute (asset shape validation)', () => {
  it('throws when the matched asset has an empty name', async () => {
    const release = {
      tag_name: 'v1.5.0',
      assets: [{ name: '', browser_download_url: 'https://example.com/download' }],
    };
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    const descriptor = makeDescriptor({
      assetPattern: { [PLATFORM_KEY]: '' },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(/invalid or missing "name"/);
  });

  it('throws when the matched asset has an empty browser_download_url', async () => {
    const assetName = `client-${PLATFORM_KEY}.tar.gz`;
    const release = {
      tag_name: 'v1.5.0',
      assets: [{ name: assetName, browser_download_url: '' }],
    };
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    const strategy = new GithubReleaseStrategy(makeDescriptor(), deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(
      /invalid or missing "browser_download_url"/,
    );
  });

  it('throws when the matched asset name has a basename of "."', async () => {
    const release = {
      tag_name: 'v1.5.0',
      assets: [{ name: '.', browser_download_url: 'https://example.com/download' }],
    };
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    const descriptor = makeDescriptor({
      // Empty pattern matches the "." asset name (contains empty string)
      assetPattern: { [PLATFORM_KEY]: '' },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(/path-traversal "name" field/);
  });

  it('throws when the matched asset name has a basename of ".."', async () => {
    const release = {
      tag_name: 'v1.5.0',
      assets: [{ name: '..', browser_download_url: 'https://example.com/download' }],
    };
    const deps = makeDeps({
      fetchJson: vi.fn().mockResolvedValue(release),
    });
    const descriptor = makeDescriptor({
      assetPattern: { [PLATFORM_KEY]: '' },
    });
    const strategy = new GithubReleaseStrategy(descriptor, deps);

    await expect(strategy.execute('v1.5.0', '/install/dir')).rejects.toThrow(/path-traversal "name" field/);
  });
});
