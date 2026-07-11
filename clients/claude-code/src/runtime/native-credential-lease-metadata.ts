import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { writeTextAtomically } from './native-credential-file-store.js';

/** Session-local metadata filename used for detached native credentials. */
const CLAUDE_CODE_NATIVE_AUTH_LEASE_FILENAME = '.makaio-native-auth-lease.json';

/** SHA-256 digest stored as a non-secret credential generation marker. */
const CredentialDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Keychain account syntax used by Claude Code itself. */
const KeychainAccountSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/);

/**
 * Versioned, non-secret description of one detached native-auth clone.
 * Credential values never enter this file.
 */
const ClaudeCodeNativeAuthLeaseMetadataSchema = z.discriminatedUnion('backend', [
  z
    .object({
      version: z.literal(1),
      backend: z.literal('keychain'),
      source: z
        .object({
          service: z.string().min(1),
          account: KeychainAccountSchema,
          configDir: z.string().min(1),
          identity: z.enum(['global', 'scoped']),
          generation: CredentialDigestSchema,
        })
        .strict(),
      target: z
        .object({
          service: z.string().min(1),
          account: KeychainAccountSchema,
          configDir: z.string().min(1),
          initialDigest: CredentialDigestSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      backend: z.literal('filesystem-copy'),
      source: z
        .object({
          credentialPath: z.string().min(1),
          generation: CredentialDigestSchema,
        })
        .strict(),
      target: z
        .object({
          credentialPath: z.string().min(1),
          initialDigest: CredentialDigestSchema,
        })
        .strict(),
    })
    .strict(),
]);

/** Strictly validated native credential lease metadata. */
export type ClaudeCodeNativeAuthLeaseMetadata = z.infer<typeof ClaudeCodeNativeAuthLeaseMetadataSchema>;

/** Result of reading optional native credential lease metadata. */
export type NativeAuthLeaseMetadataReadResult =
  | { status: 'missing' }
  | { status: 'invalid' | 'unreadable' }
  | { status: 'valid'; metadata: ClaudeCodeNativeAuthLeaseMetadata };

/**
 * Resolve the metadata path inside a session config directory.
 * @param sessionDir - Session-scoped client config directory.
 * @returns Absolute lease metadata path.
 */
function resolveMetadataPath(sessionDir: string): string {
  return path.join(sessionDir, CLAUDE_CODE_NATIVE_AUTH_LEASE_FILENAME);
}

/**
 * Persist non-secret, versioned native-auth lease metadata.
 * @param sessionDir - Session-scoped client config directory.
 * @param metadata - Strictly shaped lease generation and identity data.
 */
export async function writeCredentialLeaseMetadata(
  sessionDir: string,
  metadata: ClaudeCodeNativeAuthLeaseMetadata,
): Promise<void> {
  await writeTextAtomically(resolveMetadataPath(sessionDir), JSON.stringify(metadata));
}

/**
 * Read and strictly validate native-auth lease metadata.
 * @param sessionDir - Session-scoped client config directory.
 * @returns Missing, invalid, unreadable, or parsed metadata state.
 */
export async function readCredentialLeaseMetadata(sessionDir: string): Promise<NativeAuthLeaseMetadataReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(resolveMetadataPath(sessionDir), 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const result = ClaudeCodeNativeAuthLeaseMetadataSchema.safeParse(parsed);
    return result.success ? { status: 'valid', metadata: result.data } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * Remove native-auth lease metadata if present.
 * @param sessionDir - Session-scoped client config directory.
 */
export async function removeCredentialLeaseMetadata(sessionDir: string): Promise<void> {
  await fs.rm(resolveMetadataPath(sessionDir), { force: true });
}

/**
 * Check that Keychain identities describe this exact session clone.
 * @param metadata - Parsed Keychain lease metadata.
 * @param sessionDir - Session config directory being released.
 * @returns Whether source and target form Claude Code's expected clone pair.
 */
export function isKeychainCredentialLeaseForSession(
  metadata: Extract<ClaudeCodeNativeAuthLeaseMetadata, { backend: 'keychain' }>,
  sessionDir: string,
): boolean {
  const serviceMatch = /^(Claude Code(?:-custom-oauth)?-credentials)(?:-([0-9a-f]{8}))?$/.exec(metadata.source.service);
  if (serviceMatch === null) return false;
  const [, serviceBase, sourceServiceHash] = serviceMatch;
  if (!path.isAbsolute(metadata.source.configDir) || !path.isAbsolute(metadata.target.configDir)) return false;
  if (path.resolve(metadata.target.configDir) !== path.resolve(sessionDir)) return false;
  if (path.resolve(metadata.source.configDir) === path.resolve(sessionDir)) return false;

  const sourceConfigHash = createHash('sha256')
    .update(metadata.source.configDir.normalize('NFC'))
    .digest('hex')
    .substring(0, 8);
  const sourceIdentityMatches =
    metadata.source.identity === 'global' ? sourceServiceHash === undefined : sourceServiceHash === sourceConfigHash;
  if (!sourceIdentityMatches) return false;

  const targetHash = createHash('sha256')
    .update(metadata.target.configDir.normalize('NFC'))
    .digest('hex')
    .substring(0, 8);
  return (
    metadata.target.service === `${serviceBase}-${targetHash}` && metadata.target.account === metadata.source.account
  );
}

/**
 * Check that filesystem identities describe this session credential copy.
 * @param metadata - Parsed filesystem-copy lease metadata.
 * @param sessionDir - Session config directory being released.
 * @returns Whether the detached target belongs to this session.
 */
export function isFilesystemCredentialLeaseForSession(
  metadata: Extract<ClaudeCodeNativeAuthLeaseMetadata, { backend: 'filesystem-copy' }>,
  sessionDir: string,
): boolean {
  const expectedTarget = path.resolve(sessionDir, '.credentials.json');
  const resolvedSource = path.resolve(metadata.source.credentialPath);
  const sourceRelativeToSession = path.relative(path.resolve(sessionDir), resolvedSource);
  return (
    path.isAbsolute(metadata.source.credentialPath) &&
    path.isAbsolute(metadata.target.credentialPath) &&
    path.basename(resolvedSource) === '.credentials.json' &&
    path.resolve(metadata.target.credentialPath) === expectedTarget &&
    resolvedSource !== expectedTarget &&
    (sourceRelativeToSession.startsWith('..') || path.isAbsolute(sourceRelativeToSession))
  );
}
