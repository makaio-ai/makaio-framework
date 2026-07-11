/**
 * Codex native authentication storage primitives.
 *
 * Mirrors Codex App Server 0.130's `file`, `keyring`, and `auto` credential
 * store semantics without interpreting credential payloads. Credential values
 * remain inside this client-owned runtime boundary; the only persisted lease
 * state contains store identities and SHA-256 digests.
 * @packageDocumentation
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { z } from 'zod';
import { mergeNativeAuthErrors, sanitizedNativeAuthError } from './native-auth-errors.js';
import { nativeKeyringCredentialStore, type CodexKeyringCredentialStore } from './native-keyring-credential-store.js';
import { withIdentifiedCodexNativeAuthSourceLock, type CodexAuthHomeIdentity } from './native-auth-source-lock.js';

export {
  CODEX_AUTH_CAS_LOCK_FILE,
  buildCodexAuthKeyringAccount,
  buildCodexNativeAuthSourceLockPath,
  executeCodexNativeAuthSourceLock,
  identifyCodexAuthHome,
  identifyCodexAuthHomeLexically,
  inspectCodexLeaseTarget,
  withCodexNativeAuthSourceLock,
} from './native-auth-source-lock.js';
export type { CodexAuthHomeIdentity, CodexLeaseTargetInspection } from './native-auth-source-lock.js';

/** Codex 0.130's native CLI credential store configuration values. */
export type CodexAuthStoreMode = 'file' | 'keyring' | 'auto';

/** Concrete store that contained a credential at one point in the lease. */
export type CodexAuthStoreBackend = 'file' | 'keyring';

/** Codex's fixed keyring service name for CLI authentication. */
export const CODEX_AUTH_KEYRING_SERVICE = 'Codex Auth';

/** Non-secret lease metadata file stored inside the isolated CODEX_HOME. */
export const CODEX_AUTH_LEASE_METADATA_FILE = '.makaio-codex-auth-lease.json';

/** Result of resolving Codex's effective credential store. */
export interface CodexEffectiveCredentialRead {
  /** Credential and concrete backend, or `null` when no native auth exists. */
  readonly credential: { readonly backend: CodexAuthStoreBackend; readonly value: string } | null;
  /** Whether an `auto` read fell back because the keyring was unavailable. */
  readonly keyringUnavailable: boolean;
}

const CodexAuthHomeIdentitySchema = z
  .object({
    canonicalPath: z.string().refine((value) => path.isAbsolute(value), 'Expected an absolute path'),
    keyringAccount: z.string().regex(/^cli\|[0-9a-f]{16}$/),
  })
  .strict()
  .superRefine((identity, ctx) => {
    const expected = `cli|${createHash('sha256').update(identity.canonicalPath).digest('hex').slice(0, 16)}`;
    if (identity.keyringAccount !== expected) {
      ctx.addIssue({ code: 'custom', message: 'Keyring account does not match canonical CODEX_HOME' });
    }
  });

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Strict schema for the secret-free native auth lease generation. */
export const CodexAuthLeaseMetadataSchema = z
  .object({
    version: z.literal(1),
    backend: z
      .object({
        configured: z.enum(['none', 'file', 'keyring', 'auto']),
        effective: z.enum(['none', 'file', 'keyring']),
      })
      .strict(),
    canonicalIdentity: CodexAuthHomeIdentitySchema.nullable(),
    targetIdentity: CodexAuthHomeIdentitySchema,
    sourceGenerationDigest: DigestSchema.nullable(),
    initialTargetDigest: DigestSchema.nullable(),
  })
  .strict()
  .superRefine((metadata, ctx) => {
    const materialized = metadata.backend.effective !== 'none';
    const completeGeneration =
      metadata.canonicalIdentity !== null &&
      metadata.sourceGenerationDigest !== null &&
      metadata.initialTargetDigest !== null;
    if (materialized !== completeGeneration) {
      ctx.addIssue({ code: 'custom', message: 'Materialized metadata must carry one complete generation' });
    }
    if (
      metadata.sourceGenerationDigest !== null &&
      metadata.initialTargetDigest !== null &&
      metadata.sourceGenerationDigest !== metadata.initialTargetDigest
    ) {
      ctx.addIssue({ code: 'custom', message: 'The initial target generation must equal the source generation' });
    }
    if (metadata.backend.configured === 'none' && metadata.backend.effective !== 'none') {
      ctx.addIssue({ code: 'custom', message: 'An empty lease cannot materialize native authentication' });
    }
    if (metadata.backend.configured === 'file' && metadata.backend.effective === 'keyring') {
      ctx.addIssue({ code: 'custom', message: 'File mode cannot select keyring authentication' });
    }
    if (metadata.backend.configured === 'keyring' && metadata.backend.effective === 'file') {
      ctx.addIssue({ code: 'custom', message: 'Keyring mode cannot select file authentication' });
    }
  });

/** Secret-free native auth lease state. */
export type CodexAuthLeaseMetadata = z.infer<typeof CodexAuthLeaseMetadataSchema>;

/** Parsed metadata outcome used to distinguish safe absence from corruption. */
export type CodexAuthLeaseMetadataRead =
  | { readonly status: 'found'; readonly metadata: CodexAuthLeaseMetadata }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' };

/**
 * Compute a stable SHA-256 digest without interpreting the credential value.
 * @param value - Opaque credential payload.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function digestCodexCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Local native auth store used by the session config handler.
 */
export class CodexNativeAuthStore {
  /**
   * @param keyring - Cross-platform keyring implementation.
   */
  public constructor(private readonly keyring: CodexKeyringCredentialStore = nativeKeyringCredentialStore) {}

  /**
   * Resolve `cli_auth_credentials_store` from the canonical config.
   * Codex 0.130 defaults this setting to `file`.
   * @param identity - Canonical CODEX_HOME identity.
   * @returns Configured credential store mode.
   */
  public async resolveMode(identity: CodexAuthHomeIdentity): Promise<CodexAuthStoreMode> {
    const configPath = path.join(identity.canonicalPath, 'config.toml');
    const content = await readTextIfPresent(configPath, 'configuration read');
    if (content === null) return 'file';

    let parsed: Record<string, unknown>;
    try {
      parsed = parseTOML(content) as Record<string, unknown>;
    } catch {
      throw new Error('Codex native-auth configuration is invalid');
    }
    const configured = parsed['cli_auth_credentials_store'];
    if (configured === undefined) return 'file';
    if (configured === 'file' || configured === 'keyring' || configured === 'auto') return configured;
    throw new Error('Codex native-auth configuration selects an unsupported credential store');
  }

  /**
   * Load a credential using Codex 0.130's configured store order.
   * @param identity - Canonical CODEX_HOME identity.
   * @param mode - Configured store mode.
   * @returns Effective credential plus keyring-fallback status.
   */
  public async readEffective(
    identity: CodexAuthHomeIdentity,
    mode: CodexAuthStoreMode,
  ): Promise<CodexEffectiveCredentialRead> {
    if (mode === 'file') {
      return { credential: await this.readFileCredential(identity), keyringUnavailable: false };
    }
    if (mode === 'keyring') {
      return { credential: await this.readKeyringCredential(identity), keyringUnavailable: false };
    }

    try {
      const keyringCredential = await this.readKeyringCredential(identity);
      if (keyringCredential !== null) {
        return { credential: keyringCredential, keyringUnavailable: false };
      }
    } catch {
      return { credential: await this.readFileCredential(identity), keyringUnavailable: true };
    }
    return { credential: await this.readFileCredential(identity), keyringUnavailable: false };
  }

  /**
   * Read the credential generation that should be considered for lease refresh.
   *
   * `auto` normally prefers keyring. During a running process, however, a
   * transient keyring save failure can put a fresher generation in `auth.json`
   * while the unchanged keyring entry remains. Detect that exact fallback by
   * comparing both stores to the lease's initial generation.
   * @param identity - Isolated target CODEX_HOME identity.
   * @param mode - Configured store mode.
   * @param initialDigest - Digest materialized when the lease was created.
   * @returns Refresh candidate plus keyring availability status.
   */
  public async readRefreshCandidate(
    identity: CodexAuthHomeIdentity,
    mode: CodexAuthStoreMode,
    initialDigest: string,
  ): Promise<CodexEffectiveCredentialRead> {
    if (mode !== 'auto') return this.readEffective(identity, mode);

    let keyringCredential: { readonly backend: 'keyring'; readonly value: string } | null;
    try {
      keyringCredential = await this.readKeyringCredential(identity);
    } catch {
      return { credential: await this.readFileCredential(identity), keyringUnavailable: true };
    }
    const fileCredential = await this.readFileCredential(identity);
    if (keyringCredential !== null && digestCodexCredential(keyringCredential.value) !== initialDigest) {
      return { credential: keyringCredential, keyringUnavailable: false };
    }
    if (fileCredential !== null && digestCodexCredential(fileCredential.value) !== initialDigest) {
      return { credential: fileCredential, keyringUnavailable: false };
    }
    return { credential: keyringCredential ?? fileCredential, keyringUnavailable: false };
  }

  /**
   * Read one concrete backend without fallback.
   * @param identity - Canonical CODEX_HOME identity.
   * @param backend - Concrete store to read.
   * @returns Credential value, or `null` when absent.
   */
  public async readBackend(identity: CodexAuthHomeIdentity, backend: CodexAuthStoreBackend): Promise<string | null> {
    const result =
      backend === 'file' ? await this.readFileCredential(identity) : await this.readKeyringCredential(identity);
    return result?.value ?? null;
  }

  /**
   * Clone an opaque value into one concrete target backend.
   * @param identity - Target CODEX_HOME identity.
   * @param backend - Concrete target store.
   * @param value - Opaque credential payload.
   */
  public async writeBackend(
    identity: CodexAuthHomeIdentity,
    backend: CodexAuthStoreBackend,
    value: string,
  ): Promise<void> {
    if (backend === 'file') {
      await writePrivateFileAtomically(path.join(identity.canonicalPath, 'auth.json'), value);
      return;
    }
    await this.writeKeyring(identity, value);
    // Codex 0.130 treats the keyring save as successful even when removal of a
    // stale file fallback fails. In particular, `auto` must not reinterpret
    // that independent cleanup failure as a keyring failure and save to file.
    await removeFileIfPresent(path.join(identity.canonicalPath, 'auth.json'), 'credential fallback removal').catch(
      () => undefined,
    );
  }

  /**
   * Persist a refreshed credential using Codex 0.130's save semantics.
   * @param identity - Canonical CODEX_HOME identity.
   * @param mode - Configured store mode.
   * @param value - Refreshed opaque credential payload.
   */
  public async saveConfigured(identity: CodexAuthHomeIdentity, mode: CodexAuthStoreMode, value: string): Promise<void> {
    if (mode === 'file') {
      await this.writeBackend(identity, 'file', value);
      return;
    }
    if (mode === 'keyring') {
      await this.writeBackend(identity, 'keyring', value);
      return;
    }
    try {
      await this.writeBackend(identity, 'keyring', value);
    } catch {
      await this.writeBackend(identity, 'file', value);
    }
  }

  /**
   * Run a generation check and conditional write under one cross-process lock.
   * @param identity - Canonical source CODEX_HOME identity.
   * @param operation - CAS operation to execute while the lock is held.
   * @returns Operation result.
   */
  public async withSourceLock<T>(identity: CodexAuthHomeIdentity, operation: () => Promise<T>): Promise<T> {
    return withIdentifiedCodexNativeAuthSourceLock(identity, operation);
  }

  /**
   * Remove a target keyring credential.
   * @param identity - Target CODEX_HOME identity.
   */
  public async deleteKeyring(identity: CodexAuthHomeIdentity): Promise<void> {
    try {
      await this.keyring.delete(CODEX_AUTH_KEYRING_SERVICE, identity.keyringAccount);
    } catch (error) {
      throw sanitizedNativeAuthError('keyring cleanup', error);
    }
  }

  /**
   * Remove the file credential from a target CODEX_HOME.
   * @param identity - Target CODEX_HOME identity.
   */
  public async deleteFile(identity: CodexAuthHomeIdentity): Promise<void> {
    await removeFileIfPresent(path.join(identity.canonicalPath, 'auth.json'), 'credential cleanup');
  }

  /**
   * Atomically persist strict secret-free lease metadata with mode `0600`.
   * @param sessionDir - Isolated CODEX_HOME.
   * @param metadata - Validated metadata generation.
   */
  public async writeLeaseMetadata(sessionDir: string, metadata: CodexAuthLeaseMetadata): Promise<void> {
    const parsed = CodexAuthLeaseMetadataSchema.parse(metadata);
    await writePrivateFileAtomically(
      path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE),
      `${JSON.stringify(parsed)}\n`,
    );
  }

  /**
   * Read and strictly parse secret-free lease metadata.
   * @param sessionDir - Isolated CODEX_HOME.
   * @returns Found, missing, or invalid outcome without echoing file contents.
   */
  public async readLeaseMetadata(sessionDir: string): Promise<CodexAuthLeaseMetadataRead> {
    let content: string;
    try {
      content = await fs.readFile(path.join(sessionDir, CODEX_AUTH_LEASE_METADATA_FILE), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      throw sanitizedNativeAuthError('lease metadata read', error);
    }
    try {
      return { status: 'found', metadata: CodexAuthLeaseMetadataSchema.parse(JSON.parse(content)) };
    } catch {
      return { status: 'invalid' };
    }
  }

  /**
   * Read a file-backed credential.
   * @param identity - Canonical CODEX_HOME identity.
   * @returns Opaque file credential, or `null` when absent.
   */
  private async readFileCredential(
    identity: CodexAuthHomeIdentity,
  ): Promise<{ backend: 'file'; value: string } | null> {
    const value = await readTextIfPresent(path.join(identity.canonicalPath, 'auth.json'), 'credential file read');
    return value === null ? null : { backend: 'file', value };
  }

  /**
   * Read a keyring-backed credential.
   * @param identity - Canonical CODEX_HOME identity.
   * @returns Opaque keyring credential, or `null` when absent.
   */
  private async readKeyringCredential(
    identity: CodexAuthHomeIdentity,
  ): Promise<{ backend: 'keyring'; value: string } | null> {
    try {
      const value = await this.keyring.read(CODEX_AUTH_KEYRING_SERVICE, identity.keyringAccount);
      return value === null ? null : { backend: 'keyring', value };
    } catch (error) {
      throw sanitizedNativeAuthError('keyring read', error);
    }
  }

  /**
   * Write a keyring-backed credential.
   * @param identity - Canonical CODEX_HOME identity.
   * @param value - Opaque credential payload.
   */
  private async writeKeyring(identity: CodexAuthHomeIdentity, value: string): Promise<void> {
    try {
      await this.keyring.write(CODEX_AUTH_KEYRING_SERVICE, identity.keyringAccount, value);
    } catch (error) {
      throw sanitizedNativeAuthError('keyring write', error);
    }
  }
}

/**
 * Read a text file with ENOENT represented as `null`.
 * @param filePath - File path to read.
 * @param operation - Sanitized operation label for failures.
 * @returns File contents, or `null` when absent.
 */
async function readTextIfPresent(filePath: string, operation: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw sanitizedNativeAuthError(operation, error);
  }
}

/**
 * Write one private file via create/write/sync/rename.
 * @param filePath - Destination path.
 * @param value - File contents.
 */
async function writePrivateFileAtomically(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  let operationError: unknown;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(value, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    operationError = sanitizedNativeAuthError('private file write', error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      operationError = mergeNativeAuthErrors(
        operationError,
        sanitizedNativeAuthError('private file close', error),
        'Codex native-auth private file write and close both failed',
      );
    }
  }
  try {
    await fs.rm(temporaryPath, { force: true });
  } catch (error) {
    operationError = mergeNativeAuthErrors(
      operationError,
      sanitizedNativeAuthError('private temporary file cleanup', error),
      'Codex native-auth private file operation and cleanup both failed',
    );
  }
  if (operationError !== undefined) throw operationError;
}

/**
 * Remove a file without exposing filesystem details or contents.
 * @param filePath - File path to remove.
 * @param operation - Sanitized operation label for failures.
 */
async function removeFileIfPresent(filePath: string, operation: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    throw sanitizedNativeAuthError(operation, error);
  }
}
