/**
 * Manifest-bucket install strategy.
 *
 * Resolves the latest version from a static HTTP version-index file, fetches a
 * per-version JSON manifest to obtain the expected checksum, downloads the
 * binary archive, verifies its integrity, and extracts it into the target
 * directory.
 * @packageDocumentation
 */

import * as path from 'node:path';
import type { ManifestBucketInstallDescriptor } from '@makaio/contracts/client';
import { assertJsonObject, makeDownloadProgressAdapter } from './types.js';
import type { InstallArtifact, InstallStrategy, StrategyDependencies, StrategyProgressCallback } from './types.js';

/**
 * Concrete install strategy for the `manifest-bucket` descriptor type.
 *
 * The strategy uses three steps:
 * 1. **Version resolution** — GET `{baseUrl}/{versionIndex.latest}` and trim the
 *    response to obtain the latest version string.
 * 2. **Manifest fetch** — GET `{baseUrl}/{version}/{manifestPath}` to load the
 *    per-version JSON manifest. `manifestPath` is a plain path segment relative
 *    to the versioned directory, not a template (the version is always prepended).
 * 3. **Download + verify + extract** — download the binary archive, compute its
 *    SHA-256 checksum, compare it against the value in the manifest, then
 *    extract (or copy for `raw` format) into `targetDir`.
 */
export class ManifestBucketStrategy implements InstallStrategy {
  readonly #descriptor: ManifestBucketInstallDescriptor;
  readonly #deps: StrategyDependencies;

  /**
   * @param descriptor - The manifest-bucket install descriptor.
   * @param deps - Injected I/O dependencies used for network and file-system operations.
   */
  public constructor(descriptor: ManifestBucketInstallDescriptor, deps: StrategyDependencies) {
    this.#descriptor = descriptor;
    this.#deps = deps;
  }

  /**
   * Resolve the latest available version from the bucket version-index file.
   *
   * Fetches `{baseUrl}/{versionIndex.latest}` and returns the trimmed response body.
   * @returns The latest version string from the bucket.
   */
  public async resolveLatestVersion(): Promise<string> {
    const { baseUrl, versionIndex } = this.#descriptor.config;
    const url = `${baseUrl}/${versionIndex.latest}`;
    const text = await this.#deps.fetchText(url);
    const version = text.trim();
    if (version.length === 0) {
      throw new Error(`Version index at ${url} returned an empty version`);
    }
    return version;
  }

  /**
   * Execute the manifest-bucket install pipeline.
   *
   * Steps:
   * 1. Fetch the per-version manifest JSON.
   * 2. Download the binary archive.
   * 3. Verify its SHA-256 checksum against the manifest.
   * 4. Extract the archive (or keep raw when `archiveFormat` is `'raw'` or absent).
   * @param version - The exact version to install.
   * @param targetDir - Absolute path to the directory to install into.
   * @param onProgress - Optional progress callback invoked at each pipeline stage.
   * @returns A normalized install artifact describing the installed binary.
   */
  public async execute(
    version: string,
    targetDir: string,
    onProgress?: StrategyProgressCallback,
  ): Promise<InstallArtifact> {
    const { baseUrl, manifestPath, manifestChecksumField, binaryPath, archiveFormat } = this.#descriptor.config;

    onProgress?.('resolving', null);

    // 1. Fetch manifest JSON for this version.
    const manifestUrl = `${baseUrl}/${version}/${manifestPath}`;
    const manifest = await this.#deps.fetchJson(manifestUrl);
    assertJsonObject(manifest, `Manifest at ${manifestUrl}`);

    const expectedChecksum = this.#extractChecksumField(manifest, manifestChecksumField, manifestUrl);

    // 2. Download the binary archive.
    const archiveUrl = `${baseUrl}/${version}/${binaryPath}`;
    const archiveDestPath = path.join(targetDir, this.#archiveFileName(binaryPath));

    onProgress?.('downloading', null);
    await this.#deps.downloadFile(archiveUrl, archiveDestPath, makeDownloadProgressAdapter(onProgress));

    // 3. Verify checksum.
    onProgress?.('verifying', null);
    const actualChecksum = await this.#deps.computeChecksum(archiveDestPath);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Checksum mismatch for ${archiveUrl}: expected ${expectedChecksum}, got ${actualChecksum}`);
    }

    // 4. Extract (or keep raw).
    onProgress?.('extracting', null);
    const format = archiveFormat ?? 'raw';
    if (format === 'tar.gz' || format === 'zip') {
      await this.#deps.extractArchive(archiveDestPath, targetDir, format);
      await this.#deps.deleteFile(archiveDestPath).catch(() => undefined);
    }
    // For 'raw', the downloaded file is already in targetDir — no extraction needed.

    onProgress?.('installing', 100);

    return {
      installPath: targetDir,
      version,
      strategy: 'manifest-bucket',
    };
  }

  /**
   * Extracts a non-empty string checksum from the manifest object.
   * @param manifest - The parsed manifest JSON object.
   * @param field - The field name that holds the expected checksum.
   * @param manifestUrl - URL used in error messages.
   * @returns The expected checksum string.
   */
  #extractChecksumField(manifest: Record<string, unknown>, field: string, manifestUrl: string): string {
    const value = manifest[field];
    if (typeof value !== 'string') {
      throw new Error(`Manifest at ${manifestUrl} is missing a non-empty string field "${field}"`);
    }
    const checksum = value.trim().toLowerCase();
    if (checksum.length === 0) {
      throw new Error(`Manifest at ${manifestUrl} is missing a non-empty string field "${field}"`);
    }
    return checksum;
  }

  /**
   * Derives a file-system-safe archive file name from the binary path.
   *
   * Uses `path.posix.basename` rather than string splitting so that traversal
   * sequences (`..`) in a crafted `binaryPath` cannot escape `targetDir`.
   * `path.posix` is used explicitly because `binaryPath` values from the
   * manifest always use POSIX separators regardless of the host platform.
   * @param binaryPath - The relative binary path from the descriptor.
   * @returns The last path segment (i.e. the file name).
   */
  #archiveFileName(binaryPath: string): string {
    const fileName = path.posix.basename(binaryPath);
    if (fileName.length === 0 || fileName === '.' || fileName === '..') {
      throw new Error(`Invalid binaryPath "${binaryPath}" for manifest-bucket strategy`);
    }
    return fileName;
  }
}
