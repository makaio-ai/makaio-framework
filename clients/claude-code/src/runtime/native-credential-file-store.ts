import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Settled file operation result retained until temporary cleanup completes. */
type TemporaryFileOperationResult<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown };

/** Settled result of mandatory temporary-file cleanup. */
type TemporaryFileCleanupResult =
  | { readonly status: 'fulfilled' }
  | { readonly status: 'rejected'; readonly reason: unknown };

/**
 * Run one atomic-file operation and preserve both operation and cleanup errors.
 * @param temporaryPath - Session-owned temporary file to remove after the operation.
 * @param operation - Atomic write or replace operation using the temporary file.
 * @returns Operation result after temporary cleanup settles.
 */
async function withTemporaryFile<T>(temporaryPath: string, operation: () => Promise<T>): Promise<T> {
  let result: TemporaryFileOperationResult<T>;
  try {
    result = { status: 'fulfilled', value: await operation() };
  } catch (reason) {
    result = { status: 'rejected', reason };
  }

  let cleanupResult: TemporaryFileCleanupResult;
  try {
    await fs.rm(temporaryPath, { force: true });
    cleanupResult = { status: 'fulfilled' };
  } catch (reason) {
    cleanupResult = { status: 'rejected', reason };
  }

  if (result.status === 'rejected') {
    if (cleanupResult.status === 'rejected') {
      throw new AggregateError(
        [result.reason, cleanupResult.reason],
        'Native credential file operation and cleanup failed',
      );
    }
    throw result.reason;
  }
  if (cleanupResult.status === 'rejected') throw cleanupResult.reason;
  return result.value;
}

/**
 * Hash a credential without retaining it in lease metadata.
 * @param credential - Native credential payload.
 * @returns Stable SHA-256 generation marker.
 */
export function digestCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

/**
 * Read a credential file while treating absence as an explicit state.
 * @param credentialPath - Credential file path.
 * @returns File contents or `null` when absent.
 */
export async function readCredentialFileIfPresent(credentialPath: string): Promise<string | null> {
  try {
    return await fs.readFile(credentialPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Atomically persist text with owner-only permissions.
 * @param filePath - Destination file path.
 * @param content - Text content to persist.
 * @param mode - POSIX permission bits for a newly created file.
 */
export async function writeTextAtomically(filePath: string, content: string, mode = 0o600): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await withTemporaryFile(temporaryPath, async () => {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf-8', mode });
    await fs.rename(temporaryPath, filePath);
  });
}

/**
 * Replace a canonical credential file only while its observed generation is
 * unchanged. The final re-read narrows the filesystem race before rename.
 * @param credentialPath - Canonical credential file path.
 * @param expectedGeneration - Source digest captured at lease creation.
 * @param replacement - Refreshed session credential payload.
 * @returns Whether the replacement was committed.
 */
export async function compareAndSwapCredentialFile(
  credentialPath: string,
  expectedGeneration: string,
  replacement: string,
): Promise<boolean> {
  const current = await readCredentialFileIfPresent(credentialPath);
  if (current === null || digestCredential(current) !== expectedGeneration) return false;

  const mode = (await fs.stat(credentialPath)).mode & 0o777;
  const temporaryPath = path.join(
    path.dirname(credentialPath),
    `.${path.basename(credentialPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  return withTemporaryFile(temporaryPath, async () => {
    await fs.writeFile(temporaryPath, replacement, { encoding: 'utf-8', mode });
    const latest = await readCredentialFileIfPresent(credentialPath);
    if (latest === null || digestCredential(latest) !== expectedGeneration) return false;
    await fs.rename(temporaryPath, credentialPath);
    return true;
  });
}
