/**
 * Signed binary bucket install strategy.
 *
 * Downloads a pinned binary from a versioned static bucket, verifies the
 * per-version manifest is signed by the expected GPG key, verifies the binary
 * checksum, and writes the executable to the target directory.
 *
 * Security invariants:
 * - The requested version must exactly match the descriptor pin.
 * - The downloaded public key's fingerprint must match the declared fingerprint.
 * - The manifest signature must pass GPG verification with the imported key.
 * - The binary checksum must match the manifest entry for the current platform.
 *
 * No upstream latest-version resolution is performed.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SignedBinaryBucketInstallDescriptor } from '@makaio/contracts/client';
import type { InstallArtifact, InstallStrategy, StrategyDependencies, StrategyProgressCallback } from './types.js';
import { makeDownloadProgressAdapter } from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Minimal platform information needed to select the binary.
 */
interface PlatformRuntime {
  /** Node.js platform identifier (e.g. `'darwin'`, `'linux'`, `'win32'`). */
  readonly platform: NodeJS.Platform;
  /** Node.js architecture identifier (e.g. `'x64'`, `'arm64'`). */
  readonly arch: NodeJS.Architecture;
  /** Whether the process is running on a musl libc system (Linux only). */
  readonly isMusl: boolean;
}

/**
 * Per-platform entry from the signed manifest.
 */
interface SignedBucketPlatformEntry {
  /** Bare binary filename (no path separators). */
  readonly binary: string;
  /** Expected hex-encoded checksum of the binary. */
  readonly checksum: string;
}

/** Parsed shape of the signed manifest. */
interface SignedBucketManifest {
  /** Exact binary version covered by this manifest. */
  readonly version: string;
  /** Platform-keyed binary entries certified by the manifest signature. */
  readonly platforms: Record<string, unknown>;
}

/**
 * Detect whether the current Linux runtime is musl-based.
 * @returns True when Node's process report does not expose a glibc runtime.
 */
function detectMuslRuntime(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    const report = process.report?.getReport?.();
    if (typeof report !== 'object' || report === null || !('header' in report)) {
      return true;
    }
    const { header } = report;
    if (typeof header !== 'object' || header === null) {
      return true;
    }
    return !('glibcVersionRuntime' in header);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an OpenPGP fingerprint for comparison.
 *
 * Strips all non-hexadecimal characters and uppercases the result so that
 * `'31DD DE24 DDFA …'` and `'31DDDE24DDFA…'` compare equal.
 * @param raw - Raw fingerprint string from any source.
 * @returns Uppercase hex string with no whitespace or punctuation.
 */
function normalizeFingerprint(raw: string): string {
  return raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/**
 * Expand a bucket path template by substituting `{version}`, `{platform}`,
 * and `{binary}` placeholders.
 * @param template - Path template string.
 * @param version - Version string to substitute.
 * @param platform - Platform segment to substitute (may be `undefined` when
 *   the template does not include `{platform}`).
 * @param binary - Binary filename to substitute (may be `undefined` when the
 *   template does not include `{binary}`).
 * @returns Expanded path string.
 */
function expandTemplate(template: string, version: string, platform?: string, binary?: string): string {
  let result = template.replaceAll('{version}', version);
  if (platform !== undefined) {
    result = result.replaceAll('{platform}', platform);
  }
  if (binary !== undefined) {
    result = result.replaceAll('{binary}', binary);
  }
  return result;
}

/**
 * Resolve the platform key used to look up the bucket platform segment.
 *
 * Returns `'<os>-<arch>'` for most targets, with a `-musl` suffix on Linux
 * musl builds.
 * @param runtime - Platform information to derive the key from.
 * @returns Platform key string (e.g. `'darwin-arm64'`, `'linux-x64-musl'`).
 */
function resolvePlatformKey(runtime: PlatformRuntime): string {
  const base = `${runtime.platform}-${runtime.arch}`;
  if (runtime.platform === 'linux' && runtime.isMusl) {
    return `${base}-musl`;
  }
  return base;
}

/**
 * Parse and validate the top-level signed manifest.
 *
 * Throws a descriptive error if the manifest is malformed or covers a version
 * other than the descriptor pin.
 * @param manifest - Parsed manifest JSON (unknown shape).
 * @param expectedVersion - Descriptor-pinned version this manifest must cover.
 * @returns The validated manifest envelope.
 */
function parseSignedManifest(manifest: unknown, expectedVersion: string): SignedBucketManifest {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Signed manifest must be a JSON object');
  }

  const raw = manifest as Record<string, unknown>;
  const version = raw['version'];
  if (version !== expectedVersion) {
    throw new Error(`Signed manifest version ${String(version)} does not match descriptor pin ${expectedVersion}`);
  }
  const platforms = raw['platforms'];
  if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new Error('Signed manifest must contain a platforms object');
  }

  return { version, platforms: platforms as Record<string, unknown> };
}

/**
 * Parse and validate a platform entry from the signed manifest.
 *
 * Throws a descriptive error if the manifest is malformed or missing the
 * expected platform entry.
 * @param manifest - Parsed signed manifest.
 * @param platformKey - The platform key to look up.
 * @returns The validated platform entry.
 */
function parsePlatformEntry(manifest: SignedBucketManifest, platformKey: string): SignedBucketPlatformEntry {
  const entry = manifest.platforms[platformKey];

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Signed manifest does not contain a platform entry for '${platformKey}'`);
  }

  const { binary, checksum } = entry as Record<string, unknown>;

  if (typeof binary !== 'string' || !isSafeBinaryFilename(binary)) {
    throw new Error(`Manifest entry for '${platformKey}' has unsafe binary filename`);
  }
  if (typeof checksum !== 'string' || checksum.length === 0) {
    throw new Error(`Manifest entry for '${platformKey}' is missing a valid 'checksum' field`);
  }

  return { binary, checksum };
}

/**
 * Return true when a manifest binary value is a single safe filename component.
 * @param value - Candidate binary filename from the signed manifest.
 * @returns True when the value cannot escape the install directory.
 */
function isSafeBinaryFilename(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

// ---------------------------------------------------------------------------
// Strategy implementation
// ---------------------------------------------------------------------------

/**
 * Install strategy for the `signed-binary-bucket` descriptor type.
 *
 * The pipeline:
 * 1. Rejects if the requested version differs from the descriptor pin.
 * 2. Resolves the platform key from the runtime environment.
 * 3. Downloads the GPG public key, manifest JSON, and detached manifest
 *    signature from the configured bucket URLs.
 * 4. Verifies that the downloaded key's fingerprint matches the expected
 *    fingerprint declared in the descriptor.
 * 5. Imports the key into an isolated temporary GNUPG home, then verifies
 *    the manifest signature.
 * 6. Reads the manifest to obtain the platform binary name and expected
 *    checksum.
 * 7. Downloads the binary.
 * 8. Verifies the binary checksum.
 * 9. Makes the binary executable on non-Windows platforms.
 * 10. Returns an {@link InstallArtifact} pointing to the install directory.
 */
export class SignedBinaryBucketStrategy implements InstallStrategy {
  readonly #descriptor: SignedBinaryBucketInstallDescriptor;
  readonly #deps: StrategyDependencies;
  readonly #runtime: PlatformRuntime;

  /**
   * @param descriptor - The signed binary bucket install descriptor, including
   *   the exact version pin and bucket configuration.
   * @param deps - Injected I/O dependencies (network, file-system, subprocess).
   * @param runtime - Optional platform runtime override. Defaults to the
   *   running Node.js process's `platform` and `arch`.
   */
  public constructor(
    descriptor: SignedBinaryBucketInstallDescriptor,
    deps: StrategyDependencies,
    runtime?: Partial<PlatformRuntime>,
  ) {
    this.#descriptor = descriptor;
    this.#deps = deps;
    this.#runtime = {
      platform: runtime?.platform ?? process.platform,
      arch: runtime?.arch ?? process.arch,
      isMusl: runtime?.isMusl ?? detectMuslRuntime(),
    };
  }

  /**
   * Execute the signed binary bucket install pipeline.
   *
   * Downloads and verifies the manifest, then downloads and verifies the
   * binary. The binary is written into `targetDir` and made executable on
   * non-Windows platforms.
   * @param version - The exact version to install. Must match the descriptor pin.
   * @param targetDir - Absolute path to the directory to install into.
   * @param onProgress - Optional progress callback invoked at each pipeline stage.
   * @returns A normalized install artifact describing the installed binary.
   * @throws When `version` differs from the descriptor pin.
   * @throws When the GPG key fingerprint does not match the expected fingerprint.
   * @throws When the manifest GPG signature is invalid.
   * @throws When the downloaded binary checksum does not match the manifest.
   */
  public async execute(
    version: string,
    targetDir: string,
    onProgress?: StrategyProgressCallback,
  ): Promise<InstallArtifact> {
    if (version !== this.#descriptor.version) {
      throw new Error(
        `signed-binary-bucket managed install requested version ${version} but descriptor pins ${this.#descriptor.version}`,
      );
    }

    const { config } = this.#descriptor;
    const platformKey = resolvePlatformKey(this.#runtime);
    const platformSegment = config.platforms[platformKey];

    if (platformSegment === undefined) {
      throw new Error(
        `signed-binary-bucket descriptor has no platform entry for '${platformKey}'. ` +
          `Supported platforms: ${Object.keys(config.platforms).join(', ')}`,
      );
    }

    await fs.mkdir(targetDir, { recursive: true });

    const gnupgHome = path.join(targetDir, '.gnupg');
    const keyFilePath = path.join(targetDir, 'signing-key.asc');
    const manifestFilePath = path.join(targetDir, 'manifest.json');
    const sigFilePath = path.join(targetDir, 'manifest.json.sig');

    onProgress?.('resolving', null);
    await this.#downloadVerificationAssets(config, version, keyFilePath, manifestFilePath, sigFilePath);

    onProgress?.('verifying', null);
    const platformEntry = await this.#verifyManifestAndReadPlatformEntry(
      config,
      gnupgHome,
      keyFilePath,
      manifestFilePath,
      sigFilePath,
      platformKey,
    );

    onProgress?.('downloading', null);
    const binaryRelPath = expandTemplate(config.binaryPathTemplate, version, platformSegment, platformEntry.binary);
    const binaryFilePath = path.resolve(targetDir, platformEntry.binary);
    await this.#deps.downloadFile(
      `${config.baseUrl}/${binaryRelPath}`,
      binaryFilePath,
      makeDownloadProgressAdapter(onProgress),
    );

    onProgress?.('verifying', null);
    const actualChecksum = await this.#deps.computeChecksum(binaryFilePath);
    if (actualChecksum !== platformEntry.checksum) {
      throw new Error(`Binary checksum mismatch: expected ${platformEntry.checksum} but computed ${actualChecksum}`);
    }

    onProgress?.('installing', null);
    if (this.#runtime.platform !== 'win32') {
      await fs.chmod(binaryFilePath, 0o755);
    }
    await this.#deps.removeDirectory(gnupgHome);
    await this.#deps.deleteFile(keyFilePath);
    await this.#deps.deleteFile(sigFilePath);
    onProgress?.('installing', 100);

    return { installPath: targetDir, version: this.#descriptor.version, strategy: 'signed-binary-bucket' };
  }

  /**
   * Download the public key, manifest JSON, and detached signature into
   * the target directory.
   *
   * The public key is fetched as text (ASCII-armored) and written to
   * `keyFilePath`; the manifest and signature are binary-downloaded.
   * @param config - The bucket configuration from the descriptor.
   * @param version - The exact version string used to expand path templates.
   * @param keyFilePath - Destination path for the ASCII-armored public key.
   * @param manifestFilePath - Destination path for the manifest JSON.
   * @param sigFilePath - Destination path for the detached signature.
   */
  async #downloadVerificationAssets(
    config: SignedBinaryBucketInstallDescriptor['config'],
    version: string,
    keyFilePath: string,
    manifestFilePath: string,
    sigFilePath: string,
  ): Promise<void> {
    const manifestUrl = `${config.baseUrl}/${expandTemplate(config.manifestPathTemplate, version)}`;
    const sigUrl = `${config.baseUrl}/${expandTemplate(config.manifestSignaturePathTemplate, version)}`;

    const publicKeyText = await this.#deps.fetchText(config.publicKeyUrl);
    await fs.writeFile(keyFilePath, publicKeyText, 'utf-8');
    await this.#deps.downloadFile(manifestUrl, manifestFilePath);
    await this.#deps.downloadFile(sigUrl, sigFilePath);
  }

  /**
   * Verify the GPG key fingerprint and manifest signature, then read and
   * return the platform entry from the manifest.
   *
   * Creates an isolated `gnupgHome` directory, imports the key, checks the
   * fingerprint, verifies the signature, and parses the manifest to extract
   * the binary name and expected checksum for `platformKey`.
   * @param config - The bucket configuration from the descriptor.
   * @param gnupgHome - Isolated GNUPG home directory for key operations.
   * @param keyFilePath - Path to the downloaded ASCII-armored public key.
   * @param manifestFilePath - Path to the downloaded manifest JSON.
   * @param sigFilePath - Path to the downloaded detached signature.
   * @param platformKey - Platform key used to look up the manifest entry.
   * @returns The platform-specific binary name and expected checksum.
   * @throws When the fingerprint does not match the expected value.
   * @throws When the manifest signature is invalid.
   */
  async #verifyManifestAndReadPlatformEntry(
    config: SignedBinaryBucketInstallDescriptor['config'],
    gnupgHome: string,
    keyFilePath: string,
    manifestFilePath: string,
    sigFilePath: string,
    platformKey: string,
  ): Promise<SignedBucketPlatformEntry> {
    await fs.mkdir(gnupgHome, { recursive: true, mode: 0o700 });
    await this.#deps.exec('gpg', ['--homedir', gnupgHome, '--import', keyFilePath]);

    const listOutput = await this.#deps.exec('gpg', [
      '--homedir',
      gnupgHome,
      '--with-colons',
      '--fingerprint',
      '--list-keys',
    ]);
    const actualFingerprint = this.#extractFingerprintFromColonOutput(listOutput);
    if (normalizeFingerprint(actualFingerprint) !== normalizeFingerprint(config.publicKeyFingerprint)) {
      throw new Error(
        `GPG key fingerprint mismatch: expected ${config.publicKeyFingerprint} but got ${actualFingerprint}`,
      );
    }

    await this.#deps
      .exec('gpg', ['--homedir', gnupgHome, '--verify', sigFilePath, manifestFilePath])
      .catch((err: Error) => {
        throw new Error(`Manifest GPG signature verification failed: ${err.message}`);
      });

    const manifestText = await fs.readFile(manifestFilePath, 'utf-8');
    const manifest = parseSignedManifest(JSON.parse(manifestText) as unknown, this.#descriptor.version);
    return parsePlatformEntry(manifest, platformKey);
  }

  /**
   * Extract the primary key fingerprint from `gpg --with-colons --fingerprint`
   * output.
   *
   * The colon-delimited format has `fpr` records whose 10th field is the full
   * fingerprint. We take the first `fpr` line that follows the primary key
   * (`pub`) record.
   * @param colonOutput - Raw stdout from `gpg --with-colons --fingerprint`.
   * @returns The fingerprint string from the first `fpr` record.
   * @throws When no fingerprint record is found in the output.
   */
  #extractFingerprintFromColonOutput(colonOutput: string): string {
    for (const line of colonOutput.split('\n')) {
      const fields = line.split(':');
      if (fields[0] === 'fpr' && fields[9] !== undefined && fields[9].length > 0) {
        return fields[9];
      }
    }
    throw new Error('Could not extract GPG key fingerprint from output');
  }
}
