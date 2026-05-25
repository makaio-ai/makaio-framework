/**
 * Manifest sync helpers that keep the project manifest in sync with the npm
 * extension install/uninstall lifecycle.
 *
 * Both functions silently skip when no project manifest exists in the directory
 * tree rooted at `startDir`. Failures are intended to be surfaced as warnings
 * rather than hard errors so that a stale or missing manifest never blocks the
 * install/uninstall command itself.
 * @packageDocumentation
 */

import {
  findProjectManifestPath,
  formatExactExtensionSpec,
  parseExactExtensionSpec,
  readProjectManifest,
  type ProjectManifest,
  writeProjectManifest,
} from '@makaio/utils/project-manifest';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { DirectNpmInstallResolution } from './extension-install-transaction.js';

const MANIFEST_LOCK_RETRIES = 40;
const MANIFEST_LOCK_DELAY_MS = 25;
const MANIFEST_LOCK_STALE_MS = 5 * 60 * 1000;

interface ManifestLockMetadata {
  readonly pid: number;
  readonly createdAt: string;
}

/**
 * Update the project manifest after a successful npm extension install.
 *
 * For each resolved package in `directNpm`, the corresponding entry in the
 * manifest's `extensions` array is added (if absent) or replaced (if a prior
 * pin for the same package name already exists). Host-owned namespace keys
 * (e.g. `hosts`) are preserved untouched via the schema's `.passthrough()`
 * semantics. Extensions are written in sorted order for stable diffs.
 *
 * Skips silently when `directNpm` is empty or no manifest exists under
 * `startDir`.
 * @param startDir - Directory to start searching upward for the project manifest.
 * @param directNpm - Directly-requested npm install resolutions to sync.
 */
export async function syncProjectManifestAfterInstall(
  startDir: string,
  directNpm: readonly DirectNpmInstallResolution[],
): Promise<void> {
  if (directNpm.length === 0) return;
  await updateProjectManifest(startDir, (manifest) => {
    const byPackage = new Map(manifest.extensions.map((spec) => [parseExactExtensionSpec(spec).packageName, spec]));
    for (const resolution of directNpm) {
      byPackage.set(resolution.packageName, formatExactExtensionSpec(resolution.packageName, resolution.version));
    }
    const extensions = [...byPackage.values()].sort();
    if (extensions.join('\n') === [...manifest.extensions].sort().join('\n')) {
      return null;
    }
    return {
      ...manifest,
      extensions,
    };
  });
}

/**
 * Update existing project manifest pins after package updates.
 *
 * Unlike install sync, this never adds new project requirements. Only packages
 * already present in the project manifest are moved to their newly installed
 * exact versions.
 * @param startDir - Directory to start searching upward for the project manifest.
 * @param directNpm - Updated npm package versions.
 */
export async function syncExistingProjectManifestPinsAfterUpdate(
  startDir: string,
  directNpm: readonly DirectNpmInstallResolution[],
): Promise<void> {
  if (directNpm.length === 0) return;
  await updateProjectManifest(startDir, (manifest) => {
    const updates = new Map(directNpm.map((resolution) => [resolution.packageName, resolution.version]));
    let changed = false;
    const extensions = manifest.extensions.map((spec) => {
      const parsed = parseExactExtensionSpec(spec);
      const updatedVersion = updates.get(parsed.packageName);
      if (updatedVersion === undefined || updatedVersion === parsed.version) {
        return spec;
      }
      changed = true;
      return formatExactExtensionSpec(parsed.packageName, updatedVersion);
    });
    return changed ? { ...manifest, extensions: extensions.sort() } : null;
  });
}

/**
 * Remove a package pin from the project manifest after a successful uninstall.
 *
 * Finds the entry whose package name matches `packageName` and removes it.
 * Other entries and all host-owned namespace keys are preserved unchanged.
 *
 * Skips silently when no manifest exists under `startDir`.
 * @param startDir - Directory to start searching upward for the project manifest.
 * @param packageName - Fully-qualified npm package name to remove from extensions.
 */
export async function syncProjectManifestAfterUninstall(startDir: string, packageName: string): Promise<void> {
  await updateProjectManifest(startDir, (manifest) => {
    const extensions = manifest.extensions
      .filter((spec) => parseExactExtensionSpec(spec).packageName !== packageName)
      .sort();
    if (extensions.length === manifest.extensions.length) {
      return null;
    }
    return { ...manifest, extensions };
  });
}

/**
 * Apply a serialized project manifest update when a manifest exists.
 * @param startDir - Directory to start searching upward for the project manifest.
 * @param update - Manifest transform; return `null` to skip writing.
 */
async function updateProjectManifest(
  startDir: string,
  update: (manifest: ProjectManifest) => ProjectManifest | null,
): Promise<void> {
  const manifestPath = await findProjectManifestPath(startDir);
  if (manifestPath === null) return;

  await withManifestLock(manifestPath, async () => {
    const manifest = await readProjectManifest(manifestPath);
    const updated = update(manifest);
    if (updated !== null) {
      await writeProjectManifest(manifestPath, updated);
    }
  });
}

/**
 * Run an operation while holding an advisory project manifest file lock.
 * @param manifestPath - Absolute manifest path used to derive the lock path.
 * @param operation - Async operation to run while the lock is held.
 * @returns The operation result.
 */
async function withManifestLock<T>(manifestPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${manifestPath}.lock`;
  const handle = await acquireLock(lockPath);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Acquire a lock file with bounded retry.
 * @param lockPath - Absolute lock file path.
 * @returns Open file handle representing the held lock.
 */
async function acquireLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < MANIFEST_LOCK_RETRIES; attempt += 1) {
    try {
      return await createLockFile(lockPath);
    } catch (error) {
      if (!isExistingFileError(error) || attempt === MANIFEST_LOCK_RETRIES - 1) {
        throw error;
      }
      if (await reapStaleLock(lockPath)) {
        continue;
      }
      await delay(MANIFEST_LOCK_DELAY_MS);
    }
  }
  throw new Error(`Could not acquire project manifest lock: ${lockPath}`);
}

/**
 * Create a lock file and write ownership metadata used for stale recovery.
 * @param lockPath - Absolute lock file path.
 * @returns Open file handle representing the held lock.
 */
async function createLockFile(lockPath: string): Promise<FileHandle> {
  const handle = await fs.open(lockPath, 'wx');
  try {
    const metadata: ManifestLockMetadata = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await handle.writeFile(`${JSON.stringify(metadata)}\n`);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Remove an abandoned lock file when its owner process is gone or too old.
 * @param lockPath - Absolute lock file path.
 * @returns Whether a stale lock was removed.
 */
async function reapStaleLock(lockPath: string): Promise<boolean> {
  const before = await fs.stat(lockPath).catch(() => null);
  if (before === null) return true;

  const metadata = await readLockMetadata(lockPath);
  const createdAtMs = getLockCreatedAtMs(metadata, before.mtimeMs);
  const processAlive = metadata === null ? null : isProcessAlive(metadata.pid);
  const stale = processAlive === false || Date.now() - createdAtMs > MANIFEST_LOCK_STALE_MS;
  if (!stale) return false;

  const current = await fs.stat(lockPath).catch(() => null);
  if (
    current !== null &&
    (current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs)
  ) {
    return false;
  }
  await fs.unlink(lockPath).catch((error: unknown) => {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  });
  return true;
}

/**
 * Read lock metadata from a lock file.
 * @param lockPath - Absolute lock file path.
 * @returns Parsed metadata, or `null` when the file is unreadable or malformed.
 */
async function readLockMetadata(lockPath: string): Promise<ManifestLockMetadata | null> {
  const raw = await fs.readFile(lockPath, 'utf-8').catch(() => null);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      'createdAt' in parsed &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.createdAt === 'string'
    ) {
      const pid = parsed.pid;
      const createdAt = parsed.createdAt;
      return {
        pid,
        createdAt,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve the lock creation timestamp from metadata or filesystem mtime.
 * @param metadata - Parsed lock metadata, if available.
 * @param fallbackMs - Filesystem mtime fallback in milliseconds.
 * @returns Milliseconds since epoch.
 */
function getLockCreatedAtMs(metadata: ManifestLockMetadata | null, fallbackMs: number): number {
  if (metadata === null) return fallbackMs;
  const parsed = Date.parse(metadata.createdAt);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/**
 * Check whether a lock owner process is still alive.
 * @param pid - Process identifier stored in lock metadata.
 * @returns `true` when alive, `false` when definitely gone, otherwise `null`.
 */
function isProcessAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isProcessLookupError(error)) return false;
    if (isPermissionError(error)) return true;
    return null;
  }
}

/**
 * Check whether an unknown filesystem error indicates an existing file.
 * @param error - Unknown thrown value.
 * @returns Whether the error has code `EEXIST`.
 */
function isExistingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

/**
 * Check whether an unknown filesystem error indicates a missing file.
 * @param error - Unknown thrown value.
 * @returns Whether the error has code `ENOENT`.
 */
function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Check whether an unknown process error indicates a missing process.
 * @param error - Unknown thrown value.
 * @returns Whether the error has code `ESRCH`.
 */
function isProcessLookupError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

/**
 * Check whether an unknown process error indicates an inaccessible live process.
 * @param error - Unknown thrown value.
 * @returns Whether the error has code `EPERM`.
 */
function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
}

/**
 * Sleep for a fixed duration.
 * @param ms - Milliseconds to wait.
 * @returns Promise resolved after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
