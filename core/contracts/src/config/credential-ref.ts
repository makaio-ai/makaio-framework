import { z } from 'zod';

/**
 * Credential reference resolved at runtime by the active credential provider.
 *
 * Supported formats:
 * - `keychain:<service>:<account>` - OS-backed secure store
 * - `env:<VAR_NAME>` - Environment variable
 * - `file:<path>` - File path
 * - `stored:providerConfig:<configId>:<key>` - ConfigId-keyed credential store
 *   (resolved via `CredentialSubjects.get({ configId })`)
 */
const ENV_REF_PREFIX = 'env:';
const FILE_REF_PREFIX = 'file:';
const KEYCHAIN_REF_PREFIX = 'keychain:';
const STORED_REF_PREFIX = 'stored:providerConfig:';

/**
 * Parse a stored provider-config credential ref without branding the input.
 * @param ref - Raw credential ref string
 * @returns Parsed stored-ref parts, or `null` when the value is not a valid stored ref
 */
function parseStoredCredentialRefParts(ref: string): { configId: string; key: string } | null {
  if (!ref.startsWith(STORED_REF_PREFIX)) {
    return null;
  }

  const tail = ref.slice(STORED_REF_PREFIX.length);
  const colonIndex = tail.lastIndexOf(':');
  if (colonIndex === -1) {
    return null;
  }

  const configId = tail.slice(0, colonIndex);
  const key = tail.slice(colonIndex + 1);
  if (!configId || !key || key.includes(':')) {
    return null;
  }

  return { configId, key };
}

/**
 * Validate refs whose tail is `left:right`, where the right side may contain colons.
 * @param ref - Raw credential ref string
 * @param prefix - Prefix to validate against
 * @returns `true` when the ref has a non-empty value on both sides of the first separator
 */
function isDelimitedCredentialRef(ref: string, prefix: string): boolean {
  if (!ref.startsWith(prefix)) {
    return false;
  }

  const tail = ref.slice(prefix.length);
  const separatorIndex = tail.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= tail.length - 1) {
    return false;
  }

  return true;
}

/**
 * Check whether a string matches one of the supported credential-ref formats.
 * @param ref - Raw credential ref string
 * @returns `true` when the value is a supported credential ref
 */
function isCredentialRefString(ref: string): boolean {
  if (parseStoredCredentialRefParts(ref)) {
    return true;
  }

  if (ref.startsWith(ENV_REF_PREFIX)) {
    const variableName = ref.slice(ENV_REF_PREFIX.length);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName);
  }

  if (ref.startsWith(FILE_REF_PREFIX)) {
    return ref.length > FILE_REF_PREFIX.length;
  }

  if (isDelimitedCredentialRef(ref, KEYCHAIN_REF_PREFIX)) {
    return true;
  }

  return false;
}

export const CredentialRefSchema = z
  .string()
  .refine(isCredentialRefString, { message: 'Invalid credential reference format.' })
  .brand<'CredentialRef'>();
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/**
 * Build a stored credential reference keyed by provider config ID.
 *
 * The format is `stored:providerConfig:<configId>:<key>`. The last colon in the
 * string acts as the configId/key separator, so `configId` may contain colons
 * (e.g. `github:oauth-default`) but `key` must be a colon-free identifier.
 * @param configId - Provider config ID; may contain colons (e.g. `github:oauth-default`)
 * @param key - Credential key — must not contain colons (e.g. `apiKey`, `pat`)
 * @returns Stored credential reference string
 */
export function buildStoredCredentialRef(configId: string, key: string): CredentialRef {
  if (key.includes(':')) {
    throw new Error(`Credential key must not contain colons: "${key}"`);
  }
  return CredentialRefSchema.parse(`${STORED_REF_PREFIX}${configId}:${key}`);
}

/**
 * Parse a stored credential reference into its parts.
 * @param ref - Credential reference string
 * @returns Parsed parts, or `null` when the ref is not a stored credential ref
 */
export function parseStoredCredentialRef(ref: CredentialRef): { configId: string; key: string } | null {
  return parseStoredCredentialRefParts(ref);
}
