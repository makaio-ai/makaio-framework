/**
 * Node.js {@link StrategyDependencies} implementation for the client binary
 * manager.
 *
 * Provides real I/O implementations of every operation required by the install
 * strategy subsystem — network fetches, file downloads, archive extraction,
 * subprocess execution, and checksum computation. Network, file, checksum, and
 * subprocess plumbing uses Node.js APIs; archive extraction delegates to host
 * `tar` / `unzip` executables because Node does not provide built-in archive
 * extractors for both formats.
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { StrategyDependencies } from '@makaio/clients-core';

const execFileAsync = promisify(execFile);

/** Default timeout for metadata fetches such as version indexes and manifests. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Default timeout for binary downloads. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Default timeout for subprocess operations (`npm`, version commands, etc.). */
const DEFAULT_EXEC_TIMEOUT_MS = 2 * 60_000;

/** Default timeout for archive extraction subprocesses. */
const DEFAULT_EXTRACT_TIMEOUT_MS = 5 * 60_000;

/**
 * Timeout configuration for Node managed-binary strategy dependencies.
 */
export interface NodeClientBinaryStrategyDependencyOptions {
  /** Timeout in milliseconds for text/JSON metadata fetches. */
  fetchTimeoutMs?: number;
  /** Timeout in milliseconds for binary downloads. */
  downloadTimeoutMs?: number;
  /** Timeout in milliseconds for generic subprocess execution. */
  execTimeoutMs?: number;
  /** Timeout in milliseconds for `tar` / `unzip` extraction subprocesses. */
  extractTimeoutMs?: number;
}

/**
 * Fully resolved timeout values for each I/O category.
 */
interface ResolvedNodeClientBinaryStrategyTimeouts {
  /** Timeout in milliseconds for text/JSON metadata fetches. */
  fetchTimeoutMs: number;
  /** Timeout in milliseconds for binary downloads. */
  downloadTimeoutMs: number;
  /** Timeout in milliseconds for generic subprocess execution. */
  execTimeoutMs: number;
  /** Timeout in milliseconds for `tar` / `unzip` extraction subprocesses. */
  extractTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a fetch {@link Response} has a 2xx status code.
 *
 * Throws a descriptive error on non-2xx responses so callers do not silently
 * process error payloads as valid data.
 * @param response - The fetch response to validate.
 * @param url - Original URL, used in the error message.
 */
function assertOk(response: Response, url: string): void {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${url}`);
  }
}

/**
 * Merge caller-provided timeout overrides with production defaults.
 * @param options - Optional timeout overrides
 * @returns Complete timeout configuration
 */
function resolveTimeouts(options: NodeClientBinaryStrategyDependencyOptions): ResolvedNodeClientBinaryStrategyTimeouts {
  return {
    fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    downloadTimeoutMs: options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    execTimeoutMs: options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    extractTimeoutMs: options.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS,
  };
}

/**
 * Fetch a URL with a timeout and consistent timeout error text.
 * @param url - URL to fetch
 * @param timeoutMs - Timeout in milliseconds
 * @returns Fetch response
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(`Timed out fetching ${url} after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Extract an archive at `archivePath` into `destDir`, enriching subprocess
 * errors with the archive path, destination directory, and stderr output.
 *
 * The destination directory is created recursively before extraction begins.
 * @param archivePath - Absolute path to the archive file.
 * @param destDir - Absolute directory to extract into.
 * @param format - Archive type (`'tar.gz'` or `'zip'`).
 * @param timeoutMs - Timeout in milliseconds for the extraction subprocess
 */
async function extractArchive(
  archivePath: string,
  destDir: string,
  format: 'tar.gz' | 'zip',
  timeoutMs: number,
): Promise<void> {
  await fsPromises.mkdir(destDir, { recursive: true });

  if (format === 'tar.gz') {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], { timeout: timeoutMs }).catch(
      (err: NodeJS.ErrnoException & { stderr?: string }) => {
        if (err.code === 'ENOENT') {
          throw new Error('tar extraction failed: host executable "tar" was not found on PATH');
        }
        throw new Error(
          `tar extraction failed: ${archivePath} → ${destDir}\nstderr: ${err.stderr ?? ''}\n${String(err.message)}`,
        );
      },
    );
  } else {
    await execFileAsync('unzip', ['-q', archivePath, '-d', destDir], { timeout: timeoutMs }).catch(
      (err: NodeJS.ErrnoException & { stderr?: string }) => {
        if (err.code === 'ENOENT') {
          throw new Error('zip extraction failed: host executable "unzip" was not found on PATH');
        }
        throw new Error(
          `unzip extraction failed: ${archivePath} → ${destDir}\nstderr: ${err.stderr ?? ''}\n${String(err.message)}`,
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create the Node.js {@link StrategyDependencies} implementation used by the
 * client binary manager in production boots.
 *
 * All I/O is performed with Node 22 APIs plus explicit host archive tools:
 * - Network: global `fetch` (Node 22 built-in).
 * - File downloads: streamed via `node:stream` `pipeline` with backpressure.
 * - Archive extraction: host `tar -xzf` for `tar.gz`, host `unzip -q` for `zip`.
 * - File cleanup: `node:fs/promises.rm` with `{ force: true }`.
 * - Subprocess: `node:child_process.execFile` (no shell, stderr in errors).
 * - Checksum: `node:crypto.createHash` streaming.
 * - Directory removal: `node:fs/promises.rm` with `{ recursive: true, force: true }`.
 * @param options - Optional timeout overrides for tests or constrained hosts
 * @returns A fully-wired {@link StrategyDependencies} object.
 */
export function createNodeClientBinaryStrategyDependencies(
  options: NodeClientBinaryStrategyDependencyOptions = {},
): StrategyDependencies {
  const { fetchTimeoutMs, downloadTimeoutMs, execTimeoutMs, extractTimeoutMs } = resolveTimeouts(options);

  return {
    /**
     * Fetch a URL and return the response body as a string.
     *
     * Throws on non-2xx HTTP status codes.
     * @param url - The URL to fetch.
     * @returns Raw response body text.
     */
    async fetchText(url: string): Promise<string> {
      const response = await fetchWithTimeout(url, fetchTimeoutMs);
      assertOk(response, url);
      return response.text();
    },

    /**
     * Fetch a URL, parse the response body as JSON, and return it.
     *
     * Throws on non-2xx HTTP status codes or malformed JSON.
     * @param url - The URL to fetch.
     * @returns Parsed JSON value.
     */
    async fetchJson(url: string): Promise<unknown> {
      const response = await fetchWithTimeout(url, fetchTimeoutMs);
      assertOk(response, url);
      return response.json() as Promise<unknown>;
    },

    /**
     * Download a URL to `destPath`, streaming the response body and
     * reporting byte progress from `Content-Length` when present.
     *
     * The parent directory of `destPath` is created recursively before writing
     * begins so the caller does not need to pre-create it.
     * @param url - The URL to download.
     * @param destPath - Absolute destination file path.
     * @param onProgress - Optional callback; `total` is `null` when the server
     *   does not advertise a `Content-Length`.
     * @returns The resolved absolute destination path.
     */
    async downloadFile(
      url: string,
      destPath: string,
      onProgress?: (downloaded: number, total: number | null) => void,
    ): Promise<string> {
      const response = await fetchWithTimeout(url, downloadTimeoutMs);
      assertOk(response, url);

      if (response.body === null) {
        throw new Error(`Response body is null for URL: ${url}`);
      }

      const contentLength = response.headers.get('content-length');
      const total = contentLength !== null ? parseInt(contentLength, 10) : null;
      const resolvedTotal = total !== null && !isNaN(total) ? total : null;

      await fsPromises.mkdir(path.dirname(destPath), { recursive: true });

      const writeStream = fs.createWriteStream(destPath);

      let downloaded = 0;
      const progressTracker = new Transform({
        /**
         * Pass each chunk through unchanged while accumulating byte count and
         * forwarding progress to the caller.
         * @param chunk - Incoming data chunk from the network readable.
         * @param _encoding - Encoding (unused — binary mode).
         * @param callback - Node stream callback to signal chunk is consumed.
         */
        transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void): void {
          downloaded += chunk.length;
          onProgress?.(downloaded, resolvedTotal);
          callback(null, chunk);
        },
      });

      // Readable.from accepts AsyncIterable<any>. DOM ReadableStream implements
      // AsyncIterable via dom.iterable, so this avoids the type mismatch between
      // the DOM ReadableStream type and the @types/node streamWeb.ReadableStream
      // expected by Readable.fromWeb.
      try {
        await pipeline(Readable.from(response.body), progressTracker, writeStream);
      } catch (err) {
        await fsPromises.rm(destPath, { force: true });
        throw err;
      }

      return destPath;
    },

    /**
     * Execute a command without a shell and return trimmed stdout.
     *
     * Uses `node:child_process.execFile` so no shell expansion occurs on the
     * arguments. Stderr is included in the thrown error message on non-zero
     * exit.
     * @param command - The executable to run.
     * @param args - Positional arguments passed to the executable.
     * @param options - Optional execution options (e.g. `cwd`).
     * @returns Trimmed stdout string.
     */
    async exec(command: string, args: string[], options?: { cwd?: string }): Promise<string> {
      const { stdout } = await execFileAsync(command, args, {
        cwd: options?.cwd,
        shell: false,
        timeout: execTimeoutMs,
      }).catch((err: NodeJS.ErrnoException & { stderr?: string; stdout?: string }) => {
        if (err.code === 'ENOENT') {
          throw new Error(`Command failed: host executable "${command}" was not found on PATH`);
        }
        const stderrText = err.stderr ?? '';
        throw new Error(`Command failed: ${command} ${args.join(' ')}\nstderr: ${stderrText}\n${String(err.message)}`);
      });

      return (stdout ?? '').trim();
    },

    /**
     * Extract an archive file into `destDir`.
     *
     * Creates `destDir` recursively before extraction.
     * - `tar.gz`: `tar -xzf <archive> -C <destDir>`
     * - `zip`:    `unzip -q <archive> -d <destDir>`
     * @param archivePath - Absolute path to the archive file.
     * @param destDir - Absolute directory to extract into.
     * @param format - Archive type (`'tar.gz'` or `'zip'`).
     */
    async extractArchive(archivePath: string, destDir: string, format: 'tar.gz' | 'zip'): Promise<void> {
      await extractArchive(archivePath, destDir, format, extractTimeoutMs);
    },

    /**
     * Delete a single file.
     *
     * Idempotent — resolves without error when `filePath` does not exist.
     * @param filePath - Absolute path to the file to remove.
     */
    async deleteFile(filePath: string): Promise<void> {
      await fsPromises.rm(filePath, { force: true });
    },

    /**
     * Compute the checksum of the file at `filePath` by streaming its
     * contents through `node:crypto.createHash`.
     * @param filePath - Absolute path to the file to hash.
     * @param algorithm - Hash algorithm name (defaults to `'sha256'`).
     * @returns Lowercase hex-encoded digest string.
     */
    async computeChecksum(filePath: string, algorithm = 'sha256'): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const hash = createHash(algorithm);
        const stream = fs.createReadStream(filePath);

        stream.on('error', reject);
        stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
      });
    },

    /**
     * Recursively remove a directory and all of its contents.
     *
     * Idempotent — resolves without error when `dirPath` does not exist, mirroring
     * the `force` flag of `fs.rm`.
     * @param dirPath - Absolute path to the directory to remove.
     */
    async removeDirectory(dirPath: string): Promise<void> {
      await fsPromises.rm(dirPath, { recursive: true, force: true });
    },
  };
}
