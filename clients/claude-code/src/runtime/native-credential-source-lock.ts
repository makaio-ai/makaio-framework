import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { lock } from 'proper-lockfile';

/** Bounded, shared source-lock policy used by every native-auth reconciler. */
const SOURCE_LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  update: 10_000,
  retries: { retries: 50, factor: 1, minTimeout: 20, maxTimeout: 100 },
} as const;

/** Internal marker for lock failures whose platform errors must not escape. */
export class NativeCredentialSourceLockError extends Error {
  public constructor() {
    super('Claude Code native credential source lock failed');
    this.name = 'NativeCredentialSourceLockError';
  }
}

/** Lock finalization failed after the guarded credential operation committed. */
export class NativeCredentialSourceLockFinalizationError extends Error {
  public constructor() {
    super('Claude Code native credential source lock is uncertain after committed operation');
    this.name = 'NativeCredentialSourceLockFinalizationError';
  }
}

/** Result that preserves a committed operation across lock-finalization failure. */
export interface CredentialSourceLockExecution<T> {
  /** Guarded operation result. */
  readonly value: T;
  /** Whether release completed without lock compromise or cleanup failure. */
  readonly coordination: 'released' | 'uncertain';
}

/** Settled operation result retained until the source lock is released. */
type CredentialSourceOperationResult<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown };

/**
 * Resolve the existing canonical source path, preserving a lexical fallback for
 * a source directory that has not been created yet.
 * @param sourceConfigDir - Absolute canonical client config directory.
 * @returns Stable lock anchor path.
 */
async function resolveSourceLockPath(sourceConfigDir: string): Promise<string> {
  try {
    return await fs.realpath(sourceConfigDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new NativeCredentialSourceLockError();
    }
    return path.resolve(sourceConfigDir);
  }
}

/**
 * Run an operation and preserve its outcome until lock release has settled.
 * This avoids throwing from `finally`, so release failure cannot replace the
 * original operation failure.
 * @param operation - Credential operation guarded by the source lock.
 * @param isCompromised - Reports whether the acquired lock lost ownership.
 * @param release - Acquired lock release callback.
 * @returns Operation result plus explicit lock-finalization state.
 */
async function runLockedOperation<T>(
  operation: () => Promise<T>,
  isCompromised: () => boolean,
  release: () => Promise<void>,
): Promise<CredentialSourceLockExecution<T>> {
  let result: CredentialSourceOperationResult<T>;
  try {
    if (isCompromised()) throw new NativeCredentialSourceLockError();
    const value = await operation();
    result = { status: 'fulfilled', value };
  } catch (reason) {
    result = { status: 'rejected', reason };
  }

  let releaseFailure: NativeCredentialSourceLockError | undefined;
  try {
    await release();
  } catch {
    releaseFailure = new NativeCredentialSourceLockError();
  }

  if (result.status === 'rejected') {
    if (releaseFailure !== undefined) {
      throw new AggregateError([result.reason, releaseFailure], 'Claude Code native credential operation failed');
    }
    throw result.reason;
  }
  return {
    value: result.value,
    coordination: releaseFailure !== undefined || isCompromised() ? 'uncertain' : 'released',
  };
}

/**
 * Execute under the canonical source lock while retaining committed outcomes
 * when lock release or ownership becomes uncertain.
 * @param sourceConfigDir - Absolute canonical client config directory.
 * @param operation - Credential operation guarded by the source lock.
 * @returns Operation value plus released/uncertain coordination state.
 */
export async function executeCredentialSourceLock<T>(
  sourceConfigDir: string,
  operation: () => Promise<T>,
): Promise<CredentialSourceLockExecution<T>> {
  const sourceLockPath = await resolveSourceLockPath(sourceConfigDir);
  let compromised = false;
  let release: () => Promise<void>;
  try {
    release = await lock(sourceLockPath, {
      ...SOURCE_LOCK_OPTIONS,
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch {
    throw new NativeCredentialSourceLockError();
  }

  return runLockedOperation(operation, () => compromised, release);
}

/**
 * Serialize canonical native-auth reads and writes across Makaio processes.
 *
 * The lock is anchored to the same canonical config directory that owns the
 * credential. Claude Code also coordinates refreshes against its config home,
 * so a refresh completed while this call waits is observed by the subsequent
 * generation check instead of being overwritten.
 * @param sourceConfigDir - Absolute canonical client config directory.
 * @param operation - Credential operation that must hold the shared source lock.
 * @returns Operation result after releasing the source lock.
 */
export async function withCredentialSourceLock<T>(sourceConfigDir: string, operation: () => Promise<T>): Promise<T> {
  const result = await executeCredentialSourceLock(sourceConfigDir, operation);
  if (result.coordination === 'uncertain') throw new NativeCredentialSourceLockFinalizationError();
  return result.value;
}
