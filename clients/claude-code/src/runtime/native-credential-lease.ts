import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  compareAndSwapCredentialFile,
  digestCredential,
  readCredentialFileIfPresent,
} from './native-credential-file-store.js';
import {
  isFilesystemCredentialLeaseForSession,
  isKeychainCredentialLeaseForSession,
  readCredentialLeaseMetadata,
  removeCredentialLeaseMetadata,
  writeCredentialLeaseMetadata,
  type ClaudeCodeNativeAuthLeaseMetadata,
} from './native-credential-lease-metadata.js';
import { NativeCredentialSourceLockError, withCredentialSourceLock } from './native-credential-source-lock.js';

/** Filesystem operations used by Claude Code credential materialization. */
export interface ClaudeCodeFilesystemCredentialOperations {
  /** Verify that a path exists and is accessible. */
  access: typeof fs.access;
  /** Copy a credential file when links are unavailable. */
  copyFile: typeof fs.copyFile;
  /** Resolve a symlink target and verify the resulting credential exists. */
  stat: typeof fs.stat;
  /** Link the session credential path to the selected source credential. */
  symlink: typeof fs.symlink;
  /** Remove a session-owned credential file or symlink. */
  unlink: typeof fs.unlink;
}

/** Credential store used for macOS Keychain-backed Claude Code credentials. */
export interface ClaudeCodeKeychainCredentialStore {
  /**
   * Read a credential value.
   * @param service - Keychain service name.
   * @param account - Keychain account name.
   * @returns Stored credential value, or `null` when absent.
   */
  read(service: string, account: string): Promise<string | null>;
  /**
   * Persist a credential value.
   * @param service - Keychain service name.
   * @param account - Keychain account name.
   * @param value - Credential payload to store.
   */
  write(service: string, account: string, value: string): Promise<void>;
  /**
   * Remove a credential value.
   * @param service - Keychain service name.
   * @param account - Keychain account name.
   */
  delete(service: string, account: string): Promise<void>;
}

/** Deterministic cleanup target used when no valid lease metadata remains. */
export type ClaudeCodeNativeCredentialFallbackTarget =
  | { backend: 'keychain'; service: string; account: string }
  | { backend: 'filesystem'; credentialPath: string };

/** Request for releasing detached native credential material. */
export interface ClaudeCodeNativeCredentialLeaseReleaseRequest {
  /** Session-scoped Claude Code config directory. */
  sessionDir: string;
  /** Target derivable without persisted metadata. */
  fallbackTarget: ClaudeCodeNativeCredentialFallbackTarget;
}

/** Request for preparing a macOS Keychain clone. */
export interface ClaudeCodeKeychainCredentialLeasePreparationRequest {
  /** Session-scoped Claude Code config directory. */
  sessionDir: string;
  /** Canonical native Keychain service. */
  sourceService: string;
  /** Config directory whose lock coordinates canonical credential refreshes. */
  sourceConfigDir: string;
  /** Whether the source Keychain service is global or config-directory scoped. */
  sourceIdentity: 'global' | 'scoped';
  /** Session-scoped hashed Keychain service. */
  targetService: string;
  /** Keychain account shared by the source and target entries. */
  account: string;
}

/** Request for preparing a detached filesystem credential copy. */
export interface ClaudeCodeFilesystemCredentialLeasePreparationRequest {
  /** Session-scoped Claude Code config directory. */
  sessionDir: string;
  /** Canonical credential file copied at setup. */
  sourceCredentialPath: string;
  /** Detached session credential copy. */
  targetCredentialPath: string;
}

/**
 * Build an error that exposes lifecycle stages without forwarding platform
 * errors that may contain credential material or paths.
 * @param operation - Credential lifecycle operation.
 * @param stages - Sanitized stage identifiers that failed.
 * @returns Error safe to cross service boundaries.
 */
function createLifecycleError(operation: 'setup' | 'teardown', stages: readonly string[]): Error {
  return new Error(`Claude Code native credential ${operation} failed (${[...new Set(stages)].join(', ')})`);
}

/**
 * Remove a credential file or symlink if present.
 * @param operations - Filesystem operations backing credential cleanup.
 * @param credentialPath - Session-owned credential path.
 */
async function unlinkIfPresent(
  operations: ClaudeCodeFilesystemCredentialOperations,
  credentialPath: string,
): Promise<void> {
  try {
    await operations.unlink(credentialPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Reconcile a refreshed Keychain clone while its source is unchanged.
 * @param metadata - Validated Keychain lease metadata.
 * @param store - Keychain credential store.
 */
async function reconcileKeychainLease(
  metadata: Extract<ClaudeCodeNativeAuthLeaseMetadata, { backend: 'keychain' }>,
  store: ClaudeCodeKeychainCredentialStore,
): Promise<void> {
  await withCredentialSourceLock(metadata.source.configDir, async () => {
    const targetCredential = await store.read(metadata.target.service, metadata.target.account);
    if (targetCredential === null || digestCredential(targetCredential) === metadata.target.initialDigest) return;

    const sourceCredential = await store.read(metadata.source.service, metadata.source.account);
    if (sourceCredential === null || digestCredential(sourceCredential) !== metadata.source.generation) return;
    await store.write(metadata.source.service, metadata.source.account, targetCredential);
  });
}

/**
 * Reconcile a refreshed detached file while its source is unchanged.
 * @param metadata - Validated filesystem-copy lease metadata.
 */
async function reconcileFilesystemLease(
  metadata: Extract<ClaudeCodeNativeAuthLeaseMetadata, { backend: 'filesystem-copy' }>,
): Promise<void> {
  await withCredentialSourceLock(path.dirname(metadata.source.credentialPath), async () => {
    const targetCredential = await readCredentialFileIfPresent(metadata.target.credentialPath);
    if (targetCredential === null || digestCredential(targetCredential) === metadata.target.initialDigest) return;
    await compareAndSwapCredentialFile(metadata.source.credentialPath, metadata.source.generation, targetCredential);
  });
}

/**
 * Clean the deterministic target used when valid metadata is unavailable.
 * @param target - Keychain or filesystem target identity.
 * @param operations - Filesystem operations used for file cleanup.
 * @param store - Keychain store used for Keychain cleanup.
 */
async function cleanFallbackTarget(
  target: ClaudeCodeNativeCredentialFallbackTarget,
  operations: ClaudeCodeFilesystemCredentialOperations,
  store: ClaudeCodeKeychainCredentialStore,
): Promise<void> {
  if (target.backend === 'keychain') {
    await store.delete(target.service, target.account);
  } else {
    await unlinkIfPresent(operations, target.credentialPath);
  }
}

/**
 * Release detached native credential material. Valid metadata survives process
 * restart, so stale cleanup needs no in-memory lease state.
 * @param request - Session directory and deterministic fallback target.
 * @param operations - Filesystem operations used for target cleanup.
 * @param store - Keychain store used for macOS reconciliation.
 */
export async function releaseClaudeCodeNativeCredentialLease(
  request: ClaudeCodeNativeCredentialLeaseReleaseRequest,
  operations: ClaudeCodeFilesystemCredentialOperations,
  store: ClaudeCodeKeychainCredentialStore,
): Promise<void> {
  const metadataResult = await readCredentialLeaseMetadata(request.sessionDir);
  const failures: string[] = [];
  if (metadataResult.status === 'invalid' || metadataResult.status === 'unreadable') {
    failures.push(`metadata-${metadataResult.status}`);
  }

  const metadata = metadataResult.status === 'valid' ? metadataResult.metadata : undefined;
  if (metadata?.backend === 'keychain' && isKeychainCredentialLeaseForSession(metadata, request.sessionDir)) {
    try {
      await reconcileKeychainLease(metadata, store);
    } catch {
      failures.push('keychain-reconcile');
    }
    try {
      await store.delete(metadata.target.service, metadata.target.account);
    } catch {
      failures.push('keychain-target-cleanup');
    }
  } else if (
    metadata?.backend === 'filesystem-copy' &&
    isFilesystemCredentialLeaseForSession(metadata, request.sessionDir)
  ) {
    try {
      await reconcileFilesystemLease(metadata);
    } catch {
      failures.push('filesystem-reconcile');
    }
    try {
      await unlinkIfPresent(operations, metadata.target.credentialPath);
    } catch {
      failures.push('filesystem-target-cleanup');
    }
  } else {
    if (metadata !== undefined) failures.push('metadata-identity');
    try {
      await cleanFallbackTarget(request.fallbackTarget, operations, store);
    } catch {
      failures.push('fallback-target-cleanup');
    }
  }

  try {
    await removeCredentialLeaseMetadata(request.sessionDir);
  } catch {
    failures.push('metadata-cleanup');
  }
  if (failures.length > 0) throw createLifecycleError('teardown', failures);
}

/**
 * Prepare a Keychain clone and its compare-and-swap generation metadata.
 * @param request - Session, source, target, and account identities.
 * @param operations - Filesystem operations for stale cross-backend cleanup.
 * @param store - Keychain credential store.
 * @returns Whether a canonical source credential was materialized.
 */
export async function prepareClaudeCodeKeychainCredentialLease(
  request: ClaudeCodeKeychainCredentialLeasePreparationRequest,
  operations: ClaudeCodeFilesystemCredentialOperations,
  store: ClaudeCodeKeychainCredentialStore,
): Promise<boolean> {
  try {
    await releaseClaudeCodeNativeCredentialLease(
      {
        sessionDir: request.sessionDir,
        fallbackTarget: { backend: 'keychain', service: request.targetService, account: request.account },
      },
      operations,
      store,
    );
  } catch {
    throw createLifecycleError('setup', ['previous-lease-cleanup']);
  }

  try {
    return await withCredentialSourceLock(request.sourceConfigDir, async () => {
      let credential: string | null;
      try {
        credential = await store.read(request.sourceService, request.account);
      } catch {
        throw createLifecycleError('setup', ['keychain-source-read']);
      }
      if (credential === null) return false;

      const generation = digestCredential(credential);
      try {
        await writeCredentialLeaseMetadata(request.sessionDir, {
          version: 1,
          backend: 'keychain',
          source: {
            service: request.sourceService,
            account: request.account,
            configDir: path.resolve(request.sourceConfigDir),
            identity: request.sourceIdentity,
            generation,
          },
          target: {
            service: request.targetService,
            account: request.account,
            configDir: path.resolve(request.sessionDir),
            initialDigest: generation,
          },
        });
      } catch {
        throw createLifecycleError('setup', ['metadata-write']);
      }

      try {
        await store.write(request.targetService, request.account, credential);
      } catch {
        const failures = ['keychain-target-write'];
        try {
          await store.delete(request.targetService, request.account);
        } catch {
          failures.push('keychain-target-cleanup');
        }
        try {
          await removeCredentialLeaseMetadata(request.sessionDir);
        } catch {
          failures.push('metadata-cleanup');
        }
        throw createLifecycleError('setup', failures);
      }
      return true;
    });
  } catch (error) {
    if (error instanceof NativeCredentialSourceLockError || error instanceof AggregateError) {
      throw createLifecycleError('setup', ['source-lock']);
    }
    throw error;
  }
}

/**
 * Copy filesystem credentials while holding the canonical source lock, then
 * record compare-and-swap generation metadata.
 * @param request - Session, canonical source, and detached target paths.
 * @param operations - Filesystem operations used for failure cleanup.
 * @returns Whether the canonical source existed and was copied.
 */
export async function prepareClaudeCodeFilesystemCredentialLease(
  request: ClaudeCodeFilesystemCredentialLeasePreparationRequest,
  operations: ClaudeCodeFilesystemCredentialOperations,
): Promise<boolean> {
  const sourceCredentialPath = path.resolve(request.sourceCredentialPath);
  const targetCredentialPath = path.resolve(request.targetCredentialPath);
  try {
    const copied = await withCredentialSourceLock(path.dirname(sourceCredentialPath), async () => {
      try {
        await operations.copyFile(sourceCredentialPath, targetCredentialPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      await operations.stat(targetCredentialPath);
      const copiedCredential = await fs.readFile(targetCredentialPath, 'utf-8');
      const initialDigest = digestCredential(copiedCredential);
      await writeCredentialLeaseMetadata(request.sessionDir, {
        version: 1,
        backend: 'filesystem-copy',
        source: { credentialPath: sourceCredentialPath, generation: initialDigest },
        target: { credentialPath: targetCredentialPath, initialDigest },
      });
      return true;
    });
    if (copied) return true;

    await unlinkIfPresent(operations, targetCredentialPath);
    await removeCredentialLeaseMetadata(request.sessionDir);
    return false;
  } catch {
    const failures = ['filesystem-copy'];
    try {
      await unlinkIfPresent(operations, targetCredentialPath);
    } catch {
      failures.push('filesystem-target-cleanup');
    }
    try {
      await removeCredentialLeaseMetadata(request.sessionDir);
    } catch {
      failures.push('metadata-cleanup');
    }
    throw createLifecycleError('setup', failures);
  }
}
