import * as os from 'node:os';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { keychainDelete, keychainRead, keychainWrite } from '@makaio/utils/keychain';

/** Result returned by native session credential preparation helpers. */
export interface ClaudeCodeNativeCredentialPreparationResult {
  /** Whether a session-scoped credential entry was materialized. */
  prepared: boolean;
  /** Stable reason when no session credential was materialized. */
  reason?: 'source-missing';
}

/** Request for inheriting Claude Code credentials into a session config dir. */
export interface ClaudeCodeNativeCredentialInheritanceRequest {
  /** Source Claude Code config directory for filesystem-backed credentials. */
  sourceConfigDir: string;
  /** Session-scoped Claude Code config directory. */
  sessionDir: string;
  /** Host platform that determines Claude Code's credential backend. */
  platform: NodeJS.Platform;
}

/** Request for clearing credentials owned by a session config dir. */
export interface ClaudeCodeNativeCredentialClearRequest {
  /** Session-scoped Claude Code config directory. */
  sessionDir: string;
  /** Host platform that determines Claude Code's credential backend. */
  platform: NodeJS.Platform;
}

/** Filesystem operations used to materialize filesystem-backed credentials. */
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

/** Claude Code's Keychain service suffix for OAuth credentials. */
const CLAUDE_CODE_CREDENTIALS_SUFFIX = '-credentials';

/** Node filesystem implementation used in production. */
const nodeCredentialFilesystemOperations: ClaudeCodeFilesystemCredentialOperations = {
  access: fs.access,
  copyFile: fs.copyFile,
  stat: fs.stat,
  symlink: fs.symlink,
  unlink: fs.unlink,
};

/** Native macOS Keychain implementation used in production. */
const nativeKeychainCredentialStore: ClaudeCodeKeychainCredentialStore = {
  read: keychainRead,
  write: keychainWrite,
  delete: keychainDelete,
};

/**
 * Remove a session-owned credential file or symlink if present.
 * @param operations - Filesystem operations backing credential materialization.
 * @param credentialPath - `.credentials.json` path inside the session config dir.
 */
async function unlinkCredentialIfPresent(
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
 * Resolve the OAuth environment suffix that Claude Code includes in Keychain
 * service names.
 * @returns Claude Code OAuth service-name suffix for the current environment.
 */
function resolveClaudeCodeOAuthServiceSuffix(): string {
  return process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
}

/**
 * Build Claude Code's macOS Keychain service name for OAuth credentials.
 *
 * Claude Code appends the first eight hex characters of
 * `sha256(CLAUDE_CONFIG_DIR.normalize('NFC'))` when a config directory is
 * supplied. The unsuffixed service name is the native global credential entry.
 * @param configDir - Config directory associated with the credential entry.
 *   Omit for the native, non-isolated service name.
 * @returns Keychain service name used by Claude Code.
 */
export function buildClaudeCodeCredentialsKeychainService(configDir?: string): string {
  const configHash =
    configDir === undefined
      ? ''
      : `-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').substring(0, 8)}`;
  return `Claude Code${resolveClaudeCodeOAuthServiceSuffix()}${CLAUDE_CODE_CREDENTIALS_SUFFIX}${configHash}`;
}

/**
 * Resolve the Keychain account name Claude Code uses for credential storage.
 * @returns OS account name used for the Keychain entry.
 */
function resolveKeychainAccount(): string {
  return process.env.USER || os.userInfo().username;
}

/**
 * Link or copy filesystem-backed Claude Code credentials into a session dir.
 *
 * Claude Code stores credentials in `.credentials.json` on Linux/Windows. The
 * source file is symlinked so token rotations remain visible to the session;
 * Windows permission failures fall back to a one-time copy.
 * @param sourceConfigDir - Source Claude Code config directory.
 * @param sessionDir - Session-scoped Claude Code config directory.
 * @param operations - Filesystem operations backing credential materialization.
 * @returns `true` when a credential was materialized in the session dir.
 */
async function inheritFilesystemCredentials(
  sourceConfigDir: string,
  sessionDir: string,
  operations: ClaudeCodeFilesystemCredentialOperations,
): Promise<boolean> {
  const credSrc = path.join(sourceConfigDir, '.credentials.json');
  const credDst = path.join(sessionDir, '.credentials.json');
  const isSourceAlreadySessionCredential = path.resolve(credSrc) === path.resolve(credDst);

  try {
    await operations.access(credSrc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!isSourceAlreadySessionCredential) {
        await unlinkCredentialIfPresent(operations, credDst);
      }
      return false;
    }
    throw error;
  }

  if (isSourceAlreadySessionCredential) {
    return true;
  }

  await unlinkCredentialIfPresent(operations, credDst);
  try {
    await operations.symlink(credSrc, credDst);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      try {
        await operations.copyFile(credSrc, credDst);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw copyError;
      }
    } else if (code === 'ENOENT') {
      return false;
    } else {
      throw error;
    }
  }
  // Verify the symlink target actually exists (POSIX symlink succeeds even
  // for absent targets; the dangling link is not a usable credential).
  try {
    await operations.stat(credDst);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await unlinkCredentialIfPresent(operations, credDst);
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Clone native Claude Code macOS Keychain credentials into the isolated
 * session's hashed Keychain service name.
 *
 * The credential value is read and written locally; callers receive only a
 * boolean outcome so secrets do not become bus payloads or logs.
 * @param sessionDir - Session-scoped Claude Code config directory.
 * @param store - Keychain credential store backing native macOS credentials.
 * @returns Preparation result without credential material.
 */
export async function cloneClaudeCodeNativeCredentialsForSession(
  sessionDir: string,
  store: ClaudeCodeKeychainCredentialStore = nativeKeychainCredentialStore,
): Promise<ClaudeCodeNativeCredentialPreparationResult> {
  const account = resolveKeychainAccount();
  const sourceService = buildClaudeCodeCredentialsKeychainService();
  const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
  const credential = await store.read(sourceService, account);
  if (credential === null) {
    await store.delete(targetService, account);
    return { prepared: false, reason: 'source-missing' };
  }
  await store.write(targetService, account, credential);
  return { prepared: true };
}

/**
 * Remove the isolated session's hashed Claude Code Keychain service.
 * @param sessionDir - Session-scoped Claude Code config directory.
 * @param store - Keychain credential store backing native macOS credentials.
 */
export async function removeClaudeCodeNativeCredentialsForSession(
  sessionDir: string,
  store: ClaudeCodeKeychainCredentialStore = nativeKeychainCredentialStore,
): Promise<void> {
  await store.delete(buildClaudeCodeCredentialsKeychainService(sessionDir), resolveKeychainAccount());
}

/**
 * Inherit Claude Code native credentials into a session config directory.
 *
 * On macOS this clones the Keychain entry to the service name Claude Code
 * derives from `CLAUDE_CONFIG_DIR`; on Linux/Windows it materializes the
 * `.credentials.json` path expected under the session config dir.
 * @param request - Source, destination, and platform context.
 * @param operations - Filesystem operations used for non-macOS materialization.
 * @param store - Keychain credential store backing native macOS credentials.
 * @returns Preparation result without credential material.
 */
export async function inheritClaudeCodeNativeCredentialsForSession(
  request: ClaudeCodeNativeCredentialInheritanceRequest,
  operations: ClaudeCodeFilesystemCredentialOperations = nodeCredentialFilesystemOperations,
  store: ClaudeCodeKeychainCredentialStore = nativeKeychainCredentialStore,
): Promise<ClaudeCodeNativeCredentialPreparationResult> {
  if (request.platform === 'darwin') {
    return cloneClaudeCodeNativeCredentialsForSession(request.sessionDir, store);
  }
  const materialized = await inheritFilesystemCredentials(request.sourceConfigDir, request.sessionDir, operations);
  return materialized ? { prepared: true } : { prepared: false, reason: 'source-missing' };
}

/**
 * Clear Claude Code native credentials owned by a session config directory.
 * @param request - Session config dir and platform context.
 * @param operations - Filesystem operations used for non-macOS cleanup.
 * @param store - Keychain credential store backing native macOS credentials.
 */
export async function clearClaudeCodeNativeCredentialsForSession(
  request: ClaudeCodeNativeCredentialClearRequest,
  operations: ClaudeCodeFilesystemCredentialOperations = nodeCredentialFilesystemOperations,
  store: ClaudeCodeKeychainCredentialStore = nativeKeychainCredentialStore,
): Promise<void> {
  if (request.platform === 'darwin') {
    await removeClaudeCodeNativeCredentialsForSession(request.sessionDir, store);
    return;
  }
  await unlinkCredentialIfPresent(operations, path.join(request.sessionDir, '.credentials.json'));
}
