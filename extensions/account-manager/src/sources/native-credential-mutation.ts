import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ICredentialBackend } from '../backends/credential-backend.js';
import type {
  NativeCredentialCoordination,
  PreparedNativeCredentialMutation,
  RawCredential,
} from '../interfaces/credential-source.js';

/** Result returned by a client-owned cross-process source lock. */
export interface CredentialSourceLockExecution<T> {
  /** Operation result retained even when lock finalization became uncertain. */
  readonly value: T;
  /** Whether the acquired lock released without compromise or cleanup failure. */
  readonly coordination: NativeCredentialCoordination;
}

/** Cross-process lock executor supplied by a client runtime. */
export type CredentialSourceLockExecutor = <T>(
  operation: () => Promise<T>,
) => Promise<CredentialSourceLockExecution<T>>;

/**
 * Resolve a mutable source directory while rejecting every lexical alias.
 * @param sourceConfigDir - Candidate client config directory.
 * @returns Canonical path equal to the caller's absolute lexical path.
 */
export async function resolveMutableCredentialSourceDirectory(sourceConfigDir: string): Promise<string> {
  return (await pinCredentialSourceDirectory(sourceConfigDir)).canonicalPath;
}

/** Stable directory identity retained by one prepared native mutation. */
interface PinnedCredentialSourceDirectory {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

/** Secret-free native source failure safe for bus propagation and logs. */
class NativeCredentialMutationError extends Error {
  /** @param clientId - Stable client identity. */
  public constructor(clientId: string) {
    super(`${clientId} native credential mutation failed`);
    this.name = 'NativeCredentialMutationError';
  }
}

/**
 * Prepare a source-owned credential write with generation-checked rollback.
 * @param clientId - Stable client identity used only in secret-free failures.
 * @param sourceConfigDir - Lexical source config directory to pin.
 * @param backend - Location-bound credential backend.
 * @param credential - Target credential to materialize.
 * @param executeLocked - Client runtime's canonical cross-process lock executor.
 * @returns Prepared native mutation retaining opaque rollback state privately.
 */
export async function prepareBackendNativeCredentialMutation(
  clientId: string,
  sourceConfigDir: string,
  backend: ICredentialBackend,
  credential: RawCredential,
  executeLocked: CredentialSourceLockExecutor,
): Promise<PreparedNativeCredentialMutation> {
  try {
    const pinned = await pinCredentialSourceDirectory(sourceConfigDir);
    const pinnedBackend = backend.bindToCanonicalConfigDirectory?.(pinned.canonicalPath) ?? backend;
    const targetGeneration = digestRawCredential(credential.token);
    const prepared = await executeLocked(async () => {
      await assertPinnedCredentialSourceDirectory(pinned);
      const previous = await pinnedBackend.read();
      await pinnedBackend.write(credential.token);
      return { previous };
    });
    reportUncertainCoordination(clientId, 'write', prepared.coordination);

    return {
      coordination: prepared.coordination,
      rollback: async () => {
        try {
          const rollback = await executeLocked(async () => {
            await assertPinnedCredentialSourceDirectory(pinned);
            const current = await pinnedBackend.read();
            if (digestOptionalRawCredential(current) !== targetGeneration) {
              return { status: 'superseded' as const };
            }
            if (prepared.value.previous === null) {
              await pinnedBackend.clear();
            } else {
              await pinnedBackend.write(prepared.value.previous);
            }
            return { status: 'restored' as const };
          });
          reportUncertainCoordination(clientId, 'rollback', rollback.coordination);
          return { ...rollback.value, coordination: rollback.coordination };
        } catch {
          throw new NativeCredentialMutationError(clientId);
        }
      },
    };
  } catch (error) {
    if (error instanceof NativeCredentialMutationError) throw error;
    throw new NativeCredentialMutationError(clientId);
  }
}

/**
 * Apply a non-reversible write through the same source-owned primitive.
 * @param clientId - Stable client identity.
 * @param sourceConfigDir - Source config directory to pin.
 * @param backend - Credential backend.
 * @param credential - Credential to write.
 * @param executeLocked - Client source lock executor.
 */
export async function writeBackendNativeCredential(
  clientId: string,
  sourceConfigDir: string,
  backend: ICredentialBackend,
  credential: RawCredential,
  executeLocked: CredentialSourceLockExecutor,
): Promise<void> {
  await prepareBackendNativeCredentialMutation(clientId, sourceConfigDir, backend, credential, executeLocked);
}

/**
 * Clear native credentials under a pinned source identity.
 * @param clientId - Stable client identity.
 * @param sourceConfigDir - Source config directory to pin.
 * @param backend - Credential backend.
 * @param executeLocked - Client source lock executor.
 */
export async function clearBackendNativeCredential(
  clientId: string,
  sourceConfigDir: string,
  backend: ICredentialBackend,
  executeLocked: CredentialSourceLockExecutor,
): Promise<void> {
  try {
    const pinned = await pinCredentialSourceDirectory(sourceConfigDir);
    const pinnedBackend = backend.bindToCanonicalConfigDirectory?.(pinned.canonicalPath) ?? backend;
    const cleared = await executeLocked(async () => {
      await assertPinnedCredentialSourceDirectory(pinned);
      await pinnedBackend.clear();
    });
    reportUncertainCoordination(clientId, 'clear', cleared.coordination);
  } catch {
    throw new NativeCredentialMutationError(clientId);
  }
}

/**
 * Pin one real, non-aliased config directory for later CAS rollback.
 * @param sourceConfigDir - Candidate client config directory.
 * @returns Stable canonical path plus its filesystem identity.
 */
async function pinCredentialSourceDirectory(sourceConfigDir: string): Promise<PinnedCredentialSourceDirectory> {
  const lexicalPath = path.resolve(sourceConfigDir);
  await fs.mkdir(lexicalPath, { recursive: true });
  const canonicalPath = await fs.realpath(lexicalPath);
  if (canonicalPath !== lexicalPath) throw new Error('Credential source aliases are not mutable account targets');
  const stat = await fs.lstat(canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Credential source must be a stable directory');
  return { canonicalPath, device: stat.dev, inode: stat.ino };
}

/**
 * Verify that a prepared mutation still addresses its original directory.
 * @param pinned - Directory identity retained when the mutation was prepared.
 */
async function assertPinnedCredentialSourceDirectory(pinned: PinnedCredentialSourceDirectory): Promise<void> {
  const stat = await fs.lstat(pinned.canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pinned.device || stat.ino !== pinned.inode) {
    throw new Error('Credential source directory identity changed');
  }
}

/**
 * Compute an opaque source generation without parsing credential contents.
 * @param value - Opaque serialized credential bytes.
 * @returns SHA-256 generation identifier.
 */
function digestRawCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Represent absence separately from every possible credential digest.
 * @param value - Opaque serialized credential bytes, or absence.
 * @returns Credential generation identifier, or `null` for absence.
 */
function digestOptionalRawCredential(value: string | null): string | null {
  return value === null ? null : digestRawCredential(value);
}

/**
 * Emit only stable coordination metadata; credential bytes and platform errors stay private.
 * @param clientId - Stable client identity.
 * @param operation - Native mutation phase that committed.
 * @param coordination - Source-lock finalization state.
 */
function reportUncertainCoordination(
  clientId: string,
  operation: 'write' | 'rollback' | 'clear',
  coordination: NativeCredentialCoordination,
): void {
  if (coordination === 'uncertain') {
    console.warn(`[AccountManager] ${clientId} native credential ${operation} committed; source lock is uncertain`);
  }
}
