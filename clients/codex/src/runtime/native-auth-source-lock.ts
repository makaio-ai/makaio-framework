/**
 * Canonical Codex native-auth identity and source-lock primitives.
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { lock as acquireFileLock } from 'proper-lockfile';
import { mergeNativeAuthErrors, sanitizedNativeAuthError } from './native-auth-errors.js';

/** Secret-free cross-process lock-directory suffix beside canonical CODEX_HOME. */
export const CODEX_AUTH_CAS_LOCK_FILE = '.makaio-codex-auth-cas.lock';

/** Lock finalization failed after the guarded native-auth operation committed. */
export class CodexNativeAuthSourceLockFinalizationError extends Error {
  public constructor() {
    super('Codex native-auth source lock is uncertain after committed operation');
    this.name = 'CodexNativeAuthSourceLockFinalizationError';
  }
}

/** Result retaining a committed operation across lock-finalization failure. */
export interface CodexNativeAuthSourceLockExecution<T> {
  /** Guarded operation result. */
  readonly value: T;
  /** Whether the source lock released without compromise or cleanup failure. */
  readonly coordination: 'released' | 'uncertain';
}

/** Lock freshness and retry policy shared by every Codex native-auth CAS. */
const CODEX_AUTH_CAS_LOCK_OPTIONS = {
  stale: 30_000,
  update: 10_000,
  retries: { retries: 50, factor: 1, minTimeout: 20, maxTimeout: 100 },
} as const;

/** Canonical CODEX_HOME identity used by both file and keyring stores. */
export interface CodexAuthHomeIdentity {
  /** Canonical absolute CODEX_HOME path. */
  readonly canonicalPath: string;
  /** Codex keyring account derived from {@link canonicalPath}. */
  readonly keyringAccount: string;
}

/** Result of inspecting a lease target without following an unsafe final symlink. */
export type CodexLeaseTargetInspection =
  | { readonly status: 'safe'; readonly identity: CodexAuthHomeIdentity }
  | { readonly status: 'missing' | 'unsafe'; readonly fallbackIdentity: CodexAuthHomeIdentity };

/**
 * Build Codex 0.130's keyring account for a CODEX_HOME.
 * @param codexHome - CODEX_HOME path; canonicalized when it exists.
 * @returns `cli|` followed by the first 16 hex characters of the path digest.
 */
export async function buildCodexAuthKeyringAccount(codexHome: string): Promise<string> {
  return (await identifyCodexAuthHome(codexHome)).keyringAccount;
}

/**
 * Resolve the canonical identity shared by Codex file and keyring auth stores.
 * @param codexHome - CODEX_HOME path.
 * @returns Canonical path plus Codex's derived keyring account.
 */
export async function identifyCodexAuthHome(codexHome: string): Promise<CodexAuthHomeIdentity> {
  return createCodexAuthHomeIdentity(await canonicalizeCodexHome(codexHome));
}

/**
 * Derive a cleanup-only identity from the normalized input path.
 *
 * This deliberately performs no `realpath` lookup. A lease directory may have
 * disappeared or been replaced by a symlink before restart cleanup; following
 * that new target could delete an unrelated canonical keyring credential.
 * @param codexHome - Original lease CODEX_HOME path.
 * @returns Lexically normalized identity safe for conservative keyring cleanup.
 */
export function identifyCodexAuthHomeLexically(codexHome: string): CodexAuthHomeIdentity {
  return createCodexAuthHomeIdentity(path.resolve(codexHome));
}

/**
 * Inspect a lease target while rejecting a symlink or non-directory final path.
 * @param codexHome - Isolated lease CODEX_HOME path.
 * @returns Stable canonical identity, or a cleanup-only lexical fallback.
 */
export async function inspectCodexLeaseTarget(codexHome: string): Promise<CodexLeaseTargetInspection> {
  const fallbackIdentity = identifyCodexAuthHomeLexically(codexHome);
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(codexHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', fallbackIdentity };
    }
    throw sanitizedNativeAuthError('lease target inspection', error);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    return { status: 'unsafe', fallbackIdentity };
  }

  const identity = await identifyCodexAuthHome(codexHome);
  let after: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    after = await fs.lstat(codexHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'unsafe', fallbackIdentity };
    }
    throw sanitizedNativeAuthError('lease target verification', error);
  }
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    return { status: 'unsafe', fallbackIdentity };
  }
  return { status: 'safe', identity };
}

/**
 * Serialize one canonical Codex native-auth mutation by CODEX_HOME.
 *
 * Account integrations and session-lease compare-and-swap operations must use
 * this same lock so a lease cannot overwrite a concurrently selected account.
 * @param codexHome - Canonical Codex config home whose auth source is mutated.
 * @param operation - Source operation that must retain exclusive ownership.
 * @returns Operation result after the source lock is released.
 */
export async function withCodexNativeAuthSourceLock<T>(codexHome: string, operation: () => Promise<T>): Promise<T> {
  const result = await executeCodexNativeAuthSourceLock(codexHome, operation);
  if (result.coordination === 'uncertain') throw new CodexNativeAuthSourceLockFinalizationError();
  return result.value;
}

/**
 * Execute against one CODEX_HOME while preserving committed operation results
 * when lock finalization becomes uncertain.
 * @param codexHome - Canonical Codex config home.
 * @param operation - Native-auth operation guarded by the source lock.
 * @returns Operation value plus released/uncertain coordination state.
 */
export async function executeCodexNativeAuthSourceLock<T>(
  codexHome: string,
  operation: () => Promise<T>,
): Promise<CodexNativeAuthSourceLockExecution<T>> {
  return executeIdentifiedCodexNativeAuthSourceLock(await identifyCodexAuthHome(codexHome), operation);
}

/**
 * Serialize one operation against an already-pinned Codex auth identity.
 * @param identity - Canonical source CODEX_HOME identity.
 * @param operation - Source operation that must retain exclusive ownership.
 * @returns Operation result after the source lock is released.
 */
export async function withIdentifiedCodexNativeAuthSourceLock<T>(
  identity: CodexAuthHomeIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await executeIdentifiedCodexNativeAuthSourceLock(identity, operation);
  if (result.coordination === 'uncertain') throw new CodexNativeAuthSourceLockFinalizationError();
  return result.value;
}

/**
 * Execute against an already-pinned identity and retain post-commit lock state.
 * @param identity - Canonical source CODEX_HOME identity.
 * @param operation - Native-auth operation guarded by the source lock.
 * @returns Operation value plus released/uncertain coordination state.
 */
export async function executeIdentifiedCodexNativeAuthSourceLock<T>(
  identity: CodexAuthHomeIdentity,
  operation: () => Promise<T>,
): Promise<CodexNativeAuthSourceLockExecution<T>> {
  const inspection = await inspectCodexLeaseTarget(identity.canonicalPath);
  if (!inspectionMatchesIdentity(inspection, identity)) {
    throw new Error('Codex native-auth source identity is no longer a stable directory');
  }

  let compromisedError: Error | undefined;
  let release: () => Promise<void>;
  try {
    release = await acquireFileLock(identity.canonicalPath, {
      realpath: false,
      lockfilePath: buildCodexNativeAuthSourceLockPath(identity.canonicalPath),
      ...CODEX_AUTH_CAS_LOCK_OPTIONS,
      onCompromised: (error) => {
        compromisedError = sanitizedNativeAuthError('source lock compromised', error);
      },
    });
  } catch (error) {
    throw sanitizedNativeAuthError('source lock acquisition', error);
  }

  let outcome:
    | { readonly status: 'fulfilled'; readonly value: T }
    | { readonly status: 'rejected'; readonly reason: unknown };
  if (compromisedError !== undefined) {
    outcome = { status: 'rejected', reason: compromisedError };
  } else {
    try {
      const lockedInspection = await inspectCodexLeaseTarget(identity.canonicalPath);
      if (!inspectionMatchesIdentity(lockedInspection, identity)) {
        throw new Error('Codex native-auth source identity changed before operation');
      }
      outcome = { status: 'fulfilled', value: await operation() };
    } catch (reason) {
      outcome = { status: 'rejected', reason };
    }
  }
  let releaseError: Error | undefined;
  try {
    await release();
  } catch (error) {
    releaseError = sanitizedNativeAuthError('source lock release', error);
  }
  if (outcome.status === 'rejected') {
    let operationError = outcome.reason;
    if (compromisedError !== undefined && operationError !== compromisedError) {
      operationError = mergeNativeAuthErrors(
        operationError,
        compromisedError,
        'Codex native-auth operation and source lock compromise both failed',
      );
    }
    if (releaseError !== undefined) {
      operationError = mergeNativeAuthErrors(
        operationError,
        releaseError,
        'Codex native-auth operation and source lock release both failed',
      );
    }
    throw operationError;
  }
  return {
    value: outcome.value,
    coordination: compromisedError !== undefined || releaseError !== undefined ? 'uncertain' : 'released',
  };
}

/**
 * Build a sibling lock anchor that survives CODEX_HOME rename/replacement.
 * @param canonicalPath - Canonical CODEX_HOME path.
 * @returns Secret-free sibling lock directory path.
 */
export function buildCodexNativeAuthSourceLockPath(canonicalPath: string): string {
  return `${canonicalPath}${CODEX_AUTH_CAS_LOCK_FILE}`;
}

/**
 * Verify a present or absent source still represents the pinned lexical identity.
 * @param inspection - Current safety inspection for the source path.
 * @param identity - Identity pinned before lock acquisition.
 * @returns Whether the inspected path still represents the pinned identity.
 */
function inspectionMatchesIdentity(inspection: CodexLeaseTargetInspection, identity: CodexAuthHomeIdentity): boolean {
  if (inspection.status === 'unsafe') return false;
  const inspectedIdentity = inspection.status === 'safe' ? inspection.identity : inspection.fallbackIdentity;
  return (
    inspectedIdentity.canonicalPath === identity.canonicalPath &&
    inspectedIdentity.keyringAccount === identity.keyringAccount
  );
}

/**
 * Build the exact Codex keyring identity for one already-normalized path.
 * @param canonicalPath - Canonical or deliberately lexical absolute path.
 * @returns Path plus `cli|sha256(path).slice(0, 16)` account.
 */
function createCodexAuthHomeIdentity(canonicalPath: string): CodexAuthHomeIdentity {
  return {
    canonicalPath,
    keyringAccount: `cli|${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16)}`,
  };
}

/**
 * Canonicalize CODEX_HOME exactly as Codex does, falling back when absent.
 * @param codexHome - Candidate CODEX_HOME path.
 * @returns Canonical path, or the absolute input path when absent.
 */
async function canonicalizeCodexHome(codexHome: string): Promise<string> {
  try {
    return await fs.realpath(codexHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(codexHome);
    throw sanitizedNativeAuthError('CODEX_HOME canonicalization', error);
  }
}
