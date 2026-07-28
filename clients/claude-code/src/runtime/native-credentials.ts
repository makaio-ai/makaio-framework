import * as os from 'node:os';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { keychainDelete, keychainRead, keychainWrite } from '@makaio/utils/keychain';
import {
  type ClaudeCodeFilesystemCredentialOperations,
  type ClaudeCodeKeychainCredentialStore,
  prepareClaudeCodeFilesystemCredentialLease,
  prepareClaudeCodeKeychainCredentialLease,
  releaseClaudeCodeNativeCredentialLease,
} from './native-credential-lease.js';

export type {
  ClaudeCodeFilesystemCredentialOperations,
  ClaudeCodeKeychainCredentialStore,
} from './native-credential-lease.js';

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

/** Canonical secure-storage identity selected for a Claude Code config source. */
interface ClaudeCodeSecureStorageIdentity {
  /** Config directory that owns refresh coordination. */
  readonly configDir: string;
  /** Whether the Keychain service is global or config-directory scoped. */
  readonly identity: 'global' | 'scoped';
  /** Exact Keychain service used by Claude Code. */
  readonly service: string;
}

/** Claude Code's Keychain service suffix for OAuth credentials. */
const CLAUDE_CODE_CREDENTIALS_SUFFIX = '-credentials';

/** Fallback account used by Claude Code when the OS username is unavailable or unsafe. */
const CLAUDE_CODE_FALLBACK_KEYCHAIN_ACCOUNT = 'claude-code-user';

/** Account syntax accepted by Claude Code before addressing macOS Keychain. */
const CLAUDE_CODE_KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

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
 *
 * Exported because a session lease must publish the account it wrote under.
 * The `claude` binary resolves this account from `USER` alone and has no
 * `os.userInfo()` fallback when reading an isolated credential store, so a
 * lease that materializes credentials without also publishing the account
 * produces an entry the binary cannot find.
 * @returns OS account name used for the Keychain entry.
 */
export function resolveKeychainAccount(): string {
  let account: string;
  try {
    account = process.env.USER || os.userInfo().username;
  } catch {
    account = CLAUDE_CODE_FALLBACK_KEYCHAIN_ACCOUNT;
  }
  return CLAUDE_CODE_KEYCHAIN_ACCOUNT_PATTERN.test(account) ? account : CLAUDE_CODE_FALLBACK_KEYCHAIN_ACCOUNT;
}

/**
 * Resolve the native config directory Claude Code uses when no isolated
 * profile is supplied.
 * @returns Absolute native Claude Code config directory.
 */
function resolveNativeClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return configured === undefined ? path.join(os.homedir(), '.claude') : path.resolve(configured);
}

/**
 * Resolve the canonical secure-storage identity selected by Claude Code.
 *
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` has precedence over `CLAUDE_CONFIG_DIR`.
 * Its empty-string value deliberately selects the unsuffixed global Keychain
 * entry while retaining the default config home as the refresh lock owner.
 * @param sourceConfigDir - Source selected by the client profile/session seam.
 * @returns Exact source config directory, service, and identity scope.
 */
function resolveCanonicalSecureStorageIdentity(sourceConfigDir: string): ClaudeCodeSecureStorageIdentity {
  const resolvedSourceConfigDir = path.resolve(sourceConfigDir);
  const nativeConfigDir = resolveNativeClaudeConfigDir();
  if (resolvedSourceConfigDir !== nativeConfigDir) {
    return {
      configDir: resolvedSourceConfigDir,
      identity: 'global',
      service: buildClaudeCodeCredentialsKeychainService(),
    };
  }

  const secureStorageConfigDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureStorageConfigDir !== undefined) {
    if (secureStorageConfigDir === '') {
      const configDir = path.join(os.homedir(), '.claude');
      return { configDir, identity: 'global', service: buildClaudeCodeCredentialsKeychainService() };
    }
    const configDir = path.resolve(secureStorageConfigDir);
    return { configDir, identity: 'scoped', service: buildClaudeCodeCredentialsKeychainService(configDir) };
  }

  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    const configDir = path.resolve(process.env.CLAUDE_CONFIG_DIR);
    return { configDir, identity: 'scoped', service: buildClaudeCodeCredentialsKeychainService(configDir) };
  }

  return {
    configDir: resolvedSourceConfigDir,
    identity: 'global',
    service: buildClaudeCodeCredentialsKeychainService(),
  };
}

/**
 * Link or copy filesystem-backed Claude Code credentials into a session dir.
 *
 * Claude Code stores credentials in `.credentials.json` on Linux/Windows. The
 * source file is symlinked so token rotations remain visible to the session;
 * Windows permission failures fall back to a detached copy whose refresh is
 * reconciled through lease metadata at teardown.
 * @param sourceConfigDir - Source Claude Code config directory.
 * @param sessionDir - Session-scoped Claude Code config directory.
 * @param platform - Host platform controlling symlink/copy behavior.
 * @param operations - Filesystem operations backing credential materialization.
 * @returns `true` when a credential was materialized in the session dir.
 */
async function inheritFilesystemCredentials(
  sourceConfigDir: string,
  sessionDir: string,
  platform: NodeJS.Platform,
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

  try {
    await operations.symlink(credSrc, credDst);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      return prepareClaudeCodeFilesystemCredentialLease(
        {
          sessionDir,
          sourceCredentialPath: credSrc,
          targetCredentialPath: credDst,
        },
        operations,
      );
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
 * boolean outcome so secrets do not become bus payloads or logs. Versioned
 * generation metadata enables refresh-safe teardown after a process restart.
 * @param sessionDir - Session-scoped Claude Code config directory.
 * @param store - Keychain credential store backing native macOS credentials.
 * @param sourceConfigDir - Canonical config directory that owns native credentials.
 * @returns Preparation result without credential material.
 */
export async function cloneClaudeCodeNativeCredentialsForSession(
  sessionDir: string,
  store: ClaudeCodeKeychainCredentialStore = nativeKeychainCredentialStore,
  sourceConfigDir: string = resolveNativeClaudeConfigDir(),
): Promise<ClaudeCodeNativeCredentialPreparationResult> {
  const account = resolveKeychainAccount();
  const sourceIdentity = resolveCanonicalSecureStorageIdentity(sourceConfigDir);
  const targetService = buildClaudeCodeCredentialsKeychainService(sessionDir);
  const prepared = await prepareClaudeCodeKeychainCredentialLease(
    {
      sessionDir,
      sourceService: sourceIdentity.service,
      sourceConfigDir: sourceIdentity.configDir,
      sourceIdentity: sourceIdentity.identity,
      targetService,
      account,
    },
    nodeCredentialFilesystemOperations,
    store,
  );
  return prepared ? { prepared: true } : { prepared: false, reason: 'source-missing' };
}

/**
 * Reconcile and remove the isolated session's Claude Code Keychain service.
 * @param sessionDir - Session-scoped Claude Code config directory.
 * @param store - Keychain credential store backing native macOS credentials.
 */
export async function removeClaudeCodeNativeCredentialsForSession(
  sessionDir: string,
  store: ClaudeCodeKeychainCredentialStore = nativeKeychainCredentialStore,
): Promise<void> {
  await releaseClaudeCodeNativeCredentialLease(
    {
      sessionDir,
      fallbackTarget: {
        backend: 'keychain',
        service: buildClaudeCodeCredentialsKeychainService(sessionDir),
        account: resolveKeychainAccount(),
      },
    },
    nodeCredentialFilesystemOperations,
    store,
  );
}

/**
 * Inherit Claude Code native credentials into a session config directory.
 *
 * On macOS this clones the Keychain entry to the service name Claude Code
 * derives from its secure-storage config identity; on Linux/Windows it
 * materializes the `.credentials.json` path expected under the session dir.
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
    return cloneClaudeCodeNativeCredentialsForSession(request.sessionDir, store, request.sourceConfigDir);
  }
  const sourceIdentity = resolveCanonicalSecureStorageIdentity(request.sourceConfigDir);
  const sourceCredentialPath = path.resolve(sourceIdentity.configDir, '.credentials.json');
  const targetCredentialPath = path.resolve(request.sessionDir, '.credentials.json');
  if (sourceCredentialPath !== targetCredentialPath) {
    await releaseClaudeCodeNativeCredentialLease(
      {
        sessionDir: request.sessionDir,
        fallbackTarget: { backend: 'filesystem', credentialPath: targetCredentialPath },
      },
      operations,
      store,
    );
  }
  let materialized: boolean;
  try {
    materialized = await inheritFilesystemCredentials(
      sourceIdentity.configDir,
      request.sessionDir,
      request.platform,
      operations,
    );
  } catch {
    throw new Error('Claude Code native credential setup failed (filesystem-materialization)');
  }
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
  const fallbackTarget =
    request.platform === 'darwin'
      ? {
          backend: 'keychain' as const,
          service: buildClaudeCodeCredentialsKeychainService(request.sessionDir),
          account: resolveKeychainAccount(),
        }
      : {
          backend: 'filesystem' as const,
          credentialPath: path.join(request.sessionDir, '.credentials.json'),
        };
  await releaseClaudeCodeNativeCredentialLease({ sessionDir: request.sessionDir, fallbackTarget }, operations, store);
}
