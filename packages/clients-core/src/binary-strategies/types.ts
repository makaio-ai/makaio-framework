/**
 * Shared types for the client binary install strategy subsystem.
 *
 * All three built-in strategies (`manifest-bucket`, `npm`, `github-release`)
 * implement {@link InstallStrategy} and receive their I/O dependencies through
 * {@link StrategyDependencies}. This keeps every strategy fully testable without
 * real network calls or file-system side effects.
 * @packageDocumentation
 */

import type { InstallStage, ManagedInstallStrategy } from '@makaio/contracts/client';

/**
 * Progress callback invoked by a strategy as it moves through pipeline stages.
 * @param stage - The current install pipeline stage.
 * @param progress - Fractional progress in `[0, 100]`, or `null` when the
 *   stage does not have deterministic progress (e.g. resolving, verifying).
 */
export type StrategyProgressCallback = (stage: InstallStage, progress: number | null) => void;

/**
 * Normalized result of a successful strategy execution.
 *
 * Every strategy returns this shape so the `ClientBinaryManager` can handle
 * all strategies without branching on type.
 */
export interface InstallArtifact {
  /**
   * Absolute path to the installed binary's directory.
   *
   * For `npm`, this is the `node_modules/.bin`-accessible root.
   * For archive strategies this is the extraction target directory.
   */
  installPath: string;

  /**
   * The concrete version that was installed.
   *
   * For `manifest-bucket` and `github-release` this is the tag/version
   * string resolved from the upstream index. For `npm` it is the registry
   * version.
   */
  version: string;

  /** The strategy that performed the install. */
  strategy: ManagedInstallStrategy;
}

/**
 * Injected I/O dependencies for install strategy implementations.
 *
 * Abstracting these operations behind an interface makes every strategy
 * testable without touching the network or file system.
 */
export interface StrategyDependencies {
  /**
   * Fetch `url` and return the full response body as a string.
   * @param url - The URL to fetch.
   * @returns The raw response body text.
   */
  fetchText(url: string): Promise<string>;

  /**
   * Fetch `url`, parse the response body as JSON, and return it.
   * @param url - The URL to fetch.
   * @returns The parsed JSON value.
   */
  fetchJson(url: string): Promise<unknown>;

  /**
   * Download `url` to `destPath` on disk, optionally reporting byte progress.
   * @param url - The URL to download.
   * @param destPath - Absolute destination file path.
   * @param onProgress - Optional callback; `total` is `null` when the server
   *   does not advertise a `Content-Length`.
   * @returns The resolved absolute destination path.
   */
  downloadFile(
    url: string,
    destPath: string,
    onProgress?: (downloaded: number, total: number | null) => void,
  ): Promise<string>;

  /**
   * Execute a shell command and return its stdout.
   * @param command - The executable to run (no shell expansion).
   * @param args - Positional arguments passed to the executable.
   * @param options - Optional execution options.
   * @returns Trimmed stdout string.
   */
  exec(command: string, args: string[], options?: { cwd?: string }): Promise<string>;

  /**
   * Extract an archive file into `destDir`.
   * @param archivePath - Absolute path to the archive file.
   * @param destDir - Absolute directory to extract into.
   * @param format - Archive type (`'tar.gz'` or `'zip'`).
   */
  extractArchive(archivePath: string, destDir: string, format: 'tar.gz' | 'zip'): Promise<void>;

  /**
   * Delete a single file from disk.
   *
   * Implementations must be idempotent — if `filePath` does not exist the call
   * should resolve without error.
   * @param filePath - Absolute path to the file to remove.
   */
  deleteFile(filePath: string): Promise<void>;

  /**
   * Compute the checksum of a file at `filePath`.
   * @param filePath - Absolute path to the file to hash.
   * @param algorithm - Hash algorithm name (defaults to `'sha256'`).
   * @returns Lowercase hex-encoded digest string.
   */
  computeChecksum(filePath: string, algorithm?: string): Promise<string>;

  /**
   * Recursively remove a directory and all of its contents.
   *
   * Implementations must be idempotent — if `dirPath` does not exist the
   * call should resolve without error. This mirrors the `force` flag of
   * `fs.rm` from `node:fs/promises`.
   * @param dirPath - Absolute path to the directory to remove.
   */
  removeDirectory(dirPath: string): Promise<void>;
}

/**
 * Asserts that a parsed JSON value is a plain object (not null, not an array).
 *
 * Shared across strategies that parse JSON responses from upstream APIs so
 * the base check is not duplicated per strategy.
 * @param value - Parsed JSON value to validate
 * @param label - Human-readable label used in the error message
 */
export function assertJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

/**
 * Adapts a {@link StrategyDependencies.downloadFile} progress callback into
 * a {@link StrategyProgressCallback} `'downloading'` stage emission.
 *
 * Shared across strategies that download archives so the percentage
 * calculation and null-total handling are not duplicated per strategy.
 * @param onProgress - Strategy progress callback, or `undefined` when suppressed
 * @returns A download progress handler, or `undefined` when `onProgress` is absent
 */
export function makeDownloadProgressAdapter(
  onProgress: StrategyProgressCallback | undefined,
): ((downloaded: number, total: number | null) => void) | undefined {
  if (onProgress === undefined) return undefined;
  return (downloaded, total) => {
    if (total !== null && total > 0) {
      onProgress('downloading', (downloaded / total) * 100);
    } else {
      onProgress('downloading', null);
    }
  };
}

/**
 * Common interface implemented by all install strategy classes.
 *
 * A strategy is a pure computation unit — it has no bus, no BaseService, and
 * no side effects beyond what is provided through {@link StrategyDependencies}.
 */
export interface InstallStrategy {
  /**
   * Resolve the latest available version for this descriptor.
   *
   * Strategies should make a single network call (version index or API
   * endpoint) and return the version string without any local state.
   * @returns The latest version string (semver or opaque tag).
   */
  resolveLatestVersion(): Promise<string>;

  /**
   * Execute the install pipeline for `version` into `targetDir`.
   *
   * The strategy is responsible for downloading, verifying (when applicable),
   * extracting, and writing the binary into `targetDir`. The returned
   * {@link InstallArtifact} tells the manager where the binary landed and
   * which version was installed.
   * @param version - The exact version to install.
   * @param targetDir - Absolute path to the directory to install into.
   * @param onProgress - Optional progress callback invoked at each stage.
   * @returns A normalized install artifact describing the installed binary.
   */
  execute(version: string, targetDir: string, onProgress?: StrategyProgressCallback): Promise<InstallArtifact>;
}
