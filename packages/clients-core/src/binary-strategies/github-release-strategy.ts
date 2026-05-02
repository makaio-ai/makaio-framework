/**
 * GitHub Releases install strategy.
 *
 * Queries the GitHub Releases API to resolve the latest version tag and to
 * locate the correct platform-specific release asset, then downloads and
 * extracts the archive into the target directory.
 * @packageDocumentation
 */

import * as path from 'node:path';
import type { GithubReleaseInstallDescriptor } from '@makaio/contracts/client';
import { assertJsonObject, makeDownloadProgressAdapter } from './types.js';
import type { InstallArtifact, InstallStrategy, StrategyDependencies, StrategyProgressCallback } from './types.js';

/**
 * Minimal shape of a single release asset as returned by the GitHub REST API.
 * Only the fields required by this strategy are modelled; the rest are ignored.
 */
interface GitHubReleaseAsset {
  /** Asset file name (e.g. `'claude-darwin-arm64.tar.gz'`). */
  name: string;
  /** Pre-signed download URL for the asset. */
  browser_download_url: string;
}

/**
 * Runtime type guard for a {@link GitHubReleaseAsset}.
 *
 * Validates that an API-supplied entry carries the two required string fields
 * before any property access occurs. Guards against malformed entries such as
 * `null`, numeric values, or objects missing `browser_download_url`.
 * @param a - The value to test.
 * @returns `true` when `a` is a valid {@link GitHubReleaseAsset}.
 */
function isValidAsset(a: unknown): a is GitHubReleaseAsset {
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof (a as Record<string, unknown>)['name'] === 'string' &&
    typeof (a as Record<string, unknown>)['browser_download_url'] === 'string'
  );
}

/**
 * Minimal shape of a GitHub release object from the REST API.
 * Only the fields required by this strategy are modelled.
 */
interface GitHubRelease {
  /** Git tag name for this release (e.g. `'v1.2.3'`). */
  tag_name: string;
  /** List of assets attached to this release. */
  assets: GitHubReleaseAsset[];
}

/** Base URL for the GitHub REST API. Exposed as a constant for testability. */
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Concrete install strategy for the `github-release` descriptor type.
 *
 * Asset selection uses the `assetPattern` mapping from the descriptor, keyed
 * by `<platform>-<arch>` (e.g. `darwin-arm64`). The value is matched against
 * the release asset names — **exactly one** asset whose name contains the
 * pattern string must match; zero or multiple matches both throw.
 */
export class GithubReleaseStrategy implements InstallStrategy {
  readonly #descriptor: GithubReleaseInstallDescriptor;
  readonly #deps: StrategyDependencies;

  /**
   * @param descriptor - The github-release install descriptor.
   * @param deps - Injected I/O dependencies.
   */
  public constructor(descriptor: GithubReleaseInstallDescriptor, deps: StrategyDependencies) {
    this.#descriptor = descriptor;
    this.#deps = deps;
  }

  /**
   * Resolve the latest available version tag from the GitHub Releases API.
   *
   * Fetches `GET /repos/{repo}/releases/latest` and returns the `tag_name` field.
   * @returns The latest release tag name (e.g. `'v1.2.3'`).
   */
  public async resolveLatestVersion(): Promise<string> {
    const url = `${GITHUB_API_BASE}/repos/${this.#descriptor.repo}/releases/latest`;
    const data = await this.#deps.fetchJson(url);
    const release = this.#assertRelease(data, url);
    return release.tag_name;
  }

  /**
   * Execute the GitHub release download and extract pipeline.
   *
   * Steps:
   * 1. Build a `<platform>-<arch>` key from `process.platform` + `process.arch`.
   * 2. Look up the asset name pattern for that key in `assetPattern`.
   * 3. Fetch the release object for `version` from the GitHub API.
   * 4. Find the release asset whose name matches the pattern.
   * 5. Download the asset archive.
   * 6. Extract the archive into `targetDir`.
   * @param version - The exact version tag to install (e.g. `'v1.2.3'`).
   * @param targetDir - Absolute path to the directory to extract into.
   * @param onProgress - Optional progress callback invoked at each pipeline stage.
   * @returns A normalized install artifact describing the installed binary.
   */
  public async execute(
    version: string,
    targetDir: string,
    onProgress?: StrategyProgressCallback,
  ): Promise<InstallArtifact> {
    onProgress?.('resolving', null);

    // 1. Determine the platform key (e.g. 'darwin-arm64').
    const platformKey = this.#buildPlatformKey();

    // 2. Look up the expected asset name pattern for this platform.
    const assetPattern = this.#descriptor.assetPattern[platformKey];
    if (assetPattern === undefined) {
      throw new Error(
        `No asset pattern for platform key "${platformKey}" in github-release descriptor for ${this.#descriptor.repo}`,
      );
    }

    // 3. Fetch the release for `version` to get the asset list.
    const releaseUrl = `${GITHUB_API_BASE}/repos/${this.#descriptor.repo}/releases/tags/${version}`;
    const data = await this.#deps.fetchJson(releaseUrl);
    const release = this.#assertRelease(data, releaseUrl);

    // 4. Find the matching asset — exactly one must match to avoid ambiguity
    //    with sidecar files (.sha256, .sig, etc.).
    const matchingAssets = release.assets.filter((a) => a.name.includes(assetPattern));
    if (matchingAssets.length !== 1) {
      const available = release.assets.map((a) => a.name).join(', ');
      throw new Error(
        matchingAssets.length === 0
          ? `No release asset matching "${assetPattern}" for platform "${platformKey}" in ${this.#descriptor.repo}@${version}. Available: ${available}`
          : `Ambiguous release asset pattern "${assetPattern}" for platform "${platformKey}" in ${this.#descriptor.repo}@${version}. Matches: ${matchingAssets.map((a) => a.name).join(', ')}`,
      );
    }
    const [asset] = matchingAssets;

    this.#assertAsset(asset, version);

    // 5. Download the asset.
    // V1: no checksum verification — GitHub releases do not universally
    // provide sidecar .sha256/.sig files. Integrity depends on HTTPS
    // transport security. Descriptor extension for optional checksum
    // verification is deferred until a concrete use-case surfaces.
    onProgress?.('downloading', null);
    const archiveDestPath = path.join(targetDir, path.basename(asset.name));
    await this.#deps.downloadFile(asset.browser_download_url, archiveDestPath, makeDownloadProgressAdapter(onProgress));

    // 6. Extract the archive.
    onProgress?.('extracting', null);
    await this.#deps.extractArchive(archiveDestPath, targetDir, this.#descriptor.archiveFormat);
    await this.#deps.deleteFile(archiveDestPath).catch(() => undefined);

    onProgress?.('installing', 100);

    return {
      installPath: targetDir,
      version,
      strategy: 'github-release',
    };
  }

  /**
   * Build the platform key used to look up an asset pattern.
   *
   * Combines `process.platform` and `process.arch` with a hyphen
   * (e.g. `'darwin-arm64'`, `'linux-x64'`).
   * @returns The platform-arch key string.
   */
  #buildPlatformKey(): string {
    return `${process.platform}-${process.arch}`;
  }

  /**
   * Assert that `value` is a valid {@link GitHubRelease} shape.
   *
   * Validates both the top-level structure (`tag_name` string, `assets` array)
   * and each individual asset entry via {@link isValidAsset}. Invalid entries
   * are filtered out rather than causing a crash, but a descriptive error is
   * thrown when the filtered set differs from the raw set so callers know the
   * API response was malformed.
   * @param value - The parsed JSON value to validate.
   * @param url - The source URL, used in error messages.
   * @returns The validated release object.
   */
  #assertRelease(value: unknown, url: string): GitHubRelease {
    assertJsonObject(value, `GitHub API response at ${url}`);
    if (typeof value['tag_name'] !== 'string' || !Array.isArray(value['assets'])) {
      throw new Error(`Unexpected response from GitHub API at ${url}: ${JSON.stringify(value)}`);
    }
    const rawAssets = value['assets'] as unknown[];
    const validAssets = rawAssets.filter(isValidAsset);
    if (validAssets.length !== rawAssets.length) {
      const invalidCount = rawAssets.length - validAssets.length;
      throw new Error(
        `GitHub API response at ${url} contained ${invalidCount} asset entr${invalidCount === 1 ? 'y' : 'ies'} missing required "name" or "browser_download_url" string fields`,
      );
    }
    return { tag_name: value['tag_name'], assets: validAssets };
  }

  /**
   * Assert that a matched release asset has the required fields.
   *
   * Validates `name` and `browser_download_url` as non-empty strings so that
   * a malformed API response produces a descriptive error rather than an opaque
   * `TypeError` during path or URL construction.
   *
   * Also rejects asset names whose `path.basename` resolves to `'.'` or `'..'`,
   * which would otherwise cause `path.join(targetDir, basename)` to silently
   * stay in (or escape to the parent of) the install directory.
   * @param asset - The matched asset object from the GitHub API response.
   * @param version - The release version string, used in error messages.
   */
  #assertAsset(asset: GitHubReleaseAsset, version: string): void {
    if (typeof asset.name !== 'string' || asset.name.length === 0) {
      throw new Error(
        `Matched release asset for ${this.#descriptor.repo}@${version} has an invalid or missing "name" field`,
      );
    }
    const basename = path.basename(asset.name);
    if (basename === '.' || basename === '..') {
      throw new Error(
        `Matched release asset for ${this.#descriptor.repo}@${version} has a path-traversal "name" field: "${asset.name}"`,
      );
    }
    if (typeof asset.browser_download_url !== 'string' || asset.browser_download_url.length === 0) {
      throw new Error(
        `Matched release asset "${asset.name}" for ${this.#descriptor.repo}@${version} has an invalid or missing "browser_download_url" field`,
      );
    }
  }
}
