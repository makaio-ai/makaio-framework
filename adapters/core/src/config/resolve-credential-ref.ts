import fs from 'node:fs/promises';
import type { CredentialRef } from '@makaio/contracts/config';

const ENV_PREFIX = 'env:';
const FILE_PREFIX = 'file:';
const KEYCHAIN_PREFIX = 'keychain:';

/**
 * Dependency overrides for credential resolution.
 */
export interface ResolveCredentialRefDeps {
  /** Read a file path for file: refs. */
  readFile?: (path: string) => Promise<string>;
  /** Read an environment variable for env: refs. */
  readEnv?: (name: string) => string | undefined;
  /** Resolve keychain credentials for keychain: refs. */
  resolveKeychain?: (service: string, account: string) => Promise<string | null>;
}

/**
 * Resolve a credential reference to its runtime value.
 *
 * Supported formats:
 * - env:VAR_NAME
 * - file:/path/to/secret
 * - keychain:service:account (requires resolveKeychain)
 * @param ref - Credential reference string
 * @param deps - Optional dependency overrides for resolution
 * @returns Resolved credential value or null if not found
 */
export async function resolveCredentialRef(
  ref: CredentialRef,
  deps: ResolveCredentialRefDeps = {},
): Promise<string | null> {
  if (ref.startsWith(ENV_PREFIX)) {
    const name = ref.slice(ENV_PREFIX.length);
    if (!name) {
      throw new Error('Credential reference is missing environment variable name');
    }
    const readEnv = deps.readEnv ?? ((key) => process.env[key]);
    // Use || (not ??) so empty strings resolve to null — prevents silent
    // fallback failures when an env var is set but blank (e.g. Gemini OAuth).
    return readEnv(name) || null;
  }

  if (ref.startsWith(FILE_PREFIX)) {
    const path = ref.slice(FILE_PREFIX.length);
    if (!path) {
      throw new Error('Credential reference is missing file path');
    }
    const readFile =
      deps.readFile ??
      (async (filePath) => {
        const data = await fs.readFile(filePath, 'utf-8');
        return data;
      });
    const contents = await readFile(path);
    return contents.trim() || null;
  }

  if (ref.startsWith(KEYCHAIN_PREFIX)) {
    const tail = ref.slice(KEYCHAIN_PREFIX.length);
    const [service, ...accountParts] = tail.split(':');
    if (!service || accountParts.length === 0) {
      throw new Error('Credential reference is missing keychain service or account');
    }
    if (!deps.resolveKeychain) {
      throw new Error('Keychain credential resolution is not configured');
    }
    return deps.resolveKeychain(service, accountParts.join(':'));
  }

  // Fall back to treating the ref as a raw token.
  return ref || null;
}
