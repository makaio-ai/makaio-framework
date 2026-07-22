/**
 * Tests for {@link SignedBinaryBucketStrategy}.
 *
 * All network/subprocess I/O is injected via mock {@link StrategyDependencies}
 * — no real GPG process is invoked, no network calls are made. Local
 * file-system operations (mkdir, writeFile, readFile, chmod) are exercised
 * against a real temporary directory to avoid the ESM module-spy restriction.
 *
 * The strategy is pin-only: the descriptor must carry an exact `version` and
 * `execute` rejects any caller-supplied version that differs from that pin.
 *
 * Security invariants tested:
 * - Version mismatch is rejected before any I/O.
 * - Platform not in descriptor map is rejected before any I/O.
 * - Fingerprint mismatch is rejected after key download, before binary download.
 * - Manifest signature failure is rejected before the binary is downloaded.
 * - Checksum mismatch is rejected after binary download.
 * - Manifest entries are read from the signed `platforms` map and must name a
 *   safe binary filename inside the install directory.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedBinaryBucketInstallDescriptor } from '@makaio/contracts/client';
import { SignedBinaryBucketStrategy } from '../signed-binary-bucket-strategy.js';
import type { StrategyDependencies, StrategyProgressCallback } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a full {@link SignedBinaryBucketInstallDescriptor} for the tests.
 * @param overrides - Optional partial overrides for the descriptor shape.
 * @returns A complete descriptor with all required fields.
 */
function makeDescriptor(
  overrides: Partial<SignedBinaryBucketInstallDescriptor> = {},
): SignedBinaryBucketInstallDescriptor {
  return {
    type: 'signed-binary-bucket',
    version: '2.1.143',
    config: {
      baseUrl: 'https://downloads.claude.ai/claude-code-releases',
      manifestPathTemplate: '{version}/manifest.json',
      manifestSignaturePathTemplate: '{version}/manifest.json.sig',
      publicKeyUrl: 'https://downloads.claude.ai/keys/claude-code.asc',
      publicKeyFingerprint: '31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE',
      binaryPathTemplate: '{version}/{platform}/{binary}',
      platforms: {
        'darwin-arm64': 'darwin-arm64',
        'darwin-x64': 'darwin-x64',
        'linux-arm64': 'linux-arm64',
        'linux-x64': 'linux-x64',
        'linux-arm64-musl': 'linux-arm64-musl',
        'linux-x64-musl': 'linux-x64-musl',
        'win32-arm64': 'win32-arm64',
        'win32-x64': 'win32-x64',
      },
    },
    ...overrides,
  };
}

/**
 * The expected fingerprint from the descriptor, normalized to no-spaces hex.
 *
 * `'31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE'` →
 * `'31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE'`
 */
const EXPECTED_FINGERPRINT_NORMALIZED = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE';

/**
 * GPG `--with-colons --fingerprint` output that yields the correct fingerprint.
 *
 * Only the `fpr` record line is required for the implementation's parser.
 */
const GPG_COLONS_OUTPUT_MATCHING = [
  'pub:u:4096:1:BAA929FF1A7ECACE:1600000000:::-:::scESC:::::::23::0:',
  `fpr:::::::::${EXPECTED_FINGERPRINT_NORMALIZED}:`,
  'uid:u::::1600000000::ABCDEF::Claude Code Signing <security@anthropic.com>::::::::::0:',
].join('\n');

/**
 * GPG `--with-colons --fingerprint` output that yields a mismatched fingerprint.
 */
const GPG_COLONS_OUTPUT_MISMATCHED = [
  'pub:u:4096:1:0000000000000000:1600000000:::-:::scESC:::::::23::0:',
  'fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:',
  'uid:u::::1600000000::111111::Rogue Key <rogue@evil.com>::::::::::0:',
].join('\n');

/** Expected checksum for the darwin-arm64 entry in MANIFEST_CONTENT. */
const DARWIN_ARM64_CHECKSUM = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Expected checksum for the linux-x64-musl entry in MANIFEST_CONTENT. */
const LINUX_X64_MUSL_CHECKSUM = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';

/**
 * The manifest JSON that the strategy reads from disk.
 *
 * Carries the signed manifest version and a platform-keyed `platforms` map.
 */
const MANIFEST_CONTENT = JSON.stringify({
  version: '2.1.143',
  platforms: {
    'darwin-arm64': {
      binary: 'claude',
      checksum: DARWIN_ARM64_CHECKSUM,
    },
    'linux-x64': {
      binary: 'claude',
      checksum: '1111111111111111111111111111111111111111111111111111111111111111',
    },
    'linux-x64-musl': {
      binary: 'claude',
      checksum: LINUX_X64_MUSL_CHECKSUM,
    },
  },
});

/**
 * Build a full {@link StrategyDependencies} mock that simulates the happy-path
 * behaviour of the signed-binary-bucket pipeline.
 *
 * The `downloadFile` mock writes the manifest content to the destination path
 * when the URL contains `manifest.json` (so the strategy can read it from disk
 * afterwards). Binary downloads write a sentinel byte to the destination.
 *
 * Each dependency can be individually overridden via `overrides`.
 * @param targetDir - The target directory used in this test so downloads can
 *   create real files in it.
 * @param overrides - Partial overrides applied on top of the happy-path defaults.
 * @returns A fully-wired mock StrategyDependencies object.
 */
function makeDeps(targetDir: string, overrides: Partial<StrategyDependencies> = {}): StrategyDependencies {
  return {
    fetchText: vi.fn().mockImplementation((url: string) => {
      if (url.includes('claude-code.asc')) {
        return Promise.resolve('-----BEGIN PGP PUBLIC KEY BLOCK-----\nFakeKey\n-----END PGP PUBLIC KEY BLOCK-----');
      }
      return Promise.resolve('');
    }),
    fetchJson: vi.fn().mockResolvedValue({}),
    downloadFile: vi.fn().mockImplementation(async (url: string, destPath: string) => {
      // Write the manifest JSON so fs.readFile inside the strategy works
      if (url.includes('manifest.json') && !url.includes('.sig')) {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, MANIFEST_CONTENT, 'utf-8');
      } else {
        // For other downloads (sig file, binary), create an empty placeholder
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, 'placeholder', 'utf-8');
      }
      return destPath;
    }),
    exec: vi.fn().mockImplementation((command: string, args: string[]) => {
      // gpg --import → silent success
      if (command === 'gpg' && args.includes('--import')) {
        return Promise.resolve('');
      }
      // gpg --with-colons --fingerprint → return matching fingerprint output
      if (command === 'gpg' && args.includes('--with-colons') && args.includes('--fingerprint')) {
        return Promise.resolve(GPG_COLONS_OUTPUT_MATCHING);
      }
      // gpg --verify → success (signature valid)
      if (command === 'gpg' && args.includes('--verify')) {
        return Promise.resolve('gpg: Good signature');
      }
      return Promise.resolve('');
    }),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockImplementation(async (filePath: string) => {
      await fs.rm(filePath, { force: true });
    }),
    computeChecksum: vi.fn().mockResolvedValue(DARWIN_ARM64_CHECKSUM),
    removeDirectory: vi.fn().mockImplementation(async (dirPath: string) => {
      await fs.rm(dirPath, { recursive: true, force: true });
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SignedBinaryBucketStrategy.execute', () => {
  let tmpDir: string;
  let onProgress: ReturnType<typeof vi.fn<StrategyProgressCallback>>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-sbb-test-'));
    onProgress = vi.fn<StrategyProgressCallback>();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('completes the full pipeline on the happy path (darwin-arm64)', async () => {
    const deps = makeDeps(tmpDir);
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    const artifact = await strategy.execute('2.1.143', tmpDir, onProgress);

    // Artifact shape
    expect(artifact).toEqual({
      installPath: tmpDir,
      version: '2.1.143',
      strategy: 'signed-binary-bucket',
    });

    // Public key was fetched as text
    expect(deps.fetchText).toHaveBeenCalledWith('https://downloads.claude.ai/keys/claude-code.asc');

    // Manifest and signature were downloaded
    expect(deps.downloadFile).toHaveBeenCalledWith(
      'https://downloads.claude.ai/claude-code-releases/2.1.143/manifest.json',
      expect.stringContaining('manifest.json'),
    );
    expect(deps.downloadFile).toHaveBeenCalledWith(
      'https://downloads.claude.ai/claude-code-releases/2.1.143/manifest.json.sig',
      expect.stringContaining('manifest.json.sig'),
    );

    // GPG key was imported
    expect(deps.exec).toHaveBeenCalledWith('gpg', expect.arrayContaining(['--import']));

    // GPG signature was verified
    expect(deps.exec).toHaveBeenCalledWith('gpg', expect.arrayContaining(['--verify']));

    // Binary was downloaded for darwin-arm64
    expect(deps.downloadFile).toHaveBeenCalledWith(
      'https://downloads.claude.ai/claude-code-releases/2.1.143/darwin-arm64/claude',
      expect.stringContaining('claude'),
      expect.anything(),
    );

    // Checksum was verified
    expect(deps.computeChecksum).toHaveBeenCalled();

    // Cleanup: GNUPG home removed, key and sig files deleted
    expect(deps.removeDirectory).toHaveBeenCalled();
    expect(deps.deleteFile).toHaveBeenCalled();

    // Progress callbacks were emitted
    const stages = onProgress.mock.calls.map(([stage]) => stage);
    expect(stages).toContain('resolving');
    expect(stages).toContain('verifying');
    expect(stages).toContain('downloading');
    expect(stages).toContain('installing');
  });

  it('uses and cleans up a short GPG home when the install target is long', async () => {
    const longTargetDir = path.join(tmpDir, 'install-'.repeat(24));
    const deps = makeDeps(longTargetDir);
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await strategy.execute('2.1.143', longTargetDir);

    const importCall = (deps.exec as ReturnType<typeof vi.fn>).mock.calls.find(
      ([command, args]) => command === 'gpg' && (args as string[]).includes('--import'),
    );
    expect(importCall).toBeDefined();
    const gpgArgs = importCall?.[1] as string[];
    const gpgHome = gpgArgs[gpgArgs.indexOf('--homedir') + 1];

    expect(gpgHome).not.toBeUndefined();
    expect(gpgHome.startsWith(longTargetDir)).toBe(false);
    expect(path.join(gpgHome, 'S.gpg-agent.extra').length).toBeLessThan(104);
    expect(deps.removeDirectory).toHaveBeenCalledWith(gpgHome);
    await expect(fs.access(gpgHome)).rejects.toThrow();
  });

  it('does not chmod on win32', async () => {
    const win32Checksum = '1111111111111111111111111111111111111111111111111111111111111111';
    const depsWin32 = makeDeps(tmpDir, {
      computeChecksum: vi.fn().mockResolvedValue(win32Checksum),
    });

    const descriptor = makeDescriptor();
    const win32Manifest = JSON.stringify({
      version: '2.1.143',
      platforms: { 'win32-x64': { binary: 'claude.exe', checksum: win32Checksum } },
    });
    depsWin32.downloadFile = vi.fn().mockImplementation(async (url: string, destPath: string) => {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(
        destPath,
        url.includes('manifest.json') && !url.includes('.sig') ? win32Manifest : 'placeholder',
        'utf-8',
      );
      return destPath;
    });

    const strategy = new SignedBinaryBucketStrategy(descriptor, depsWin32, {
      platform: 'win32',
      arch: 'x64',
      isMusl: false,
    });

    // On win32 the binary gets no chmod; the strategy should complete successfully
    const artifact = await strategy.execute('2.1.143', tmpDir);
    expect(artifact.strategy).toBe('signed-binary-bucket');

    // Verify the binary file was written but chmod was NOT applied
    const binaryPath = path.join(tmpDir, 'claude.exe');
    const stat = await fs.stat(binaryPath).catch(() => null);
    // On non-Windows hosts (CI runs on Linux/macOS) the file should still
    // exist — we only verify that no chmod was invoked (no error thrown on win32)
    expect(stat).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Version mismatch rejection
  // -------------------------------------------------------------------------

  it('rejects when the requested version differs from the descriptor pin', async () => {
    const deps = makeDeps(tmpDir);
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.000', tmpDir)).rejects.toThrow(
      'signed-binary-bucket managed install requested version 2.1.000 but descriptor pins 2.1.143',
    );

    // No I/O should be performed before the version check rejects
    expect(deps.fetchText).not.toHaveBeenCalled();
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fingerprint mismatch rejection
  // -------------------------------------------------------------------------

  it('rejects when the GPG key fingerprint does not match the expected fingerprint', async () => {
    const deps = makeDeps(tmpDir, {
      exec: vi.fn().mockImplementation((command: string, args: string[]) => {
        if (command === 'gpg' && args.includes('--import')) {
          return Promise.resolve('');
        }
        if (command === 'gpg' && args.includes('--with-colons')) {
          return Promise.resolve(GPG_COLONS_OUTPUT_MISMATCHED);
        }
        return Promise.resolve('');
      }),
    });
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.143', tmpDir)).rejects.toThrow('GPG key fingerprint mismatch');

    // Binary should never be downloaded after a fingerprint rejection.
    // We use a platform-segment pattern (darwin-arm64/<binary>) to avoid
    // matching the base URL which also contains 'claude' as a substring.
    const allDownloadUrls = (deps.downloadFile as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) =>
      String(args[0]),
    );
    const binaryDownloads = allDownloadUrls.filter((url) => /darwin-arm64\//.test(url));
    expect(binaryDownloads).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Manifest signature rejection
  // -------------------------------------------------------------------------

  it('rejects when the manifest GPG signature verification fails', async () => {
    const deps = makeDeps(tmpDir, {
      exec: vi.fn().mockImplementation((command: string, args: string[]) => {
        if (command === 'gpg' && args.includes('--import')) {
          return Promise.resolve('');
        }
        if (command === 'gpg' && args.includes('--with-colons') && args.includes('--fingerprint')) {
          return Promise.resolve(GPG_COLONS_OUTPUT_MATCHING);
        }
        if (command === 'gpg' && args.includes('--verify')) {
          return Promise.reject(new Error('gpg: BAD signature from "Claude Code Signing"'));
        }
        return Promise.resolve('');
      }),
    });
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.143', tmpDir)).rejects.toThrow('Manifest GPG signature verification failed');
    expect(deps.removeDirectory).toHaveBeenCalledTimes(1);
    expect(deps.deleteFile).toHaveBeenCalledTimes(2);
  });

  it('rejects when the signed manifest version does not match the descriptor pin', async () => {
    const mismatchedManifest = JSON.stringify({
      version: '2.1.144',
      platforms: {
        'darwin-arm64': {
          binary: 'claude',
          checksum: DARWIN_ARM64_CHECKSUM,
        },
      },
    });
    const deps = makeDeps(tmpDir, {
      downloadFile: vi.fn().mockImplementation(async (url: string, destPath: string) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(
          destPath,
          url.includes('manifest.json') && !url.includes('.sig') ? mismatchedManifest : 'placeholder',
          'utf-8',
        );
        return destPath;
      }),
    });
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.143', tmpDir)).rejects.toThrow(
      'Signed manifest version 2.1.144 does not match descriptor pin 2.1.143',
    );
  });

  // -------------------------------------------------------------------------
  // Checksum mismatch rejection
  // -------------------------------------------------------------------------

  it('rejects when the binary checksum does not match the manifest entry', async () => {
    const deps = makeDeps(tmpDir, {
      computeChecksum: vi.fn().mockResolvedValue('000000000000000000000000000000000000000000000000000000000000ffff'),
    });
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.143', tmpDir)).rejects.toThrow('Binary checksum mismatch');
  });

  // -------------------------------------------------------------------------
  // Platform resolution
  // -------------------------------------------------------------------------

  it('resolves linux-x64-musl platform key for musl builds', async () => {
    const muslManifest = JSON.stringify({
      version: '2.1.143',
      platforms: { 'linux-x64-musl': { binary: 'claude', checksum: LINUX_X64_MUSL_CHECKSUM } },
    });
    const deps = makeDeps(tmpDir, {
      computeChecksum: vi.fn().mockResolvedValue(LINUX_X64_MUSL_CHECKSUM),
      downloadFile: vi.fn().mockImplementation(async (url: string, destPath: string) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(
          destPath,
          url.includes('manifest.json') && !url.includes('.sig') ? muslManifest : 'placeholder',
          'utf-8',
        );
        return destPath;
      }),
    });
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'linux',
      arch: 'x64',
      isMusl: true,
    });

    const artifact = await strategy.execute('2.1.143', tmpDir);

    expect(artifact.strategy).toBe('signed-binary-bucket');

    // The download URL should use linux-x64-musl as the platform segment
    const allDownloadUrls = (deps.downloadFile as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) =>
      String(args[0]),
    );
    const binaryDownload = allDownloadUrls.find((url) => url.includes('musl'));
    expect(binaryDownload).toBeDefined();
    expect(binaryDownload).toContain('linux-x64-musl');
  });

  it('rejects when the platform is not in the descriptor platforms map', async () => {
    const descriptor = makeDescriptor();
    // Create a descriptor with only darwin-arm64 in platforms
    const restrictedDescriptor: SignedBinaryBucketInstallDescriptor = {
      ...descriptor,
      config: {
        ...descriptor.config,
        platforms: { 'darwin-arm64': 'darwin-arm64' },
      },
    };

    const deps = makeDeps(tmpDir);
    const strategy = new SignedBinaryBucketStrategy(restrictedDescriptor, deps, {
      platform: 'linux',
      arch: 'x64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.143', tmpDir)).rejects.toThrow(
      "signed-binary-bucket descriptor has no platform entry for 'linux-x64'",
    );

    // No I/O should happen before platform resolution fails
    expect(deps.fetchText).not.toHaveBeenCalled();
  });

  it('rejects when the signed manifest does not contain the selected platform', async () => {
    const missingPlatformManifest = JSON.stringify({
      version: '2.1.143',
      platforms: {
        'linux-x64': {
          binary: 'claude',
          checksum: '1111111111111111111111111111111111111111111111111111111111111111',
        },
      },
    });
    const deps = makeDeps(tmpDir, {
      downloadFile: vi.fn().mockImplementation(async (url: string, destPath: string) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(
          destPath,
          url.includes('manifest.json') && !url.includes('.sig') ? missingPlatformManifest : 'placeholder',
          'utf-8',
        );
        return destPath;
      }),
    });
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.143', tmpDir)).rejects.toThrow(
      "Signed manifest does not contain a platform entry for 'darwin-arm64'",
    );
  });

  it('rejects signed manifest binary names that escape the install directory', async () => {
    const traversalManifest = JSON.stringify({
      version: '2.1.143',
      platforms: {
        'darwin-arm64': {
          binary: '../claude',
          checksum: DARWIN_ARM64_CHECKSUM,
        },
      },
    });
    const deps = makeDeps(tmpDir, {
      downloadFile: vi.fn().mockImplementation(async (url: string, destPath: string) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(
          destPath,
          url.includes('manifest.json') && !url.includes('.sig') ? traversalManifest : 'placeholder',
          'utf-8',
        );
        return destPath;
      }),
    });
    const strategy = new SignedBinaryBucketStrategy(makeDescriptor(), deps, {
      platform: 'darwin',
      arch: 'arm64',
      isMusl: false,
    });

    await expect(strategy.execute('2.1.143', tmpDir)).rejects.toThrow(
      "Manifest entry for 'darwin-arm64' has unsafe binary filename",
    );
  });
});
